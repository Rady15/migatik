# API Documentation — Network Device Discovery (v2)

Base URL: `/api` · All endpoints require an authenticated session cookie
(`401` otherwise). All data is scoped per router record; RouterOS credentials
are AES-256-GCM encrypted at rest and never leave the server.

## Discovery / Synchronization

### `GET /api/discovery`
Recent discovery jobs + per-router sync health.

**Response**
```json
{
  "jobs": [{
    "id": "...", "router": "Core Router", "routerId": "...",
    "type": "scheduled|manual", "trigger": "scheduler|user",
    "status": "success|partial|failed|running",
    "sourcesDone": ["dhcp_leases","arp","bridge_hosts","wireless","hotspot_active","ppp_active","interfaces", "..."],
    "sourcesFailed": [],
    "stats": { "dhcp_leases": 42, "arp": 55, "devices": 48, "newDevices": 1 },
    "durationMs": 3210, "startedAt": "...", "finishedAt": "..."
  }],
  "routers": [{ "id": "...", "name": "...", "status": "online|offline|untested",
                "syncEnabled": true, "syncIntervalSec": 60, "lastSyncAt": "...",
                "lastSyncOk": true, "lastSyncError": null, "nextSyncAt": "...", "syncFailCount": 0 }]
}
```

**Query params:** `?routerId=<id|all>` · `?jobId=<id>` returns the job's logs
(`{ logs: [{ level, source, message, ts }] }`).

### `POST /api/discovery`
Trigger a real synchronization cycle now.
```json
{ "routerId": "all" }          // or a specific router id
```
→ `{ "results": [{ "ok": true, "jobId": "...", "stats": {...} }] }`

A sync performs ONE authenticated RouterOS connection per router and reads:
`/ip/dhcp-server/lease/print`, `/ip/dhcp-server/print`, `/ip/dhcp-server/network/print`,
`/ip/arp/print`, `/interface/bridge/host/print`, `/interface/bridge/print`,
`/interface/wireless/registration-table/print`, `/interface/wifi/registration-table/print`,
`/caps-man/registration-table/print`, `/caps-man/remote-cap/print`,
`/ip/hotspot/active/print`, `/ip/hotspot/host/print`, `/ppp/active/print`,
`/ppp/secret/print`, `/ppp/profile/print`, `/interface/print`, `/ip/address/print`,
`/ip/neighbor/print`, `/ip/route/print`, `/ip/firewall/connection/print`,
`/ip/firewall/address-list/print`, `/interface/monitor-traffic (once)`,
`/system/resource/print`, `/system/identity/print`.
Menus that do not exist on the target RouterOS version are recorded as
**unsupported** (never as failures).

### `GET /api/discovery/settings` / `PUT /api/discovery/settings`
Detection policies:
```json
{ "discovery_grace_min": 5,
  "discovery_notify_new": true,
  "discovery_notify_offline": false,
  "discovery_interface_traffic": true,
  "routerIntervals": { "<routerId>": 60 } }
```

## Devices

### `GET /api/devices`
Unified device inventory (correlation key: router + MAC).

**Query params**
| param | values |
|---|---|
| `routerId` | id or `all` |
| `search` | MAC / IP / hostname / custom name / manufacturer |
| `status` | `online` `offline` `idle` `unknown` `blocked` `recently_disconnected` |
| `connectionType` | `wired` `wireless` `hotspot` `pppoe` |
| `source` | `dhcp` `arp` `bridge` `wireless` `wifi` `capsman` `hotspot` `pppoe` |
| `interface`, `ap`, `vlan`, `trust`, `isNew` | filters |
| `page`, `pageSize`, `sort`, `dir` | pagination/sorting |
| `stats=1` | return KPI + chart aggregates instead of rows |
| `format=csv` / `format=xls` | export (Excel-compatible) |

**Row shape:** `{ id, mac, ip, hostname, customName, manufacturer (OUI org), category,
os (only if self-reported via LLDP/MNDP), connectionType, interface, vlan, ap,
status, trustStatus, sources[], isNew, firstSeen, lastSeen, lastActive, comment, router }`

**`stats=1` response:** `{ kpi: { total, online, offline, idle, unknown, blocked,
wireless, wired, hotspot, pppoe, newDevices, blockedDevices }, onlineOverTime[],
byRouter[], byVlan[], byAp[], byType[], byManufacturer[], newPerDay[], routers[] }`

### `GET /api/devices/:id`
Full device profile: `device`, `evidence` (exact DHCP/ARP/bridge/wireless/PPP rows
last reported by the router), `events` (first_seen / online / offline / ip_change /
interface_change / ap_change / blocked / unblocked / renamed ...), `ipHistory`,
`blockRules`, `observations`, `usage.daily`, `usage.recentSamples`, `sessions`.

### `POST /api/devices/:id/actions`
Device control. Destructive operations require **preview → explicit confirm**.

| action | body | confirm required |
|---|---|---|
| `block_preview` | `{ method }` | no (returns preview) |
| `block` | `{ method: firewall_forward_drop \| hotspot_disable \| wireless_acl }` | **yes** |
| `unblock` | — | no |
| `reserve_ip` | — | no |
| `rename` | `{ name }` | no |
| `comment` | `{ comment }` | no |
| `trust` / `mark_suspicious` | — | no |
| `categorize` | `{ category }` | no |
| `disconnect_hotspot` | — | **yes** |
| `ping` | — | no (3× ICMP from the router) |

`block_preview` response: `{ preview: { explanation, commands[], warnings[] } }`.
Blocking uses **chain=forward only** (never `input`) so an administrator's
management session can never be locked out. Every action is written to
`DeviceBlockRule` + `ActivityLog`.

### `GET /api/devices/:id/live?minutes=15`
Live traffic: `samples[]` (rxMbps/txMbps + honest `source`:
`session` = real hotspot byte deltas, `interface` = real per-interface monitor or
exclusive-interface attribution, `inferred`), `daily[]`, `monthly[]`, `topConsumers[]`.

## Network Sources

### `GET /api/network?source=<source>&routerId=<id|all>&search=`
Serves the locally synced RouterOS tables (no per-view router load):

`dhcp_leases` · `arp` · `bridge_hosts` · `wireless` · `hotspot_active` ·
`ppp_active` · `interfaces` · `addresses` · `dhcp_servers` · `dhcp_networks` ·
`neighbors` · `routes` · `firewall_connections` · `address_lists` · `discovery_status`

Each row carries its own `syncTime`. DHCP lease rows preserve RouterOS states
exactly (`bound` / `waiting` / `offered` / `declined` / `expired`) plus
`dynamic`, `blocked`, `disabled`, `expiresAt`, `pool`, `clientId`, `comment`.

### `POST /api/network/action`
Real RouterOS operations:
`lease_make_static` · `lease_add_static` (`mac`,`ip`,`server?`,`comment?`) ·
`lease_remove` (**confirm**) · `lease_disable` / `lease_enable` ·
`hotspot_disconnect` (**confirm**) · `ppp_disconnect` (**confirm**).

## Topology

### `GET /api/network/topology?routerId=<id>`
```json
{ "routers": [{ "routerId": "...", "networkName": "identity (host)",
  "nodes": [{ "id": "router:...|bridge:...|ap:...|port:...|device:...", "type": "...",
              "label": "...", "ip": "...", "cpu": 3, "mem": 41, "uptime": "...",
              "status": "online", "counts": { "ok": 4, "warn": 3, "err": 1 }, "vlan": 20 }],
  "edges": [{ "from": "...", "to": "...", "kind": "wan|bridge|port|wireless|device",
              "bandwidthMbps": 68.2, "inferred": false, "label": "VLAN 20" }],
  "lastSyncAt": "...", "lastSyncOk": true, "unreachable": false }],
  "generatedAt": "..." }
```
`inferred: true` marks links the system could not confirm from RouterOS data —
the UI renders them dashed and labeled.

## Realtime (socket.io — port 3003 via gateway)

```js
const socket = io("/?XTransformPort=3003", { path: "/" });
socket.on("devices:update", rows => {});   // changed device rows
socket.on("stats:update", kpi => {});      // counters (~5s)
socket.on("traffic:sample", ({ deviceId, samples }) => {}); // join via subscribe:traffic
socket.on("sync:status", jobs => {});
```
The UI automatically falls back to HTTP polling if the socket service is
unreachable; a badge in the header shows the active mode.

## Background engine

- Scheduler tick every 10 s, per-router interval (default 60 s, min 15 s).
- Adaptive backoff on unreachable routers: ×2^n capped at 15 min; resets on success.
- Retention: traffic samples 48 h, observations + KPI snapshots 30 d, raw source rows 7 d.
- New-device notifications respect `discovery_notify_new`.
