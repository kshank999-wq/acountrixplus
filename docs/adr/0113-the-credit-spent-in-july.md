# 0113 — The credit spent in July

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 113

---

## The defect

ADR 0112 said this, of repairing `receivables.customer_credit`:

> fixing it would mean the same remedy, a dated application row carrying what it
> took. That is a bigger change than a column, because **those rows do not exist
> at all**.

They exist. `payment_applications` has been in the schema since Phase 2. It is
simply **undated** — a payment, a document, an amount, and nothing else, not even
a `created_at` — which is a smaller gap than I claimed and a fixable one. Another
impossibility asserted without looking, in the phase immediately after one whose
whole subject was impossibilities asserted without looking.

And the consequence is much worse than the reach of an integrity check, because
**two readers need that date and both invented one from `payments.payment_date`.**

### The cash-basis report misstates a period, and mutates a closed one

This codebase's cash-basis rule is stated in its own caveat:

> Cash basis recognizes **through the document a payment settles**, so these move
> the bank balance and appear in no revenue or expense account.

So the period an application belongs to is the period the application was *made*
in. For an application made when the payment was recorded, that is the payment's
date and nothing is wrong. For **held credit spent later** they are months apart.

Measured by running the phase's own tests against the code as it stood:

```
FAIL  reports the July work in July, not in March
      AssertionError: expected +0 to be 200000

FAIL  leaves March alone when a March credit is spent in July
      AssertionError: expected 500000 to be 300000
```

Two separate failures from one cause. A $5,000 overpayment in March against a
$3,000 invoice, with the $2,000 held over and applied to a July invoice on
2026-07-08:

- **July's cash-basis revenue was zero.** The work never appeared in the period
  it was recognised in.
- **March's cash-basis revenue grew from $3,000 to $5,000** — *after the fact*,
  because of something somebody did in July. A period that may have been closed,
  filed and reported on returns a different number when it is re-run.

The second is the one that matters. A report that is wrong is a defect; a report
that quietly changes what it said about a closed period is the kind of defect an
accountant finds out about from somebody else.

### The same substitution in Phase 108's machinery

`settlementsAfter` — the query that walks the receivables control account back to
a date, which Phases 108 through 112 have all built on — dated an application by
`payments.paymentDate` too. Asked about a date in June, it undid a July
application by comparing the wrong date, putting a balance back that had already
been settled.

## Decision 1: the row carries the day it happened

`payment_applications` gains `applied_on`, not null. `recordPayment` writes the
payment's own date, because there the money and the document are joined in one
act; `applyCredit` writes the `appliedOn` it already takes and already dates its
journal entry with. The parameter is threaded through `applyToDocument` rather
than defaulted, so neither caller can forget which date it means.

## Decision 2: the backfill reproduces the past rather than inventing it

Every existing row is backfilled to `payments.payment_date`.

That is deliberate, and it is worth being plain about what it does and does not
recover. The true date of a credit applied later was **never written down**: the
entry `applyCredit` posts carries `source_type = 'payment'` and the payment's own
id, exactly like the payment's original entry, so nothing separates them but a
memo string. A backfill that parsed memos would silently restate periods that
have already been reported on, on a guess.

The payment date is what every reader has been using, so this backfill leaves
historical reports saying exactly what they have been saying. Applications made
from here on carry the truth. Stated as a limit rather than dressed up as a
migration that fixes history.

## Decision 3: both readers use it

`cashBasisBalances` filters on `payment_applications.applied_on`, and
`settlementsAfter` compares against it. The join to `payments` stays in both,
because a **voided** payment never happened and that is still a fact about the
payment rather than the application.

## What this does not do

**It does not promote `receivables.customer_credit` to `any_date`.** That needs a
second column — the functional amount an application took off the held credit,
the same `carried_cents` Phase 112 added to retainer draws — and this phase is
about a report telling a lie, not about a check's reach. The declaration still
reads `today_only` and still says why. Eight checks remain.

**It does not date the other things an application could carry.** No
`journal_entry_id`, no `created_at`. Both would be useful and neither is needed
for the defect this phase exists to close; naming them here is cheaper than
half-adding them.
