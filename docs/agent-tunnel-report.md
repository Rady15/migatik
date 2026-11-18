# Agent tunnel E2E (sandbox) — 2026-11-16T11:10:23.707Z

| Check | Result | Detail |
|---|---|---|
| agent outbound connect + heartbeat | PASS | real agent.js process authenticated via token and went online |
| agent has NO listening ports (NAT/CGNAT-safe) | PASS | ss -tlnp shows no LISTEN socket for the agent pid |
| two routers assigned to one agent | PASS | routers cmwj5wlhm0002s1pkbjsizjhu / cmwj5wlho0004s1pkpi6lyekc → agentId cmwj5wl3d0000s1pkg5dt0uk2 |
| platform RouterOS client through agent tunnel (router 1) | PASS | identity=MT-SIM-LAN version=7.14-sim |
| second router through the same agent tunnel | PASS | identity=MT-SIM-LAN |
| DHCP lease read through agent tunnel | PASS | leases=1 |
| hotspot HTTP login test through agent | PASS | verdict=login-accepted status=302 loc=/status |
| active hotspot session verified via API (through tunnel) | PASS | session for testuser1 present in /ip/hotspot/active |
| unreachable router reports honest failure | PASS | error returned: تم رفض الاتصال — تأكد من تفعيل خدمة API على السيرفر ومن المنفذ |

Scope note: steps 6-10 use a **RouterOS protocol simulator (test harness)** — plumbing proof only, not a router. Real-router acceptance runs on-site.