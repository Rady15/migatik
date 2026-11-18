/**
 * IEEE OUI manufacturer lookup — REAL registry data (40,497 entries) generated
 * from https://standards-oui.ieee.org/oui/oui.txt via scripts/gen_oui_database.py.
 *
 * HONESTY RULE: the OUI identifies the manufacturing ORGANIZATION only.
 * It never proves the exact device model or operating system — we never guess those.
 * Load is lazy so client bundles never include the 1.4MB dataset.
 */

import fs from "node:fs";
import path from "node:path";

let cache: Record<string, string> | null = null;

function loadDb(): Record<string, string> {
  if (cache) return cache;
  try {
    const file = path.join(process.cwd(), "src/lib/discovery/oui-database.json");
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    cache = {};
  }
  return cache;
}

export interface OuiInfo {
  manufacturer: string | null;
  prefix: string | null;
  known: boolean;
}

export function lookupManufacturer(mac: string | null | undefined): OuiInfo {
  const hex = (mac ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length < 6) return { manufacturer: null, prefix: null, known: false };
  const prefix = hex.slice(0, 6);
  const db = loadDb();
  const org = db[prefix] ?? null;
  return { manufacturer: org, prefix, known: !!org };
}

export function ouiEntryCount(): number {
  return Object.keys(loadDb()).length;
}
