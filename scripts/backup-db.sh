#!/usr/bin/env bash
# Backup the command-center SQLite database to a timestamped file.
# Keeps the last 30 daily backups. Safe to run while the DB is in use
# (uses better-sqlite3 .backup inside the container which handles WAL correctly).
set -euo pipefail

BACKUP_DIR="/home/operator/data/command-center/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="command-center-${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

# Run backup inside the container where better-sqlite3 is available.
# The /app/data mount points to the host bind mount, so the backup
# file lands on the host filesystem automatically.
docker exec command-center node -e "
  const db = require('better-sqlite3')('/app/data/command-center.db');
  db.backup('/app/data/backups/${BACKUP_FILE}').then(() => {
    db.close();
    console.log('Backup complete: ${BACKUP_FILE}');
  }).catch(err => {
    console.error('Backup failed:', err);
    process.exit(1);
  });
"

# Prune backups older than 30 days
find "$BACKUP_DIR" -name 'command-center-*.db' -mtime +30 -delete

echo "Backed up to ${BACKUP_DIR}/${BACKUP_FILE}"
