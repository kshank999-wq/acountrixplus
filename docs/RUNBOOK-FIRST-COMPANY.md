# Running your own company's books on this

The ordered path from an empty Supabase project to a reconciled month of your
real bank data. `docs/DEPLOY.md` is the reference for *how* the deployment
works and why; this is the sequence, for one company, with the decisions already
made.

Two things to know before starting, because they shape everything below.

**There is no bank aggregator adapter.** `BankProvider` is a four-method
interface with exactly one implementation — `MockBankProvider`. So "connect my
bank and let it sync" is not available yet. What *is* available is a complete
bank-statement CSV import: field mapping, date-order ambiguity detection,
duplicate fingerprinting, and a plan-then-commit flow that shows you what it
will do before it does it. Its own docstring says it was built for this exact
situation — *"a business with real books and no aggregator connection had no way
to get a single transaction into the system."* Every bank exports CSV. You can
run your books on this now and add an aggregator later without changing
anything downstream.

**Row-level security is installed and not switched on.** 163 tables carry
policies; the application connects as the table owner, so they do not apply.
`RLS_ROLLOUT` records this. The application-layer guards are complete and
measured — 111 writes and 883 reads, every one accounted for — so for a single
company this is a low risk. It becomes a real one the day a second company's
data lives in the same database.

---

## 1. The database

Create a Supabase project. Take **both** connection strings from *Project
settings → Database*; they differ by one digit and are not interchangeable.
Port **5432** is the session pooler and is for migrations. Port **6543** is the
transaction pooler and is for the application. `npm run db:migrate` refuses 6543
outright, because DDL moved between backends mid-transaction can half-apply a
migration, and half a migration on an accounting database is the worst outcome
in this repository.

Then, from a checkout with Node:

```bash
npm ci
npm run db:setup-production -- 'postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
```

It refuses the wrong port, refuses a database that already has companies in it,
applies the migrations, **proves the schema landed** rather than trusting an
exit code, generates your secrets, and prints the environment block to paste
into Vercel.

Expect `181 tables present, ledger included.`

> No machine to run it from? `npm run db:bundle` flattens every migration into
> `drizzle/bundle.sql`, wrapped in one transaction, to paste into Supabase's SQL
> editor.

## 2. The secrets

The script generates four and names three more it cannot.

| Variable | From |
| --- | --- |
| `SESSION_SECRET` | generated — a new one signs everybody out |
| `ENCRYPTION_KEY` | generated — a new one makes every stored second factor undecryptable |
| `CRON_SECRET` | generated — gates the worker *and* `/api/health` |
| `VAPID_*` | generated — optional, for push |
| `TRANSACTIONAL_EMAIL_PROVIDER` | you: `postmark` or `resend` |
| `TRANSACTIONAL_FROM_EMAIL` | you: a verified sender on that account |
| `POSTMARK_SERVER_TOKEN` / `RESEND_API_KEY` | that provider's dashboard |

**Do not skip the email three.** With the provider unset the mock takes over: a
password reset is "sent", written to a console log, and returns success. Nothing
at runtime will tell you. This is the single most likely way a first deployment
looks fine and is not.

## 3. Deploy, then ask the deployment what it is missing

Push to a Vercel project, set the variables for Production, and **redeploy** —
an environment change does not reach a deployment already running.

```bash
# your shell
npm run deploy:check

# the deployment, which is the one that matters
curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain/api/health
```

`deploy:check` reads the shell it runs in, which is not the shell Vercel runs.
The endpoint is behind `CRON_SECRET` because a list of which secrets are unset
is a map of what to attack, even though it contains no values.

You want `"fitForRealData": true`. Anything under `silent` is a thing that will
report success and do nothing — that list is the whole reason the check exists.

`vercel.json` already registers the worker cron at `*/5 * * * *`. On Vercel's
Hobby plan cron runs at most once a day, which is not enough for recurring
invoices and statement runs; see `docs/DEPLOY.md` for the alternatives.

## 4. Your company

Register through the UI. The first account is the owner.

Pick your industry at onboarding — it installs the standard chart of accounts
plus industry-specific additions, sets terminology, and enables the optional
modules for that trade. It is not cosmetic and it is easiest to get right once,
before there are transactions hanging off the accounts.

## 5. Opening balances, before any transactions

Settings → Import handles this, and doing it first is what makes everything
afterwards reconcile. It is **three separate imports**, and they answer different
questions:

| Import kind | What it takes | Why it is its own step |
| --- | --- | --- |
| `trial_balance` | every account balance as at your start date | Posts one balanced opening entry — and **refuses a trial balance that does not foot**, naming the debit and credit totals. An opening position that does not balance is not an opening position. |
| `open_invoices` | each unpaid customer invoice, individually | A receivables *total* on the trial balance would make the ledger right and leave the subledger empty, so nothing would age and no statement would be correct. Each open invoice has to exist as an invoice. |
| `open_bills` | each unpaid supplier bill, individually | The same argument on the payables side. |

Do the trial balance first, then the two document imports — and if you start
posting transactions before all three, every reconciled balance in between is
wrong by the opening figure.

## 6. Real transactions, by CSV

Export a statement from your bank. Then Settings → Import, choose
**bank statement**, pick the financial account it belongs to, and paste or upload.

What it does for you, in order:

1. **Proposes a field mapping** from the headers, which you correct if it guesses
   wrong.
2. **Refuses an ambiguous date order** rather than guessing. `03/04` is the 3rd
   of April or the 4th of March and the file does not say; it asks.
3. **Fingerprints every row** so re-importing an overlapping statement does not
   double-post. Import a fresh download each month without trimming the overlap.
4. **Plans, then commits.** You see the row count, the problems, and what will
   be created before anything is written.

Then Bookkeeping → Inbox: categorize, and save a rule from a merchant you will
see again. A rule can test description, merchant, amount, account and direction,
combined with all-of or any-of — and `applyToExisting` runs it across what is
already in the inbox.

## 7. Reconcile

Reconciliation → the account. Enter the statement's ending date and ending
balance; the cleared balance and the difference update as you tick items off.
Completing it locks the period. Reopening needs `reconciliation:reopen`, which
only an owner or accountant holds.

If the difference will not close, the difference divided by 9 is the classic
transposed-digits signature, and the assistant's reconciliation explanation
checks for exactly that.

## 8. Before you depend on it

```bash
npm run db:backup          # takes one
npm run db:verify-restore  # proves the backup restores
```

Run the second one. A backup nobody has restored is a hope, and §19 asks for a
*tested* restore procedure specifically.

---

## What you will find missing

Measured in ADR 0173's bullet-level pass, so this list is complete rather than
impressionistic — for the sections it covered.

- **No aggregator feed.** CSV, monthly, until an adapter exists.
- **The design engine is blocks, not a canvas.** No guides, rulers, snapping,
  layers, vector primitives, crop/mask or SVG import. Proposals and marketing
  documents work; an Illustrator-class editor is not there.
- **No generic table block** — `pricingTable` exists, a plain table does not.
- **No asset association**, so there is no answer to "what have we sent this
  client".
- **No team bios** in the company profile.

None of these touch bookkeeping, invoicing, reconciliation or the ledger.

## What to do if something is wrong with the books

Do not edit history. The ledger favours append-only correction, and the
machinery is in `modules/ledger/corrections.ts` and `corrections-service.ts`
for a reversing entry, `modules/receivables/payment-voiding.ts` for a payment,
and period locks to stop a correction landing in a closed month. §19 asks for
this specifically, and it is the difference between an accounting system and a
spreadsheet.

`modules/corrections/vocabulary.ts` is worth reading once: it is the single list
of what the product *calls* each kind of undo, written because "Take it back"
once appeared on three screens meaning three different things. If you are
unsure whether you want to void, reverse, withdraw or undo something, that file
is the answer.
