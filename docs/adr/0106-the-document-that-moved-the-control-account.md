# 0106 — The document that moved the control account

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 106

---

## The defect

Phase 31 built the check that proves a control account against the documents
behind it, and wrote down exactly why it matters:

> The balance sheet says £365 is owed; the aging report says nothing is owed;
> both are internally consistent, and neither mentions the other. Nobody chases
> the money, because the report a person would chase from does not know about it.

It then summed the subledger side from **open invoices alone**. Invoices are not
the only document that posts to `1100`. A credit note credits it the moment it
is issued, and `applyCredit` says so in as many words:

> No journal entry: the credit note already moved the receivable when it was
> issued. Applying it is bookkeeping *within* Accounts Receivable — which
> invoice the reduction belongs to — and posting a second entry would halve the
> receivable twice.

So the ledger moves at **issue** and the subledger moved at **application**, and
between those two moments `ledger.receivables` reported a *fault* — its highest
severity — on a state the application fully supports. `2000` had the same hole
from the other side: a vendor credit debits it at issue.

Measured against the test database before the fix, rather than reasoned about:

```
AR before:                       ledger=100000 subledger=100000 agrees=true
AR after raising 30000 credit:   ledger=70000  subledger=100000 agrees=false
AR after applying it:            ledger=70000  subledger=70000  agrees=true
AP before:                       ledger=80000  subledger=80000  agrees=true
AP after raising 20000 credit:   ledger=60000  subledger=80000  agrees=false
```

This is Phase 105's argument arriving from the opposite direction. There the
worry was a check too weak to mean anything. Here it is a check that cries wolf
— and **a check that cries wolf is a check somebody turns off**, taking the
genuine split Phase 31 was built to catch out with it.

## Why it survived seventy-five phases

Both controls on the receivables board pass `applyImmediately: true`, so the
screen a person actually uses never leaves a credit outstanding. Everything
underneath does:

- `createCreditNoteAction` and `createVendorCreditAction` default the flag to
  **false** — `applyImmediately: parsed.applyImmediately ?? false` — so any
  caller that omits it gets an unapplied credit.
- `invoiceId` is **optional** on that action, and a standalone credit note —
  *"a goodwill gesture before the next invoice exists"*, in the module's own
  words — has no invoice to be applied to. That path cannot produce anything
  *but* an unapplied credit.

So the defect was reachable through the service and through the action, and
invisible from the one screen anybody was clicking. The seed data has no
unapplied credit either, which is why no phase since 31 tripped over it.

## Decision 1: a control account's subledger is every document that posts to it

Not "the invoices". The claim is narrow and mechanical: if a document type
credits or debits `1100`, it belongs on the subledger side of the `1100`
comparison — because the ledger side already counted it.

An overpayment is correctly *absent* from that set, and the contrast is what
makes the rule legible: Phase 53 deliberately sent held credit to `2520`, its
own liability with its own `receivables.customer_credit` check. It never
touches `1100`, so it is not part of what `1100` is made of. A credit note is
not like that — it posts to the control account itself.

## Decision 2: this is not netting credits into the aging report

`net-position.ts` refused that in Phase 54 and the reasoning still holds:

> The aging report is about **receivables**: what is owed to the business, by
> age […] netting it into aging would hide it, which is precisely the mistake
> Phase 53 refused to make.

An unapplied credit has no age, because nobody has yet decided which invoice it
belongs to — that decision is a person's. Aging therefore still reports gross,
and this phase does not touch it.

**The honest consequence is that the aging total and the `1100` balance can now
legitimately differ, by exactly the unapplied credits.** That is a real
difference between two questions rather than a discrepancy, but it is worth
saying out loud, because `tests/entry-corrections.test.ts` asserts
`balanceOf('1100') === aging.totals.totalCents` and that assertion holds only
while no credit is outstanding. Whether the aging report should show a
"credits not yet applied" line beneath its total is a real question, and a
different one.

## Decision 3: the postings are declared data, with prose

`POSTINGS` names each document kind, the account it moves, the direction, and
**why**, on the device Phase 70 introduced and Phases 101 and 105 reused: a sign
is a fact that looks identical whether it is right or wrong, and the argument
for it is the part a reader needs.

`signFor` **throws** on a kind nobody declared rather than returning zero. A
silent zero is precisely how the credit note stayed out of this sum for
seventy-five phases; the next document type to post at a control account has to
answer the question rather than default to invisible.

## Decision 4: the per-party list nets too, and keeps a negative

Netting only the total would leave the check agreeing while naming $1,000
against a customer who owes $700 — the same two-answers-to-one-question defect
one layer down.

Two rules, both deliberate:

- **A party who nets to nothing is dropped.** A $500 invoice fully covered by a
  $500 credit belongs in neither the total nor the list of people to look at.
- **A party who nets *negative* is kept, signed.** A customer whose credits
  exceed their invoices is money the business owes them. Hiding that is the same
  failure this phase exists to fix, pointing the other way — so
  `netByParty` keeps them, and the browser shows a receivables subledger of
  `-$600.00` where that is the truth.

## Decision 5: the finding says what the figure is made of

`composition` renders *"11 invoices worth $50,000.69, 1 credit note less
$600.00"*, carried whether or not the check passes. The subledger figure stopped
being "the open invoices" in this phase, and a reader comparing it against an
aging report needs the reason before the names.

Verified in the browser on Ridgeline's real books, having raised a standalone
unapplied credit through the same service the action calls:

> **What is owed to us, against who owes it** — agrees
> Accounts Receivable against the open invoices and credit notes behind it
> 11 invoices worth $50,000.69, 1 credit note less $600.00 — Harborview
> Development LLC, City Works Authority, Meridian Facilities Ltd and 2 more

Before this phase the same books read *"$600.00 apart"*, as a fault.

## What this does not do

**It does not change the aging report.** Stated above as a decision rather than
an omission, because the two reports answer different questions — but the gap
between them is now real and undocumented anywhere a user would look.

**It does not add a check that unapplied credits get applied.** A credit sitting
open is not wrong; deciding where it belongs is a person's job, and Phase 54
already stops it being chased for money in the meantime. Whether a credit open
for six months deserves a *position* — the register's lower severity, for things
that are not broken but want a look — is a fair question and a different one.

**It does not revisit the `asOf` caveat.** The ledger side is measured as at a
date and the document side is the balance carried *now*, which
`receivables-check.ts` has documented since Phase 31. Adding credit notes uses
the same present-tense `remaining_cents` and so inherits the same limitation
exactly; it does not make it worse.
