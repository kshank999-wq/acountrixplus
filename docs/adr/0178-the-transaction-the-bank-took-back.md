# 0178 — The transaction the bank took back

**Status:** accepted
**Date:** 2026-10-07
**Phase:** 178

---

## The nomination held, and it was the right one to take next

ADR 0177 nominated this and gave the reason for ranking it ahead of the other
two findings still open:

> It is the last of Phase 176's three findings, it is the only one that leaves a
> **wrong row in the books** rather than merely a slow sync, and the decision is
> genuinely interesting.

All three parts survived measurement. `/transactions/sync` returns `added`,
`modified` **and `removed`**; Phase 177 fixed the second; the third had nowhere
to go, because `TransactionPage` carried transactions and a cursor and no way to
say *this one was retracted*. So Phase 176's adapter read the field and dropped
it — visibly, in a comment, which is the only thing that kept it from being
forgotten.

The consequence was worse than an inbox with a stale row in it. A withdrawn
transaction that had been categorised left **a posted journal entry for money
that never moved.** `hasMore` costs latency; this costs a wrong expense.

ADR 0177 also guessed at the shape and was right about one half and wrong about
the other:

> `FEED_CHANGE_HOLDS` is probably the register it belongs in, with a seventh
> ground and a different remedy.

The register was right. **A seventh ground was wrong**, and seeing why is the
useful part of this phase.

## Not a seventh ground — a second remedy on all six

A withdrawal is blocked by exactly the same six facts as a changed figure:
something has been derived from the stored row. There is nothing a retraction is
blocked by that a revision is not.

What differs is the **remedy**, and it differs on every single ground:

| Ground | Revision | Retraction |
| --- | --- | --- |
| `split` | *re-split it at the new total* | *remove the splits, then exclude it* |
| `matched` | *unmatch, apply, match again* | *unmatch, then exclude — the invoice becomes unpaid again* |
| `posted-to-the-ledger` | *apply, which re-posts at the new amount* | *exclude, which voids the entry and posts nothing* |

So `remedy` became `Readonly<Record<ChangeKind, string>>`. One register, one
`applies` predicate per ground, two sentences. A seventh ground would have
duplicated six predicates to vary a sentence, and two registers would have been
the same mistake spelled larger — *two answers to one question*, with the
question being **what blocks a change to this row**.

`feedChangeStands` now refuses an entry whose retraction remedy is its revision
remedy copied across. That check earns its place on Phase 121's rule: a length
floor alone would pass identical text, and identical text means one of the two
remedies is telling somebody to press a button that is not there. There is a
test that feeds it the thing it refuses.

The register was renamed `REVISION_HOLDS` → `FEED_CHANGE_HOLDS`, because a
register named after one of the two things it decides is a name that will mislead
the next reader. The registry count did not move, which is the right outcome for
a rename.

## `excluded`, not a seventh review state

A withdrawn transaction ends as `excluded` with `excludeReason` naming the bank.

A `retracted` review state was the first instinct and it is wrong: it would
behave **identically** in every inbox filter, every count, every report, and
differ only in what it was called. Seven enum values rippling through every
screen for zero behavioural difference is cost with no benefit, and the
distinction that does matter — *who decided this does not belong* — lives in the
reason and in the revisions log, which is where a question about provenance goes
anyway.

So `excluded` is one state with two causes, and `RETRACTED_REASON` is the cause,
named once because it is written on a row and read on a screen.

Its own audit action, though: `transaction.retract` and not
`transaction.exclude`. The question asked later is *why is this excluded*, and
"a person judged it did not belong" against "the bank says it never happened" are
different answers that an audit trail should not have to infer from a string.

## Reusing `excludeTransaction`, and the fact that made it safe

`recordRetractions` calls `excludeTransaction` rather than writing the row. That
is the one path that sets the state, records the reason, and lets
`syncLedgerForTransaction` void whatever was posted — because `excluded` is not a
postable state. Reimplementing those three steps would have been a second answer
to *how does a transaction stop being in the books*.

It needs `bookkeeping:categorize` and a sync needs `bookkeeping:import`, so this
only works because of a fact about the role matrix. **Measured rather than
assumed:** every role with `import` also has `categorize` — owner, bookkeeper,
accountant — and `manager` has `categorize` without `import`, which is the
harmless direction.

That fact is now pinned by a test, because it is what the design rests on. A role
given `import` without `categorize` would make a withdrawal throw
`PermissionError` in the middle of a sync, and the sentence a person saw would be
about permissions rather than about the bank.

Voiding gets the closed-period refusal for free: `voidJournalEntry` calls
`assertPeriodOpen`, so excluding a posted transaction in a reported month is
refused without a second rule here.

## One entry point for both kinds

`applyHeldRevision` became `applyHeldChange`, dispatching on `kind`. Two exported
functions would have been two places for the *re-decide before acting* step to
live, and the one that got it wrong would be the one that silently changed a
posted figure. The decision is shared; only the act differs.

The panel's button label follows the kind — **Apply and re-post** against
**Exclude and void** — because a single "Apply" would be the button asking
somebody to guess which of the two it is about to do.

## Two findings from my own work

**The early return.** `importTransactions` returns early when it has no rows to
write, and the first draft of this phase returned zeros from there — so a sync
carrying an empty `transactions` list and one withdrawal did **nothing.** That is
a real shape, not a contrived one: a pending authorisation expiring in a window
where nothing else moved. Phase 177's own defect, one function away from the fix
for it, and it now has a test of its own.

**The unique key collided.** `bank_transaction_revisions` deduplicates on
`(company_id, bank_transaction_id, amount_cents, posted_date, pending)`, and a
withdrawal copies the stored figures because it has none of its own. So a
revision **applied** at −4420 and a later withdrawal of that same transaction
carry identical values — and `onConflictDoNothing` would have dropped the
withdrawal. The feed would have said "this never happened" and the log would have
said nothing.

`kind` is in the key for that reason rather than for tidiness, and there is a
test that drives exactly that sequence. Found by thinking about the constraint
rather than by a failing run, which is worth recording because most of this
session's findings were the other way round.

## The CHECK that keeps `kind` honest

```sql
CHECK (kind <> 'retraction' OR (amount_cents = previous_amount_cents AND …))
```

A withdrawal carries no new figures — Plaid sends an id and nothing else — so the
new-value columns are copies and equal the previous ones **by construction.**
That is a property of today's writer. As a constraint it stops a future one
smuggling a figure change in under `kind = 'retraction'` and bypassing the whole
revision path: the holds, the re-post, the closed-period refusal.

Asserted in both directions, so it reads as a check rather than a ban.

## `retracted`, and why it is optional

`TransactionPage.retracted?: string[]` — ids, not records, because a withdrawal
has no figures to put in a `ProviderTransaction`. Named `retracted` and not
`removed`, which is Plaid's word: nothing is removed. The row survives as
`excluded` carrying the reason, because a row that vanished would leave a
reconciliation unable to explain itself.

Optional, and the distinction is load-bearing: `undefined` means *this source
does not say* and `[]` means *nothing was withdrawn*. The CSV importer passes
neither, because a file has no way to retract anything — and conflating the two
would have let a CSV import look like a feed asserting that every transaction
still stands.

## All three lists now reach the domain

`added`, `modified` and `removed`. Phase 176's three findings are closed except
for the one it rated least serious, and that rating still holds.

## Nominated for Phase 179: a clean full suite

Not a feature, and that is the point. The best full run this session reached
3,142 of roughly 4,200 tests with zero failures, and it has been interrupted
every time by the next phase needing to write to `src/` or `tests/`.

Three phases have now found a tree-wide tripwire red for a reason nobody had
seen: `refusal-audience` in Phase 167 (red since 161), `isolation-guards` in
Phase 169 (red since 166), `registry-error` in Phase 176 (red since Stage A, one
commit earlier). Every one was found by a count, and every one had been red for
multiple phases, because **a scan that counts the whole tree cannot be checked by
running the tests near the code that changed.**

The nomination is therefore: a run to completion, with no source written while it
runs, before anything else goes in. Four phases of real bank-feed machinery have
landed on a suite nobody has seen finish, and the one claim this repository makes
most often — that its own counts are measured rather than remembered — is the
claim that run would test.
