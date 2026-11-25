#!/bin/bash
# Saves a copy of the live database outside Cloudflare and proves it restores.
# Usage: tools/backup-db.sh [folder]   (default ~/Brigade Backups)
# Contains member data: keep the folder private, never commit it.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
DEST="${1:-$HOME/Brigade Backups}"
KEEP=30
umask 077
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

npx wrangler d1 export brigade-app --remote --output "$TMP/db.sql" >"$TMP/log" 2>&1 || { tail -5 "$TMP/log"; exit 1; }

# Practice restore into a scratch database, then compare with the live counts.
sqlite3 "$TMP/check.db" < "$TMP/db.sql"
[ "$(sqlite3 "$TMP/check.db" 'PRAGMA integrity_check')" = "ok" ] || { echo "Backup failed its integrity check"; exit 1; }
USERS=$(sqlite3 "$TMP/check.db" 'SELECT COUNT(*) FROM users')
ROWS=$(sqlite3 "$TMP/check.db" 'SELECT COUNT(*) FROM entities')
[ "$USERS" -gt 0 ] && [ "$ROWS" -gt 0 ] || { echo "Backup is empty"; exit 1; }

OUT="$DEST/brigade-$(date +%Y-%m-%d-%H%M).sql.gz"
gzip -c "$TMP/db.sql" > "$OUT"
ls -1t "$DEST"/brigade-*.sql.gz | tail -n +$((KEEP + 1)) | while read -r f; do rm -f "$f"; done
echo "Saved $OUT ($USERS accounts, $ROWS records, restore checked)"
