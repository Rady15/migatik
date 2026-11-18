# Real RouterOS Integration Report

- Generated: **2026-11-16 08:04:58**
- Target: `192.168.1.3:8728` — user `admin` (password never recorded)
- Connection: **FAILED — انتهت مهلة الاتصال بالسيرفر (timeout)**
- Router identity: **(unknown)** · RouterOS **?**

> Verdict rule: nothing is reported as verified unless the router actually answered. "unsupported" = this RouterOS version does not have the feature (valid result).

## Per-source matrix

| # | Source | Status | Command | Parsed records | Duration | Error |
|---|--------|--------|---------|----------------:|----------|-------|
| 1 | Router identity | NO-CONNECTION | `/system/identity/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 2 | CPU / memory / uptime / version | NO-CONNECTION | `/system/resource/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 3 | Board health (voltage/temp — when present) | NO-CONNECTION | `/system/health/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 4 | DHCP leases | NO-CONNECTION | `/ip/dhcp-server/lease/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 5 | DHCP servers | NO-CONNECTION | `/ip/dhcp-server/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 6 | DHCP networks | NO-CONNECTION | `/ip/dhcp-server/network/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 7 | ARP table | NO-CONNECTION | `/ip/arp/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 8 | Bridge hosts (L2 evidence + VLAN) | NO-CONNECTION | `/interface/bridge/host/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 9 | Bridges | NO-CONNECTION | `/interface/bridge/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 10 | VLAN interfaces | NO-CONNECTION | `/interface/vlan/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 11 | Wireless registration (legacy package) | NO-CONNECTION | `/interface/wireless/registration-table/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 12 | WiFi registration (v7 wifi package) | NO-CONNECTION | `/interface/wifi/registration-table/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 13 | CAPsMAN registration | NO-CONNECTION | `/caps-man/registration-table/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 14 | CAPsMAN remote CAPs | NO-CONNECTION | `/caps-man/remote-cap/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 15 | Hotspot active sessions | NO-CONNECTION | `/ip/hotspot/active/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 16 | Hotspot hosts | NO-CONNECTION | `/ip/hotspot/host/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 17 | Hotspot users (vouchers) | NO-CONNECTION | `/ip/hotspot/user/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 18 | PPPoE active sessions | NO-CONNECTION | `/ppp/active/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 19 | PPP secrets | NO-CONNECTION | `/ppp/secret/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 20 | PPP profiles | NO-CONNECTION | `/ppp/profile/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 21 | Interfaces | NO-CONNECTION | `/interface/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 22 | IP addresses | NO-CONNECTION | `/ip/address/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 23 | IP pools | NO-CONNECTION | `/ip/pool/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 24 | Neighbor discovery (LLDP/MNDP) | NO-CONNECTION | `/ip/neighbor/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 25 | Routing table | NO-CONNECTION | `/ip/route/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 26 | DNS settings | NO-CONNECTION | `/ip/dns/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 27 | Firewall connections | NO-CONNECTION | `/ip/firewall/connection/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 28 | Firewall filter rules | NO-CONNECTION | `/ip/firewall/filter/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 29 | Firewall NAT rules | NO-CONNECTION | `/ip/firewall/nat/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 30 | Firewall address-lists | NO-CONNECTION | `/ip/firewall/address-list/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 31 | Simple queues | NO-CONNECTION | `/queue/simple/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 32 | Queue trees | NO-CONNECTION | `/queue/tree/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 33 | IP services (management exposure) | NO-CONNECTION | `/ip/service/print` | 0 | 0ms | SKIPPED — router unreachable (connection failed). No data can be reported honestly. |
| 34 | Live per-interface traffic (monitor-traffic 1s) | NO-CONNECTION | `/interface/monitor-traffic once` | 0 | 0ms | SKIPPED — router unreachable |

## Engine scenarios

| ID | Requirement | Status | Detail |
|----|-------------|--------|--------|
| S01 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S02 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S03 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S04 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S05 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S06 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S07 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S08 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S09 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S10 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S11 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S12 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S13 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S14 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S15 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S16 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S17 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S18 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |
| S19 | (engine scenario) | PENDING | router unreachable — cannot be verified from here |

## Totals

- Sources: **0 pass** · 0 unsupported · 0 fail · 34 no-connection
- Scenarios: 0 pass · 0 fail · 0 skip