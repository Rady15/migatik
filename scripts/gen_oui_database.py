#!/usr/bin/env python3
"""Generate a compact OUI database JSON from the official IEEE oui.txt.

Source: https://standards-oui.ieee.org/oui/oui.txt
Output: /home/z/my-project/src/lib/discovery/oui-database.json
Format: { "001A11": "Google, Inc.", ... }  (uppercase hex prefix -> organization name)

This is the REAL IEEE registry data — used by the Device Intelligence Engine to map
MAC address prefixes to manufacturer organizations. It identifies the organization
only, never the exact device model or OS.
"""
import json
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/oui.txt"
OUT = "/home/z/my-project/src/lib/discovery/oui-database.json"

# e.g. "286FB9     (base 16)            Nokia Shanghai Bell Co., Ltd."  (current IEEE format)
# legacy format "     00 00 0C     (base 16)  Cisco Systems, Inc" also accepted
LINE_RE = re.compile(
    r"^\s*([0-9A-Fa-f]{6})\s+\(base 16\)\s+(.+?)\s*$"
)

oui: dict[str, str] = {}
skipped = 0
with open(SRC, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        m = LINE_RE.match(line)
        if not m:
            continue
        prefix = m.group(1).upper()
        org = m.group(2).strip()
        if not org or len(prefix) != 6:
            skipped += 1
            continue
        if prefix not in oui:
            oui[prefix] = org

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(oui, f, ensure_ascii=False, separators=(",", ":"))

print(f"Wrote {len(oui)} OUI entries to {OUT} (skipped {skipped} malformed lines)")
