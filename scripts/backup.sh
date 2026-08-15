#!/usr/bin/env bash
#
# Database backup (spec §19: "backups, point-in-time recovery strategy,
# retention policy, and tested restore procedure").
#
# Custom format (-Fc), not plain SQL. It compresses, it restores selectively,
# and pg_restore can list its contents — so a backup can be inspected before it
# is trusted, which a 2 GB text file cannot practically be.
#
# Usage:
#   scripts/backup.sh [output-directory]
#
# Environment:
#   DATABASE_URL      required
#   BACKUP_RETAIN     how many backups to keep (default 14)

set -euo pipefail

OUT_DIR="${1:-./backups}"
RETAIN="${BACKUP_RETAIN:-14}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT_DIR/accountrix-$STAMP.dump"

echo "Backing up to $FILE"
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DATABASE_URL"

# Verify the archive is readable before reporting success. A backup that
# cannot be listed is not a backup, and finding that out during an incident is
# how organisations discover they had none.
if ! pg_restore --list "$FILE" > /dev/null 2>&1; then
  echo "The archive was written but cannot be read back. Treating this as a failure." >&2
  rm -f "$FILE"
  exit 1
fi

SIZE="$(du -h "$FILE" | cut -f1)"
TABLES="$(pg_restore --list "$FILE" | grep -c 'TABLE DATA' || true)"
echo "Wrote $SIZE covering $TABLES tables."

# Retention. Newest first, delete past the cut.
#
# Applied after a successful backup rather than before, so a run that fails
# leaves yesterday's copy alone. Deleting first and then failing is the version
# of this script that loses data.
if [ "$RETAIN" -gt 0 ]; then
  mapfile -t OLD < <(ls -1t "$OUT_DIR"/accountrix-*.dump 2>/dev/null | tail -n +"$((RETAIN + 1))")
  for file in "${OLD[@]:-}"; do
    [ -n "$file" ] || continue
    echo "Removing old backup $file"
    rm -f "$file"
  done
fi

echo "$FILE"
