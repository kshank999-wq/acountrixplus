#!/usr/bin/env bash
#
# Everything after "create the Supabase project", in one command.
#
# ## Why this script exists
#
# The deploy in docs/DEPLOY.md is six steps, and four of them are things a
# machine should do: check the connection string is the right one, apply the
# schema, prove it landed, and generate three secrets. The two that need a
# person are creating the Supabase project and pasting the result into Vercel.
#
# The step this is really guarding is the first one. Supabase hands out two
# connection strings that differ by one digit, and running migrations through
# the transaction pooler on 6543 can leave DDL half applied — a backend swap
# mid-transaction, on an accounting database. `npm run db:migrate` already
# refuses that; this refuses it earlier, with the fix in the message.
#
# Usage:
#   scripts/setup-production.sh 'postgres://…pooler.supabase.com:5432/postgres'
#
# It never seeds. Demo data with a published password does not belong in
# production, so there is deliberately no flag for it.

set -euo pipefail

MIGRATION_URL="${1:-${DATABASE_URL:-}}"

if [ -z "$MIGRATION_URL" ]; then
  cat >&2 <<'USAGE'
Usage: scripts/setup-production.sh '<session-pooler-connection-string>'

Take it from Supabase: Project settings -> Database -> Connection string,
the one on port 5432. The port matters; see below.
USAGE
  exit 1
fi

# Parsed with a real URL parser rather than a regex, because a password
# containing ':' or '@' is common and makes the naive version wrong in a way
# that is hard to see.
#
# The application string is derived here too, by setting the port rather than
# substituting text. A string with the port left off is the case that makes
# text substitution silently wrong: there is no ":5432/" to replace, the
# rewrite quietly does nothing, and the deployment ends up on the session
# pooler with prepared statements enabled — which works until two requests
# share a backend.
read -r URL_PORT URL_HOST URL_DB APP_URL <<EOF
$(node -e '
try {
  const u = new URL(process.argv[1])
  const port = u.port || "5432"
  const host = u.hostname
  const database = u.pathname.slice(1) || "postgres"
  u.port = "6543"
  process.stdout.write([port, host, database, u.toString()].join(" "))
} catch {
  process.stdout.write("- - - -")
}' "$MIGRATION_URL")
EOF

if [ "$URL_HOST" = "-" ]; then
  echo "That does not parse as a connection string." >&2
  echo "Expected something like postgres://user:password@host:5432/postgres" >&2
  exit 1
fi

if [ "$URL_PORT" = "6543" ]; then
  cat >&2 <<'WRONGPORT'
That is the transaction pooler (port 6543). Migrations must not run through it.

  Transaction mode is free to move you between backends mid-transaction, so a
  migration can be applied in halves. Use the session pooler on 5432 for this,
  and keep 6543 for DATABASE_URL on Vercel.

Same string, change 6543 to 5432.
WRONGPORT
  exit 1
fi

echo "==> Connecting to $URL_HOST:$URL_PORT/$URL_DB"

if ! psql "$MIGRATION_URL" -Atqc 'SELECT 1' > /dev/null 2>&1; then
  echo "Could not connect." >&2
  echo "Check the password is filled in — Supabase shows it as [YOUR-PASSWORD]." >&2
  exit 1
fi

# Refuse to touch a database that already holds books.
#
# Running this against a populated database is almost always somebody pasting
# the wrong string, and the cost of being wrong here is much higher than the
# cost of an extra confirmation.
EXISTING="$(psql "$MIGRATION_URL" -Atqc "
  SELECT count(*) FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" 2>/dev/null || echo 0)"

if [ "$EXISTING" -gt 0 ]; then
  COMPANIES="$(psql "$MIGRATION_URL" -Atqc \
    "SELECT count(*) FROM companies" 2>/dev/null || echo 0)"
  echo "==> $EXISTING tables already present, $COMPANIES companies."
  if [ "$COMPANIES" -gt 0 ] && [ "${FORCE:-}" != "1" ]; then
    echo >&2
    echo "This database already has companies in it. Refusing, in case this is" >&2
    echo "the wrong connection string. Re-run with FORCE=1 if it is the right one" >&2
    echo "and you are applying new migrations." >&2
    exit 1
  fi
fi

echo "==> Applying migrations"
DATABASE_URL="$MIGRATION_URL" npm run --silent db:migrate

# Prove the schema landed rather than trusting the exit code. A migration
# runner that succeeded against the wrong database also exits 0.
TABLES="$(psql "$MIGRATION_URL" -Atqc "
  SELECT count(*) FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"

if [ "$TABLES" -lt 1 ] || ! psql "$MIGRATION_URL" -Atqc \
  "SELECT to_regclass('public.journal_lines')" | grep -q journal_lines; then
  echo "Migrations reported success but the schema is not there." >&2
  exit 1
fi

echo "==> $TABLES tables present, ledger included."

# Three secrets, generated here so there is one fewer command to mistype.
#
# Regenerating is not free later: a new SESSION_SECRET signs everybody out, and
# a new ENCRYPTION_KEY makes every stored TOTP secret undecryptable. Generate
# once, paste once.
SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
CRON_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://www.accountrixplus.com}"

cat <<ENVBLOCK

────────────────────────────────────────────────────────────────────────
 Paste these into Vercel -> your project -> Environment Variables.
 Set each for Production (and Preview, if you want previews to work).
────────────────────────────────────────────────────────────────────────

DATABASE_URL=$APP_URL
SESSION_SECRET=$SESSION_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
CRON_SECRET=$CRON_SECRET
PUBLIC_BASE_URL=$PUBLIC_BASE_URL

────────────────────────────────────────────────────────────────────────
 Note the port: 6543 above, not the 5432 you passed in. The deployed
 application wants the transaction pooler; migrations wanted the session
 pooler. Both are correct, for different jobs.

 Then redeploy. An environment change does not reach a deployment that is
 already running, and PUBLIC_BASE_URL failing silently means every
 password-reset link points at the old address.

 These secrets are shown once. Do not commit them.
────────────────────────────────────────────────────────────────────────
ENVBLOCK
