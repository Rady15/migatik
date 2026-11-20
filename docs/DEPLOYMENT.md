# Deployment Guide — MikroTik Cloud Manager (NOC edition)

## Local run (no Docker)
```bash
bun install
bun run db:push
bun run scripts/seed.ts                      # demo/business seed (existing)
bun run scripts/register-local-router.ts     # registers your 192.168.1.3 router
bun run scripts/seed-demo-devices.ts         # optional: clearly-labeled DEMO dataset
bun run dev &                                # Next.js on :3000 (starts discovery scheduler)
bun run mini-services/realtime-service/index.ts &   # socket.io on :3003
```
Login: `admin` + the password you set (`ADMIN_PASSWORD` at seed time; change it from Settings right after the first login).

## Docker Compose (all-in-one)

```bash
cp .env.example .env       # set APP_SECRET + credentials defaults if desired
docker compose up -d --build
```
Services: `app` (Next.js :3000, runs migrations on start + starts the scheduler),
`realtime` (socket.io :3003), shared volume `db-data` for SQLite.
Put your reverse proxy in front (single domain), forwarding `/` → 3000 and
`/?XTransformPort=3003` → 3003 (the same pattern the preview gateway uses).

## Connecting your MikroTik (192.168.1.3)

1. On the router, enable the API service:
   `/ip service enable api` (port 8728) — or `api-ssl` (8729) + `useTls`.
2. Create a least-privilege API user:
   ```
   /user add name=mcm-api group=read profile=... password=****
   /user group add name=mcm policy=read,api,!local,!telnet,!ssh,!ftp,!reboot,!policy
   ```
   Control actions (blocking, lease edits) need `write` + `api` as well — grant
   only if you intend to use them.
3. In the web app → **إدارة السيرفرات** → edit *Core Router (192.168.1.3)* →
   set username/password (stored AES-256-GCM encrypted) → test connection.
4. The discovery scheduler picks the router up automatically (60 s interval,
   adaptive backoff when unreachable), or press **مزامنة الآن** in
   **الأجهزة والاكتشاف**.

## Operation notes
- Polling interval per router is configurable (`syncIntervalSec`, min 15 s) —
  keep ≥ 60 s for long-term use; the engine takes ONE API connection per cycle.
- Interface traffic sampling is one 1-second `/interface monitor-traffic` per
  cycle; disable via discovery settings if you prefer zero extra load.
- Blocking rules touch **only chain=forward** (never input) — management access
  cannot be locked out by the platform.
- All destructive operations (block, lease remove, session disconnect) require
  preview + explicit confirmation and are audit-logged.
- Backups: copy `db/custom.db` (WAL mode) while running is safe with
  `sqlite3 db/custom.db ".backup backup.db"`; stop the container for cold copies.
