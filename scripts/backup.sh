#!/usr/bin/env bash
# Daily database backup that reports to Admin → Data & backups.
#
#   DATABASE_URL=postgres://...        the production database
#   BACKUP_DIR=/backups                where dumps go (keep 14)
#   API_URL=https://api.example/api/v1 the Academicall API
#   BACKUP_REPORT_TOKEN=...            same value as on the API
#
# Cron (02:30 Lagos):  30 1 * * *  /path/to/backup.sh   (cron runs in UTC)
# Optional: set RCLONE_REMOTE=r2:academicall-backups to copy each dump off the server.
set -uo pipefail
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/academicall-$(date -u +%Y%m%d-%H%M%S).dump"
report() {
  curl -fsS -X POST "$API_URL/admin/backups/report" \
    -H "Authorization: Bearer $BACKUP_REPORT_TOKEN" -H "Content-Type: application/json" \
    -d "{\"status\":\"$1\",\"sizeBytes\":${2:-0},\"location\":\"$3\",\"note\":\"$4\",\"startedAt\":\"$STARTED\"}" >/dev/null || true
}
if ERR=$(pg_dump --format=custom --no-owner --file "$FILE" "$DATABASE_URL" 2>&1); then
  SIZE=$(stat -c %s "$FILE" 2>/dev/null || echo 0)
  LOC="$FILE"
  if [ -n "${RCLONE_REMOTE:-}" ]; then rclone copy "$FILE" "$RCLONE_REMOTE" && LOC="$RCLONE_REMOTE/$(basename "$FILE")"; fi
  ls -1t "$BACKUP_DIR"/academicall-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
  report ok "$SIZE" "$LOC" ""
else
  report failed 0 "$FILE" "$(echo "$ERR" | tail -c 400 | tr '"\n' "' ")"
  exit 1
fi
