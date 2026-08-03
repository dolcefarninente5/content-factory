#!/bin/bash
# Daily backup: the SQLite file is your entire operation's state (every
# score, every reasoning note, every cost estimate, every approval
# decision) - losing it loses the audit trail, not just convenience data.
#
# What this does:
#   1. Safely snapshots the live database via Node (better-sqlite3's
#      .backup() API - safe even while the server is running; a plain
#      `cp` on a live WAL-mode db can copy a torn/inconsistent file)
#   2. Tars that snapshot together with the uploads/ directory
#   3. Drops it in backups/ with a dated filename
#   4. Deletes local backups older than KEEP_DAYS
#   5. If RCLONE_REMOTE is set in .env, also pushes the archive off-server
#      (a backup on the same disk as the thing it's backing up doesn't
#      protect you against disk failure or a bad `rm -rf`)
#
# Run manually: ./scripts/backup.sh
# Run daily via cron (see README for the crontab line)

set -e
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_NAME="factory-backup-${TIMESTAMP}"
TMP_DB_COPY="/tmp/${BACKUP_NAME}.db"

echo "[backup] snapshotting database..."
node scripts/backupDb.js "${TMP_DB_COPY}"

echo "[backup] archiving db + uploads..."
mkdir -p backups
tar -czf "backups/${BACKUP_NAME}.tar.gz" -C /tmp "$(basename "${TMP_DB_COPY}")" -C "$(pwd)" uploads
rm -f "${TMP_DB_COPY}"

echo "[backup] wrote backups/${BACKUP_NAME}.tar.gz ($(du -h "backups/${BACKUP_NAME}.tar.gz" | cut -f1))"

echo "[backup] pruning backups older than ${KEEP_DAYS} days..."
find backups/ -name "factory-backup-*.tar.gz" -mtime "+${KEEP_DAYS}" -delete

if [ -n "$RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup] pushing to remote: ${RCLONE_REMOTE}"
    rclone copy "backups/${BACKUP_NAME}.tar.gz" "${RCLONE_REMOTE}"
  else
    echo "[backup] RCLONE_REMOTE is set but rclone is not installed - skipping off-server copy"
  fi
else
  echo "[backup] RCLONE_REMOTE not set in .env - backup stayed local only. See README to add off-server storage."
fi

echo "[backup] done"
