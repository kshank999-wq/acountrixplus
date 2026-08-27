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

Steps 2 to 4 are one command, if you would rather not do them by hand:

```bash
npm run db:setup-production -- 'postgres://…@….pooler.supabase.com:5432/postgres'
```

It refuses port 6543, refuses a database that already holds companies, applies
the migrations, checks the schema actually landed, and prints the finished
environment block for step 4 — including `DATABASE_URL` with the port already
swapped to 6543. The rest of this section is what it does, for when you want to
do it yourself or something goes wrong.

### If you have no machine to run it from

Both of the above need the repository, Node, and a network route to the
database. From a browser only, flatten the migrations into one file and paste
it into Supabase's SQL editor instead:

```bash
npm run db:bundle          # writes drizzle/bundle.sql
```

It wraps all 38 migrations in a single transaction, so a failure anywhere
leaves the database untouched rather than half built, and it refuses a database
that already has the schema. It also writes Drizzle's own bookkeeping rows —
without those, the next `npm run db:migrate` would see an empty
`drizzle.__drizzle_migrations` and try to create every table again.

### By hand

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
| `PUBLIC_BASE_URL` | `https://your-domain` — links in transactional mail are built from it, and a reset pointing at localhost is a dead link. If the domain is not attached yet, use the `*.vercel.app` URL for now and see step 6 |

Leave `OBJECT_STORE` unset. The default keeps attachments in Postgres, which is
what you want on a platform with no persistent disk.

## 5. Deploy

Import the repository into Vercel. Framework detection handles the rest; the
build is `next build` with no special settings.

`vercel.json` registers the cron job. **Vercel's Hobby plan runs cron at most
once a day** — if you are on Hobby, either accept daily batching or move the
schedule to an external caller (below).

## 6. Attach your domain

Two different things get called "moving a domain to Vercel", and they have
different consequences. Decide which you want before touching anything.

| | What it does | When it makes sense |
| --- | --- | --- |
| **Point DNS at Vercel** | The domain stays registered where it is; records send traffic to Vercel | Almost always. Reversible in minutes by changing a record back. |
| **Transfer the registration** | Vercel becomes your registrar and bills you for it | Only if you want one less account. Locked for **60 days** afterwards by ICANN rule, and it is not reversible on a whim. |

Nothing below requires a transfer. If somebody says "transfer it to Vercel" and
means "make the site load there", the first row is what they want.

### Pointing DNS at Vercel

1. *Vercel → your project → Settings → Domains → Add*, and enter the domain.
2. Vercel shows the records it wants. Add them at your current registrar
   (Cloudflare, Namecheap, GoDaddy, wherever the domain lives today):

   | Record | Host | Points at |
   | --- | --- | --- |
   | `A` | `@` (the bare domain) | Vercel's apex IP, as shown on the page |
   | `CNAME` | `www` | `cname.vercel-dns.com` |

   Vercel is the authority on the exact values — take them from the screen
   rather than from here, because they have changed before.
3. Wait for propagation. Usually minutes; the TTL on the old record is the
   ceiling. `dig +short your-domain` from a shell tells you what the world
   currently sees.
4. Vercel issues the TLS certificate on its own once the records resolve. There
   is nothing to buy or upload.

**If the domain is on Cloudflare**, set the records to *DNS only* (grey cloud)
rather than proxied, at least until the certificate is issued. An orange-cloud
proxy in front of Vercel's own TLS is the commonest cause of a redirect loop.

**Alternatively, delegate the whole domain** by pointing your registrar's
nameservers at Vercel's. Simpler to reason about, and it moves every record —
including your **mail** records. A domain that receives email needs its `MX` and
`SPF`/`DKIM` records recreated on the new nameservers, and mail stops arriving
in the gap if they are not. Prefer the two records above unless you have a
reason.

### Then update `PUBLIC_BASE_URL`

This is the step people miss, and it fails quietly.

`PUBLIC_BASE_URL` is what every link in outbound mail is built from — password
resets, invitations, unsubscribe links. It is read from the environment at
runtime, so it does **not** pick up the new domain on its own:

1. *Settings → Environment Variables* → set `PUBLIC_BASE_URL` to
   `https://your-domain` (no trailing slash — it is stripped either way).
2. **Redeploy.** An environment change does not reach the running deployment
   until something rebuilds.

Until you do, the application keeps working perfectly and every reset link it
sends points at the old address or at `localhost:3000`. Nothing errors; the
links are just dead.

## 7. Check it works

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
  through `/register` rather than by invitation. Turning it on is the next
  section, and it is worth doing before you have anything to lose: with the
  mock, an account whose password is forgotten cannot be recovered through any
  screen.

## Turning on real email

Two adapters ship. Both talk JSON over HTTPS rather than SMTP, which is what a
serverless runtime is good at.

**1. Verify your sending domain** with whichever provider you pick. This is not
optional and it is not a step you can retry past: every provider refuses to
send as a domain you have not proved you own, permanently.

**2. Set the variables**, then redeploy:

| Provider | Variables |
| --- | --- |
| [Resend](https://resend.com) | `TRANSACTIONAL_EMAIL_PROVIDER=resend`, `RESEND_API_KEY` |
| [Postmark](https://postmarkapp.com) | `TRANSACTIONAL_EMAIL_PROVIDER=postmark`, `POSTMARK_SERVER_TOKEN` |

Also set `TRANSACTIONAL_FROM_EMAIL` to an address at the verified domain. The
default is `no-reply@accountrixplus.test`, which no provider will accept.

**3. Check it.** Ask for a password reset at `/forgot` for an address you own.

The one thing that screen will never tell you is whether it worked — it says
the same sentence whether the address exists, does not exist, or exists and
bounced, because anything else turns the form into a way to discover who has an
account. **Delivery failures are reported to you instead**, on
`/settings/operations`, which is where to look when somebody says a link never
arrived.

A misconfigured provider fails loudly rather than quietly: an unknown name or a
missing key throws instead of falling back to the mock, so the failure is at
deploy time rather than the first time somebody is locked out.

## Upgrading later

Run migrations against the session pooler before deploying code that needs them,
the same as step 2. The application tolerates a schema ahead of it far better
than one behind it.
