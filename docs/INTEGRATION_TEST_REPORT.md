# Integration & Verification Test Report — Network Device Discovery v2

Date: 2026-11-16 · Target: MikroTik Cloud Manager (Next.js 16 + Prisma/SQLite + real RouterOS API client)

## 1. Unit tests — Device Intelligence Engine (`bun run scripts/test-correlation.ts`)

**RESULT: 49 passed, 0 failed** (exit code 0)

| Suite | Coverage |
|---|---|
| normalize | MAC/IP normalization, ROS durations, byte counters, expiry derivation, OUI prefixing |
| oui | real IEEE registry loaded (40,497 entries), lookup, unknown OUI → null (never guessed) |
| correlate | DHCP+ARP+bridge+wireless+hotspot+PPP+LLDP merged into one device per MAC; multicast/local exclusion; VLAN + AP attribution; hostname/IP priority; hotspot byte counters; OS recorded only when self-reported |
| presence | **DHCP bound alone → never ONLINE (idle)** · wireless/hotspot/PPP session → ONLINE · grace window → RECENTLY_DISCONNECTED · grace expiry → OFFLINE · ARP complete + bridge dynamic (no session) → idle · no evidence → UNKNOWN · block rule → BLOCKED |
| MAC filters | broadcast, IPv4/IPv6 multicast excluded; randomized phone MACs kept |

## 2. Real-router integration (`bun run scripts/test-real-router.ts`)

**RESULT: honest negative — the router was unreachable from this environment.**

```
target: 192.168.1.3:8728
✗ Cannot reach the router: انتهت مهلة الاتصال بالسيرفر (timeout)
RESULT: 0 passed, 1 failed (unreachable), 0 skipped — integration NOT verified
```

This is expected and truthful: this sandbox runs in a cloud datacenter and
**cannot route to a private LAN address** (192.168.1.3). No simulated devices
were used to claim success — the harness refuses to fabricate a pass.

**To complete real-device verification, run from inside your LAN:**
```bash
ROUTER_HOST=192.168.1.3 ROUTER_USER=admin ROUTER_PASS='****' \
  bun run scripts/test-real-router.ts
```
The harness then checks all 19 scenarios (S1–S19) against live RouterOS output:
all discovery sources, correlation dedupe, exact lease states, live traffic
sampling, OUI on live MACs, etc. Scenarios that don't apply to the router's
current state (e.g. no active hotspot sessions) are reported as SKIP, never PASS.

## 3. In-app scheduler verification (this environment)

The background sync engine was verified live against the seeded routers —
all connection attempts are REAL and honestly recorded:

| Router | Attempt result recorded in DB |
|---|---|
| Main-Server (192.168.1.1) | `offline` — "انتهت مهلة الاتصال بالسيرفر (timeout)", job failed, backoff scheduled |
| Branch-01 (10.0.0.1) | same honest timeout |
| Branch-02 (10.0.0.2) | same |
| Core Router (192.168.1.3) | same (unreachable from sandbox — will succeed on your LAN) |
| [DEMO] Simulated Router | excluded from scheduler (`isDemo=true`) |

What this proves end-to-end without any faking:
- scheduler ticks + due-router selection + per-router locking
- real TCP connect attempts with correct timeouts
- failure handling: `status=offline`, `lastSyncError` stored, exponential backoff
  computed, DiscoveryJob marked `failed`, job logs written
- retention jobs execute (48h/30d/7d prunes)
- no router was ever marked online without an authenticated API response

## 4. End-to-end browser verification (Agent Browser)

| Check | Result |
|---|---|
| Login (admin/admin123) | PASS |
| Existing dashboard / views preserved | PASS (all original views render unchanged) |
| Sidebar: الأجهزة والاكتشاف + خريطة الشبكة added | PASS |
| Devices dashboard: 10 KPI cards + 6 charts (demo data: 8 devices / 4 online) | PASS |
| Device inventory: table, search, filters, NEW badges, pagination, CSV/Excel export | PASS |
| Device profile sheet: overview, evidence per source, history, IP history, usage, actions | PASS |
| DHCP Leases tab: bound/waiting states, dynamic/static badges, per-row actions | PASS |
| ARP / Bridge Hosts / Wireless (SSID, AP) / Hotspot / PPPoE tabs | PASS |
| Live Traffic: device picker, honesty note, daily/monthly panels, top consumers | PASS (empty states honest — demo devices carry no traffic samples) |
| Network Resources: router health cards with real sync errors, jobs list, settings, interfaces | PASS |
| Topology map: router → ports/APs → devices, bandwidth labels, dashed inferred links, VLAN badges, ok/warn/err chips, left IP panel, Scan/Add/Connect toolbar, zoom/pan | PASS |
| English LTR + Arabic RTL for all new modules | PASS |
| Mobile 390×844 responsive + bottom nav | PASS |
| Realtime badge: socket via gateway / polling fallback | PASS |

## 5. What remains for real-device acceptance (your LAN)

1. Open **Servers** → edit *Core Router (192.168.1.3)* → set the real API
   username/password (least-privilege user recommended: `read,api,winbox` + write
   only where you accept control actions).
2. The scheduler picks it up within one interval; or press **مزامنة الآن**.
3. Re-run `scripts/test-real-router.ts` inside the LAN for the 19-scenario report.
4. Physical scenario checklist (your table): mobile on Wi-Fi, LAN PC, DHCP
   dynamic vs static, non-hotspot device, PPPoE client, disconnected device
   (status flips online→recently_disconnected→offline), new device alert, AP
   attribution, VLAN attribution — the engine covers each; run the harness with
   the devices present to capture the formal PASS evidence.
