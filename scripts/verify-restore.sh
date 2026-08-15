#!/usr/bin/env bash
#
# The tested part of "tested restore procedure" (spec §19).
#
# ## Why this script exists
#
# Everybody has backups. The organisations that lose data are the ones whose
# backups had never been restored — the dump excluded a schema, the archive was
# truncated, the restore needed an extension that was not installed. None of
# those are visible until the day they matter.
#
# So this does the whole round trip against a scratch database and compares row
# counts table by table. It is meant to run on a schedule beside the backup
# itself, and to fail loudly.
#
# It never writes to the source database and never restores over an existing
# one: the scratch database is created here and dropped at the end.
#
# Usage:
#   scripts/verify-restore.sh [dump-file]
#
# With no argument it takes a fresh dump of DATABASE_URL.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

# Split the URL so a scratch database can be addressed on the same server.
BASE_URL="${DATABASE_URL%/*}"
SOURCE_DB="${DATABASE_URL##*/}"
SOURCE_DB="${SOURCE_DB%%\?*}"
SCRATCH_DB="${SOURCE_DB}_restore_check"
ADMIN_URL="$BASE_URL/postgres"

DUMP_FILE="${1:-}"
TEMP_DUMP=""

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" > /dev/null 2>&1 || true
  [ -n "$TEMP_DUMP" ] && rm -f "$TEMP_DUMP"
}
trap cleanup EXIT

if [ -z "$DUMP_FILE" ]; then
  TEMP_DUMP="$(mktemp -t accountrix-verify-XXXXXX.dump)"
  DUMP_FILE="$TEMP_DUMP"
  echo "Taking a dump of $SOURCE_DB…"
  pg_dump --format=custom --no-owner --no-privileges --file="$DUMP_FILE" "$DATABASE_URL"
fi

echo "Restoring into scratch database $SCRATCH_DB…"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";"
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SCRATCH_DB\";"

# --exit-on-error, so a restore that half worked is a failure rather than a
# database that looks populated and is missing a table.
pg_restore --no-owner --no-privileges --exit-on-error \
  --dbname="$BASE_URL/$SCRATCH_DB" "$DUMP_FILE"

# Row counts per table, from both databases, compared.
#
# `count(*)` per table rather than the planner's estimate in pg_class: the
# estimate is stale until ANALYZE runs and would report a successful restore of
# an empty database.
COUNT_SQL="
SELECT table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text::bigint AS rows
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 ORDER BY table_name;
"

SOURCE_COUNTS="$(psql "$DATABASE_URL" -At -F'|' -c "$COUNT_SQL")"
SCRATCH_COUNTS="$(psql "$BASE_URL/$SCRATCH_DB" -At -F'|' -c "$COUNT_SQL")"

if [ "$SOURCE_COUNTS" = "$SCRATCH_COUNTS" ]; then
  TABLES="$(echo "$SOURCE_COUNTS" | grep -c '|' || true)"
  ROWS="$(echo "$SOURCE_COUNTS" | awk -F'|' '{ sum += $2 } END { print sum + 0 }')"
  echo "PASS — $TABLES tables and $ROWS rows restored identically."
  exit 0
fi

echo "FAIL — the restored database does not match the source." >&2
echo "--- differences (source vs restored) ---" >&2
diff <(echo "$SOURCE_COUNTS") <(echo "$SCRATCH_COUNTS") >&2 || true
exit 1
