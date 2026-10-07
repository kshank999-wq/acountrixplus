# 0175 — Fit for real data

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 175

---

**Written retroactively, in Phase 176.** The work shipped as commit `dade50c`
with a README section, a test file and a runbook, and no ADR — which is the one
artifact in this project's own process that exists to be falsified later. Phase
176 found two things in that commit that a written-down nomination would have
caught (§"What it left broken" below), so the record is completed rather than
skipped.

## The nomination

Not an ADR's. The person who owns the books asked what it would take to *"get a
work copy together that I can start using testing in real world environment"*,
and chose Stage A — deploy on real infrastructure — out of four.

## The measured gap

Every adapter in this codebase falls back to a mock when its variable is unset,
and that default is **right**: it is what lets the demo, the seed and 4,200 tests
run with no credentials and no network.

It is also the exact shape Phase 160 found in `devices` and `security_policies`
and called the dangerous one — it degrades silently. A deployment with no
`TRANSACTIONAL_EMAIL_PROVIDER` does not refuse to send a password reset. It
writes the link to a console log, returns
`{ ok: true, providerMessageId: 'mock-…' }`, and the person waiting concludes
their account is broken.

`getTransactionalProvider` already throws for a provider that is *named* and
misconfigured, and its comment says why. That covers the typo. Nothing covered
the omission, which is the one a first deployment actually makes.

## A register, not a refusal to boot

Tempting and wrong in two directions. A preview deployment with no mail provider
is useful and should start. And a check that prevents boot cannot be *read* — the
operator sees a crash loop instead of a list of what to set.

So `DEPLOY_CHECKS` is Phase 101's device: ten entries at this phase (eleven since
Phase 176), each arguing not "is this variable set" but **"what happens if it is
not"**, which is why
`readinessStands` enforces a floor on the argument's length. Severity is the
field that does the work:

| | |
| --- | --- |
| `broken` | the deployment does not work at all, loudly |
| `silent-failure` | a feature **reports success and does nothing** |
| `degraded` | a capability is off and says so when used |
| `note` | worth knowing, nothing is wrong |

`fitForRealData` is false for anything broken **or** silently failing. A
deployment that cannot mail a password reset is not one to trust with somebody's
accounts, even though every page loads.

The module is pure — no database, no clock, no `process.env` — because the same
function has to answer for a **remote** deployment through `/api/health`, which
is behind `CRON_SECRET` since a list of which secrets are unset is a map of what
to attack even though it contains no values. `npm run deploy:check` reads the
shell it runs in, which is not the shell Vercel runs; that distinction is in the
runbook because it is the one that makes the local check misleading.

## What the typecheck caught and the tests did not

`Environment` is `Readonly<Record<string, string | undefined>>` and not
`NodeJS.ProcessEnv`, which this project's config requires to carry `NODE_ENV`.
Requiring that would have made the module's central claim false — it is supposed
to answer for an environment that is *not* the one it is running in, including a
partial one read back from somewhere else.

Every test passed either way, because a test that builds a full environment
object satisfies both types. Worth recording as the case where the compiler was
the better instrument.

## What it left broken

Found in Phase 176, one commit later, and both by tests rather than by reading:

1. **`DEPLOY_CHECKS` is a registry and `tests/registry-error.test.ts` counts
   them.** It expected 31 and this commit made it 32. The file was not run, and
   the commit was reported as green on the tests that were. ADR 0132's count has
   now caught six registries and one stale suite, and this is the stale suite.

2. **`docs/DEPLOY.md`'s migration count.** This phase fixed it from 38 to 95 —
   95 was right, and it had been wrong for 57 migrations in the one document
   somebody follows while pointing a production database at this repository —
   and added a test asserting it against the journal, *because* fixing it again
   by hand in a year is not the remedy. Phase 176 added a migration and the test
   caught 95 against 96. The device working on the person who built it, one
   commit after they built it.

Both are the argument for writing the ADR at the time: the artifact that would
have been falsified is the sentence claiming the work was finished.

## Also measured, and it held

- A fresh database built from all 95 migrations produced **181 tables**
  structurally identical to the working copy — no drift from migrations that had
  been applied by hand across 175 phases.
- `npm run db:setup-production` ran end to end: it refuses port 6543, refuses a
  database that already holds companies, applies the migrations, **proves the
  schema landed** rather than trusting an exit code, and prints an environment
  block with the four secrets it can generate and the three it cannot.
- `npm run build` compiles, and `vercel.json` already registers the worker cron.

One correction belongs in the record because it was asserted wrongly out loud
first: transactional email was described as mock-only. It is not —
`modules/notify/providers/` holds Postmark and Resend. The grep that produced
that claim covered `notify/*.ts` and not `notify/providers/`.

## Nominated

Stage B — real data by CSV — and the aggregator adapter, which became Phase 176
at the owner's direction.
