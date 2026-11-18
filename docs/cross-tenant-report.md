# Cross-tenant penetration test — 2026-11-16T11:17:42.337Z

Organizations: pen-a-mwj661bi / pen-b-mwj661bi (deleted after run)

| Probe | Result | Detail |
|---|---|---|
| both org users authenticate independently | PASS | orgA=pen-a-mwj661bi orgB=pen-b-mwj661bi |
| each org created its own router | PASS | A=cmwj661gz000ks1d0et81ev35 B=cmwj661hf000os1d017qti7k1 |
| B cannot READ A's router by id | PASS | GET → 404 |
| B's router list contains NO A rows | PASS | B sees 1 routers, A-router hidden: true |
| B cannot MODIFY A's router | PASS | PATCH → 404 |
| B cannot DELETE A's router | PASS | DELETE → 404 |
| A's router intact after attack probes | PASS | name=A-router |
| B cannot READ A's subscriber profile | PASS | GET → 400 |
| B's subscriber list has no A rows | PASS | B sees 0 subscribers |
| A's voucher view renders own data only (no B leakage) | PASS | checked payload for B secrets |
| B's finance summary loads and is scoped | PASS | status 200 |
| router credentials never appear in API payloads | PASS | no plaintext/enc credential fields in list responses |
| agents list scoped per organization | PASS | status 200 |
| branch creation works per-org | PASS | status 200 |
| A cannot READ B's router by id (reverse) | PASS | GET → 404 |