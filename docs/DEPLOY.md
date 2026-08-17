# Deploying to Vercel and Supabase

Everything here is a step somebody has to take once. The application needs no
code changes to run on Vercel — the object store keeps bytes in Postgres by
default, sessions are signed cookies, and the connection layer detects a pooled
database on its own.

## 1. Create the Supabase database

Take **two** connection strings from *Project settings → Database*. They differ
by port and they are not interchangeable.

| Use | Port | Why |
| --- | --- | --- |
| The deployed application | **6543** — transaction pooler | Supabase's direct host is IPv6-only and Vercel's functions cannot reach it. The transaction pooler holds a backend only for the length of a transaction, which is what a short-lived function wants. |
| Running migrations | **5432** — session pooler | DDL needs one backend for the whole transaction. A transaction pooler is free to move you between backends mid-flight, and half an applied migration on an accounting database is about the worst outcome in this repository. |

They look like:

```
# application — DATABASE_URL on Vercel
postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres

# migrations — DATABASE_URL in your shell, once
postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

`src/db/index.ts` detects port 6543 and turns prepared statements off, because
PgBouncer in transaction mode does not support them. Without that you get
intermittent `prepared statement "s1" already exists` under load — a message
that mentions neither pooling nor prepared statements, and one of the more
miserable things to debug. `npm run db:migrate` refuses outright to run through
6543 and tells you to use 5432.

## 2. Apply the schema

From your machine, pointing at the **session** pooler:

```bash
DATABASE_URL='postgres://…@….pooler.supabase.com:5432/postgres' npm run db:migrate
```

Do **not** run `npm run db:seed` against production. It creates demo companies
with a published password.

## 3. Generate the secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"        # SESSION_SECRET
openssl rand -base64 32                                                          # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # CRON_SECRET
```

`SESSION_SECRET` and `ENCRYPTION_KEY` have development fallbacks and the
application **refuses to boot in production without real values** — deliberately,
because a fallback encryption key protecting real TOTP secrets is worse than no
encryption, in that it looks like protection.

Changing `SESSION_SECRET` signs everybody out. Changing `ENCRYPTION_KEY` makes
every stored TOTP secret undecryptable, and those users will have to re-enrol.

## 4. Set the environment on Vercel

*Project settings → Environment Variables*, for Production and Preview:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the **6543** pooler string |
| `SESSION_SECRET` | from above |
| `ENCRYPTION_KEY` | from above |
| `CRON_SECRET` | from above |
| `PUBLIC_BASE_URL` | `https://your-domain` — links in transactional mail are built from it, and a reset pointing at localhost is a dead link |

Leave `OBJECT_STORE` unset. The default keeps attachments in Postgres, which is
what you want on a platform with no persistent disk.

## 5. Deploy

Import the repository into Vercel. Framework detection handles the rest; the
build is `next build` with no special settings.

`vercel.json` registers the cron job. **Vercel's Hobby plan runs cron at most
once a day** — if you are on Hobby, either accept daily batching or move the
schedule to an external caller (below).

## 6. Check it works

```bash
# Should be 401 — the endpoint refuses without the secret rather than
# defaulting open.
curl -i https://your-domain/api/cron/worker

# Should return a tick summary.
curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain/api/cron/worker
```

A healthy response looks like:

```json
{"ok":true,"eventsRelayed":0,"schedulesFired":0,"jobsRun":0,
 "jobsSucceeded":0,"jobsFailed":0,"jobsDead":0}
```

Then open the site: `/` is the landing page, `/register` sets up your first
company and signs you in.

## The background worker

`npm run worker` is a long-running process and serverless platforms do not have
those. On Vercel, cron calls `/api/cron/worker` every five minutes, which runs
exactly the same `runOnce` the worker loop and the tests call.

This matters more than it looks. Everything the queue carries stops **silently**
without it — the monthly rent run, dunning letters, the transactional outbox,
retention sweeps, scheduled reports. Nothing errors; jobs simply stay `queued`.
That is why the route refuses every request when `CRON_SECRET` is unset rather
than running for anybody who finds the URL.

Overlapping calls are safe: `claimJobs` uses `FOR UPDATE SKIP LOCKED`, so two
invocations take different jobs rather than the same one.

**Any scheduler works.** To use something other than Vercel Cron — GitHub
Actions, a cron box, Supabase's `pg_cron` with `pg_net` — delete the `crons`
block from `vercel.json` and have it send the same authorised request.

## What is still a mock in production

Neither blocks a deployment, and both are behind provider interfaces:

- **Bank feeds** (`BANK_PROVIDER=mock`). Transactions are generated, not
  fetched. Everything downstream — rules, categorisation, reconciliation — is
  real.
- **Transactional email** (`TRANSACTIONAL_EMAIL_PROVIDER=mock`). Mail is kept in
  memory and logged. **Password resets and invitations will not arrive** until a
  real provider is configured, so plan to create the first account yourself
  through `/register` rather than by invitation.

## Upgrading later

Run migrations against the session pooler before deploying code that needs them,
the same as step 2. The application tolerates a schema ahead of it far better
than one behind it.
