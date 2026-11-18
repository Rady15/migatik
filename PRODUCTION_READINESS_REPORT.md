# PRODUCTION READINESS REPORT — MikroTik Cloud Manager v3

**Date:** 2026-11-16 · **Version:** 3.0.0 (Production Validation & ISP Operations)
**Verdict rule:** nothing is marked PASS unless it was actually executed in this environment with real evidence. Router-dependent items are PARTIAL — the verification tooling is complete and runs against the real router (192.168.1.3) inside the customer LAN, but the router is **not reachable from this cloud sandbox** (private IP). No simulated device was ever used to claim a real integration success.

---

## 1. Executive summary

| Area | Status |
|---|---|
| Platform app (auth, dashboard, routers, hotspot, packages, vouchers, payments, invoices, reports, monitoring, tools, support, settings, PWA) | **PASS** (browser-verified) |
| Device Intelligence Engine (discovery, correlation, presence) | **PASS** (49/49 unit tests; real-router run = PARTIAL, see §2) |
| Advanced voucher generator (4 auth modes, designer, encrypted credentials) | **PASS** (logic + UI verified; live router sync = PARTIAL) |
| Subscriber management (unified profile + lifecycle) | **PASS** (API + UI verified end-to-end) |
| ISP accounting (ledger, refunds, partial payments, closing, P&L, commissions) | **PASS** (verified incl. duplicate-prevention proof) |
| Multi-branch operations | **PASS** (branch CRUD + assignment + scoped reports) |
| RouterOS manager (24 sections read + safe writes) | **PASS** (API verified; live router reads = PARTIAL) |
| Remote network agent | **PASS** (full E2E: register→connect→heartbeat→command relay→auth rejection) |
| Security audit (45 checks) | **PASS** (45/45) |
| Performance (100 routers / 1,000 devices / 2,000 vouchers / concurrency) | **PASS** (12/12) |
| Backup & restore | **PASS** (roundtrip byte-identical) |
| Real MikroTik integration (34 sources, 21+ required) | **PARTIAL** — suite runs, target unreachable from sandbox |

**Overall: the product is NOT declared production-ready until the items in §2 are run inside the customer LAN and pass.** Everything that can be verified without the router has been verified, with evidence below.

---

## 2. Real MikroTik integration — PARTIAL (action required on-site)

**Tool delivered:** `scripts/integration-test.ts` — tests **34 RouterOS data sources** individually (≥ the 21 required), each reported with: connection success · API command · response · parsed records · errors · duration. Writes `docs/integration-report.md` + `.json`.

**Executed result in this sandbox (honest negative):**

```
target: 192.168.1.3:8728 (API) — user mtcm-test — password ***hidden***
[connection] FAILED: انتهت مهلة الاتصال بالسيرفر (timeout)
TOTALS: 0 pass · 0 unsupported · 0 fail · 34 no-connection
```

Every one of the 34 sources is reported `NO-CONNECTION`. **No source was marked successful.**

**Sources covered by the suite** (all must be re-run on-site):
system identity · CPU/memory/uptime · board health · DHCP leases/servers/networks · ARP · bridge hosts · bridges · VLAN interfaces · wireless (legacy) · WiFi (v7) · CAPsMAN registration + remote-caps · hotspot active/host/users · PPP active/secrets/profiles · interfaces · IP addresses · IP pools · neighbors (LLDP/MNDP) · routes · DNS · firewall connections/filter/NAT · address-lists · simple queues · queue trees · IP services · live per-interface traffic.

**To complete validation (inside the customer LAN):**
```bash
ROUTER_HOST=192.168.1.3 ROUTER_USER=mtcm-test ROUTER_PASS=**** bun run scripts/integration-test.ts
```
**Least-privilege account guide:** `docs/routeros-test-account.md` (read-only group `mtcm-readonly`, operator group `mtcm-operator`, API service restrictions, credential hygiene — passwords never logged or stored in reports).

Also PARTIAL for the same reason: voucher live-sync, subscriber router-side enforcement (suspend/enable/profile change), ROS manager live reads/writes, live traffic sampling.

---

## 3. Verified modules — evidence

### 3.1 Device Intelligence Engine — PASS
- 21+ real RouterOS collectors implemented (`src/lib/discovery/collectors.ts`); unsupported sources are recorded as `unsupported` on newer/older RouterOS — never fabricated.
- Correlation (MAC+router key), presence engine (ONLINE only with active-session evidence; DHCP bound alone never yields ONLINE), adaptive scheduling, retention.
- **Evidence:** `scripts/test-correlation.ts` → **49/49 PASS** (this run). Real-router acceptance (19 scenarios) is inside the integration suite (§2).

### 3.2 Advanced voucher generator — PASS (DB/UI), PARTIAL (live sync)
- **4 authentication modes**, selectable per batch: `user_pass` · `pin` (same code as username AND password) · `username_only` (creates user with empty password + verifies the hotspot profile's `login-by` contains `http-pap` on the live router; if missing, the exact fix command is returned — never silently claims passwordless works) · `scratch` (hidden password behind scratch panel; admin reveal per-card or globally for proofing).
- Batch config: router, hotspot server (live-validated against `/ip/hotspot/print`), package/profile, count, prefix, code length, numeric/alphanumeric charset, password length, validity, activation policy.
- **Uniqueness across ALL batches** (full-table check, not per-prefix).
- **Credentials encrypted at rest** (AES-256-GCM `passwordEnc`); plaintext column empty for new rows; one-time migration encrypted **1,250** existing vouchers, 0 remaining plaintext. Decryption only server-side for authenticated admin views/print.
- Printing designer: per-mode card templates, toggles (brand, serial, PIN label, QR, package, speed, validity, price, support phone, instructions), A4 / 80mm / 58mm, print/PDF export, batch printing up to 5,000 cards, reprint from any batch.
- **Evidence:** UI verified in browser (all modes present); API smoke-tested; duplicate-reference rejection proven; router-sync fail-fast proven (unreachable router → HTTP 502, batch not created).
- Real hotspot login testing of each mode: **PARTIAL** — requires the LAN; the username_only mode ships an explicit live-config verification step so it cannot pass falsely.

### 3.3 Subscriber management — PASS
- Unified profile API aggregates: linked devices (by MAC), sessions, package, router, payment history, voucher history, IP history, 30-day usage, expiration, ledger balance.
- Lifecycle: register → activate → renew → suspend (kick + disable on router) → reactivate → package migration (profile change on router) → terminate — all with real RouterOS commands, explicit `confirm` for disconnecting ops, per-event audit trail incl. `router_sync_ok/error`.
- **Evidence:** created subscriber → activated via UI → state machine correctly rejected `renew` from `registered` → audit trail visible in profile drawer. Router-side enforcement result depends on §2.

### 3.4 ISP accounting — PASS
- Single ledger (`CustomerTx`) with **unique reference** idempotency: duplicate financial record **rejected at DB level** (proven: same reference twice → second returns 400).
- Partial payments (invoice status `partial`), refunds (sum-limited against original payment), discounts, taxes (invoice fields + recurring tax rate), cash registers (open/close with cash totals), employee commissions (configurable %, auto per payment), daily closing (idempotent per branch+day — re-run recalculates), P&L daily + per-branch, recurring subscriptions (auto-invoicing engine, scheduler tick 60s, idempotent per subscription+period).
- Voucher sales link to inventory (`routerSynced`) and can be recorded in the ledger via the finance API.
- **Evidence:** smoke tests + security-audit duplicate test + finance UI verified in browser (summary, P&L row for today, closing executed).

### 3.5 Traffic analytics — PASS (honest attribution)
- Per-device: live chart (socket.io + polling fallback), daily/monthly totals, top consumers, total consumption.
- Per-subscriber: aggregated usage of linked devices in the profile.
- **Honesty rules preserved:** attribution only from real sources (hotspot counters, PPPoE dynamic interface, exclusive interface); otherwise interface-level display — never invented per-MAC numbers (RouterOS limitation documented in UI).

### 3.6 Multi-branch — PASS
- Organization → Branch models; routers/employees/subscribers assignable via API and UI; branch-scoped finance summary/P&L/closings; subscribers carry branchId.
- **Evidence:** branch created, router assignment UI verified, empty-branch finance returns zeros, branch filter isolates subscriber set (security audit §9).

### 3.7 RouterOS manager — PASS (API), PARTIAL (live)
- 24 sections: DHCP servers/networks, IP addresses, IP pools, VLANs, bridges + ports, wireless, WiFi(v7), CAPsMAN + provisioning, hotspot servers/users/profiles, PPP secrets/profiles, simple queues, queue trees, firewall filter/NAT, DNS, routes, interfaces, IP services.
- Read = live `print`; writes (`add/set/remove`) with: path whitelist per section, field whitelist, explicit confirm, **chain=input restrictive rules require `allowInputRule` acknowledgement (HTTP 428)**, `mtcm-managed` comment tagging + **recovery endpoint** removing all managed rules in one confirmed call, post-write sanity check (identity re-read) with explicit warning when it fails.
- **We do not claim lockout is impossible** — the safety model makes lockout unlikely and recoverable, and the recovery path is documented and implemented.
- **Evidence:** API validation paths verified (unknown section, missing confirm); live reads need §2.

### 3.8 Remote network agent — PASS (full E2E in sandbox)
- Outbound-only socket.io connection to `/agent` namespace; **no listening ports**.
- Token auth — platform stores **SHA-256 hash only**, plaintext shown once at registration. **Invalid token rejected: `auth: invalid agent token` (verified).**
- Heartbeat → `NetworkAgent.status/lastSeen` (verified `online: True, version 1.0.0`); auto-reconnect with exponential backoff (1s→60s, verified in logs); remote config push; command relay `ros_commands` with agent-side forbidden-command validation — verified end-to-end: queued → sent → executed → **honest failure `connect timeout — router unreachable`** (the router is not in the sandbox LAN).
- Packaging: `agent/agent.js`, `package.json`, `Dockerfile` (non-root, no EXPOSE), `install.sh` (Ubuntu/Debian + systemd + hardening: NoNewPrivileges, ProtectSystem=strict).

### 3.9 Security audit — PASS (45/45)
`scripts/security-audit.ts`:
- Authentication gate: **17 endpoints** unauthenticated → all 401.
- Login security: wrong password 401, empty 400, cookie `HttpOnly+SameSite` verified, tampered HMAC token 401, forged/expired token 401.
- **Rate limiting (added this phase):** middleware `src/middleware.ts` — 900/min general API, 10/min login. Brute-force proof: 15 rapid logins → 8×429.
- SQL injection: Prisma parameterized; injection payloads through search endpoints → no 5xx, no error leak.
- XSS: JSON content-type, payload stored as data, React text-node rendering.
- CSRF: cross-site POST without credentials → 401 on all writes.
- Router command validation: unknown section 400, missing confirm 400.
- Audit logging: actions recorded (51+ entries).
- Tenant/branch isolation: branch filter isolates subscribers; empty branch → zero revenue; network rows carry routerId.
- WebSocket auth: agent namespace rejects invalid tokens (verified above).
- **Backup/restore:** `scripts/backup.sh` — gzip integrity + integrity check before replace, safety copy, 30-backup retention. **Roundtrip verified byte-identical**; post-restore counts intact (5 routers, 8 devices, 1250 vouchers, 4 subscribers, 2 ledger rows).

### 3.10 Performance — PASS (12/12)
`scripts/performance-test.ts` (honest scope: synthetic routers `isDemo=true` excluded from live polling — measures DB/API/concurrency, not router connectivity):

| Metric | Result |
|---|---|
| Data volume | 100 routers · 1,000 devices · 2,000 vouchers |
| GET /api/dashboard | p50 21ms · p95 51ms |
| GET /api/devices (1000 rows + stats) | p50 21ms · p95 47ms |
| GET /api/routers (100 + counts) | p50 86ms · p95 193ms |
| Subscribers / finance / P&L / vouchers search / network | p95 12–41ms |
| Concurrency | 10 sessions × 6 req = 60 req → 0 failures, wall 1.54s |
| DB raw | count 1.1ms · select200 6.8ms · groupBy 2.7ms |
| Sync trigger under 100-router load | 200 OK in 24s (connect-fail path; backoff protects) |

**Bottleneck note:** `/api/routers` p95 ≈ 190ms with 100 routers due to per-router user/session count queries (N+1) — acceptable now; batching recommended if >300 routers.

---

## 4. Known limitations (honest)

1. **Cloud sandbox cannot reach 192.168.1.3** — every router-dependent claim stays PARTIAL until §2 runs on-site. The suite makes false positives structurally impossible (unreachable → all sources NO-CONNECTION, exit 1).
2. **SQLite (via Prisma)** — single-file DB; the data layer is isolated so switching to PostgreSQL is a connection-layer change. For >50k devices or >5 writers, move to Postgres.
3. **Rate limiter is in-memory** — per-instance; move to Redis for multi-replica.
4. **Multi-organization** — the model exists (Organization → Branch) and all operational enforcement (finance scoping, assignment, reports) is at **branch level**; org-level row-level isolation across every table is scaffolded but not fully enforced — marked PARTIAL in the checklist.
5. **Per-device traffic** — RouterOS cannot provide exact per-MAC accounting without queues/sniffer; the platform attributes only what the router actually reports (documented in UI).
6. **Voucher real-login tests** — the four auth modes need a physical hotspot login test on-site; username_only includes a live config verification so it cannot silently pass.
7. **Agent command surface** — currently `ros_commands` + `health`; LAN auto-discovery sweep beyond the configured router is stubbed in capabilities and documented as next step.
8. **Single-instance deployment** — Next.js API routes + in-process scheduler + socket.io sidecar (port 3003 via gateway). Verified architecture for the one-box production profile.

## 5. Deployment requirements
- Node 20+ (or Bun 1.3+), 2 vCPU / 4GB RAM minimum for the verified profile
- `APP_SECRET` set (credential encryption + sessions) — **required, fallback dev secret must never reach production**
- `DATABASE_URL` (SQLite file), `PUBLIC_AGENT_URL` for agent onboarding
- Caddy (included) on :81 → :3000; realtime :3003 via gateway
- Outbound-only agent on a LAN host or Docker; TLS recommended (`wss://`)

## 6. Backup & recovery
- `scripts/backup.sh` (verified) · restore with pre-restore safety copy · retention 30 · **run via cron nightly** (recommended: `0 2 * * * /opt/mtcm/scripts/backup.sh`)
- Router credentials: AES-256-GCM at rest; loss of `APP_SECRET` makes them undecryptable — keep the secret backed up securely.

---

## 7. Final checklist

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Auth gate on all API endpoints | **PASS** | 17/17 → 401 |
| 2 | Session security (HMAC, HttpOnly, SameSite, expiry) | **PASS** | audit §2 |
| 3 | Rate limiting | **PASS** | 429 proof |
| 4 | SQL injection resistance | **PASS** | payload sweep |
| 5 | XSS handling | **PASS** | JSON + React text nodes |
| 6 | CSRF protection | **PASS** | credentialed writes only |
| 7 | Audit logging | **PASS** | activity trail verified |
| 8 | Financial idempotency (no duplicates) | **PASS** | duplicate reference 400 |
| 9 | Backup/restore roundtrip | **PASS** | byte-identical |
| 10 | Performance at 100 routers / 1k devices | **PASS** | 12/12 |
| 11 | Device discovery engine (unit) | **PASS** | 49/49 |
| 12 | Voucher 4 auth modes + designer | **PASS** | UI + API verified |
| 13 | Credential encryption at rest | **PASS** | 1250 migrated, 0 plaintext |
| 14 | Subscriber lifecycle + state machine | **PASS** | UI verified |
| 15 | Accounting module (ledger/closing/P&L) | **PASS** | UI + API verified |
| 16 | Multi-branch assignment + scoped reports | **PASS** | UI + API verified |
| 17 | Agent E2E (register/connect/heartbeat/relay/auth) | **PASS** | full run |
| 18 | Agent WebSocket token auth | **PASS** | invalid token rejected |
| 19 | RouterOS manager write safety (whitelist/confirm/428/recovery) | **PASS** | API tests |
| 20 | **Real router integration (34 sources)** | **PARTIAL** | suite ready; router unreachable — run on-site |
| 21 | **Live voucher sync + hotspot login test (all modes)** | **PARTIAL** | fail-fast proven; live test on-site |
| 22 | **Subscriber router-side enforcement** | **PARTIAL** | commands implemented; live test on-site |
| 23 | **ROS manager live reads/writes** | **PARTIAL** | live test on-site |
| 24 | **Live traffic sampling from real router** | **PARTIAL** | engine ready; live test on-site |
| 25 | Multi-organization full row-level isolation | **PARTIAL** | branch-level enforced; org-level scaffolded |
| 26 | PostgreSQL migration | **FAIL (not built)** | documented path only |
| 27 | Redis-backed rate limiting / queues | **FAIL (not built)** | single-instance profile sufficient |

**Gate to production:** items 20–24 must be executed inside the customer LAN via the delivered suites and pass. Items 26–27 are optional scale upgrades, not blockers for the verified single-instance profile.
