# SQLite → PostgreSQL migration report — 2026-11-16T11:22:13.084Z

## 1) Starting embedded PostgreSQL
- reusing existing data dir /home/z/my-project/db/pgdata
- database mtcm already exists
- PostgreSQL ready on 127.0.0.1:54329 (db mtcm)
- schema pushed to PostgreSQL + PG client generated (generated/pg/client)

## 2) Row-by-row copy (IDs, encrypted blobs, timestamps preserved)
- Organization: src=3 → dst=3 OK
- Branch: src=3 → dst=3 OK
- AdminUser: src=1 → dst=1 OK
- Setting: src=8 → dst=8 OK
- Router: src=5 → dst=5 OK
- NetworkAgent: src=2 → dst=2 OK
- Package: src=6 → dst=6 OK
- VoucherBatch: src=7 → dst=7 OK
- Customer: src=0 → dst=0 OK
- Subscriber: src=6 → dst=6 OK
- HotspotUser: src=2850 → dst=2850 OK
- HotspotSession: src=340 → dst=340 OK
- Invoice: src=40 → dst=40 OK
- Payment: src=538 → dst=538 OK
- Refund: src=0 → dst=0 OK
- Expense: src=25 → dst=25 OK
- CustomerTx: src=1 → dst=1 OK
- CashRegister: src=0 → dst=0 OK
- DailyClosing: src=0 → dst=0 OK
- EmployeeCommission: src=0 → dst=0 OK
- RecurringSubscription: src=0 → dst=0 OK
- Voucher: src=1250 → dst=1250 OK
- Notification: src=21 → dst=21 OK
- ActivityLog: src=108 → dst=108 OK
- SupportTicket: src=3 → dst=3 OK
- NetworkDevice: src=8 → dst=8 OK
- DeviceObservation: src=11 → dst=11 OK
- DeviceEvent: src=0 → dst=0 OK
- DeviceIpHistory: src=0 → dst=0 OK
- DeviceMacHistory: src=0 → dst=0 OK
- DeviceTrafficSample: src=0 → dst=0 OK
- DeviceTrafficDaily: src=0 → dst=0 OK
- DeviceStatsSnapshot: src=11 → dst=11 OK
- DhcpLease: src=8 → dst=8 OK
- ArpEntry: src=8 → dst=8 OK
- BridgeHost: src=8 → dst=8 OK
- WirelessClient: src=3 → dst=3 OK
- PppSession: src=0 → dst=0 OK
- NetworkResource: src=15 → dst=15 OK
- DiscoveryJob: src=156 → dst=156 OK
- DiscoveryJobLog: src=312 → dst=312 OK
- DeviceBlockRule: src=0 → dst=0 OK
- SubscriberEvent: src=6 → dst=6 OK
- RouterMetric: src=72 → dst=72 OK
- AgentCommand: src=1 → dst=1 OK
- OrgInvoice: src=0 → dst=0 OK
- UsageCounter: src=2 → dst=2 OK

## 3) Integrity spot-checks
- router credentials decrypt: 5/5
- voucher credentials decrypt: 5/5
- first row byte-compare (router): IDENTICAL

## Verdict: MIGRATION INTEGRITY VERIFIED

## Rollback procedure (non-destructive)
- SQLite file db/custom.db is never modified by this script.
- Rollback = set DATABASE_URL back to the SQLite file URL and restart the platform; data unchanged.
- PG instance: stop with pg_ctl -D db/pgdata stop (or kill the process); delete db/pgdata to discard.