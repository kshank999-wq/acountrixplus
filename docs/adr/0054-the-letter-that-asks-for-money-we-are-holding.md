# ADR 0054 — The letter that asks for money we are holding

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §16. Phase 53 gave an overpayment somewhere to live and
  left the two outward-facing surfaces blind to it: the chase run would email a
  demand to a customer whose money the business is holding, and the statement
  would claim the gross.
- **Builds on:**
  [ADR 0043](0043-a-business-that-has-to-remember-to-chase-does-not-chase.md),
  [ADR 0052](0052-the-payment-you-cannot-take-back.md),
  [ADR 0053](0053-the-money-you-cannot-bank.md)

## Context

Phase 53 closed a real hole and opened two, and it is worth being plain that
**this phase fixes damage the previous one did** rather than something that was
always broken. Before Phase 53 an overpayment could not be recorded at all, so
there was no held credit for anything to be blind to.

After it, a customer could hold $600 of credit against a $900 open invoice, and:

- **The chase run** (Phase 43) reads invoice balances and nothing else. It would
  have emailed that customer a demand for $900. Phase 43's whole design is that
  these letters go out *without anybody deciding again*, which is precisely what
  makes a wrong one serious — nobody is in the loop to catch it.
- **The statement** computes its closing balance from open invoices, so the same
  customer would receive a document claiming $900 is due — a claim they can
  disprove from their own bank records, which is the kind of error that makes a
  business look like it does not know what it is owed.

Phase 53's own ADR named the statement as unfinished work. The chase was not
noticed at the time, and it is the worse of the two: a statement is read by
somebody who can query it, and a chase is a demand nobody at the business saw
before it went.

## Decision 1: nothing goes out while anything is held

`chaseableAgainstCredit` refuses a chase whenever the customer's held credit is
above zero — decided on the **customer's whole position**, not invoice by
invoice, and not scaled to the size of the credit.

The alternative, netting per invoice, is worse in both directions. A customer
holding $600 with two $500 invoices owes $400 on net: chasing the older one for
its full $500 asks for more than is due, and chasing neither because "$600
covers $500" leaves $400 uncollected for ever. Neither is a letter anybody would
send on purpose.

So the rule is a **pause, not an exemption**. Somebody has to decide where that
credit belongs — apply it or refund it — and that is a person's call, not a
scheduler's. The moment the credit is nil, chasing resumes with nothing changed,
which the tests assert through all three ends: applying it, refunding it, and
voiding the receipt that held it (Phase 52).

A new `ChaseRefusal` rather than silence, because Phase 43's preview exists to
say *why* an invoice is not being chased. "We are holding credit for this
customer" is the reason somebody needs in order to act on it.

## Decision 2: the statement keeps the gross and adds the net

`closingBalanceCents` is unchanged, and `dueCents` sits beside it.

Replacing the gross would break the statement's other job: a customer
reconciling against their own purchase ledger needs to see what was **billed**.
A document showing only $300 against their record of a $900 invoice raises the
same query the wrong figure did. So the statement says both, and a sentence
decided by the same pure function joins them.

`dueCents` is clamped at zero. "What should this customer pay" has no negative
answer — a customer owed money pays nothing — and the fact that the balance runs
the other way is carried by `stance` and `ourDebtCents`, so the "we owe you"
case is a sentence rather than a minus sign.

The held figure is cut off at `asOfDate`, like the invoices above it. A receipt
that arrived in August did not reduce what was due on the June statement, and
counting it would net a credit against invoices it had not yet met.

## Decision 3: netting here, and not in the aging report

The aging report is about **receivables**: what is owed, by age, so somebody can
judge how collectable it is. Held credit is a liability on the other side of the
balance sheet, and netting it into aging would hide it — exactly the mistake
Phase 53 refused when it declined to record an overpayment as a negative
receivable.

A statement and a chase are different: both are addressed to one customer and
both make a claim about what *that customer* should do next. For those, the
gross figure is not merely unhelpful, it is untrue.

## Decision 4: a saved statement is read back, never recomputed

`listStatements` reads `heldCreditCents`, `dueCents` and `positionNote` out of
the frozen `figures` rather than asking the books again. Recomputing would
answer as of *today*, so a statement sent in March would quietly change its mind
in July — and "what did we actually tell them?" is the only question somebody
has that list open to answer. Statements saved before this phase have no held
figure and fall back to reading as a plain gross balance, which is what they
were.

## What the browser found

Two things, and both were real.

**The sentence had no currency symbol.** It read *"1540.00 is due, after the
460.00 we are holding for you"* beside a table of `$` figures. `describeNet` now
takes the company's currency and formats through the same `formatCents` the rest
of the application uses. On a document asking somebody for money, a bare number
is the sort of ambiguity that generates the phone call the statement was meant
to prevent.

**The payment form still promised the old refusal**: *"A payment for more than
is outstanding is refused rather than left sitting against nothing."* Phase 53
made that false for receipts and left the prose behind. It now says what happens
— banked in full, the difference held — and keeps the refusal for the
disbursement side, where it is still true and now says why.

The walk-through itself: $29,500 arrived against Harborview's $29,040, recording
*"$460.00 more than was owed is held as credit for them"*; a $2,000 invoice was
raised and sent; and the chase preview moved it out of **Would go out today**
into **Not being chased** under *"we are holding credit for this customer"*. The
statement then read Billed $2,000.00, Held $460.00, Asked for $1,540.00. Both
control accounts agreed to the cent afterwards — `2520` at 46,000 against 46,000
unapplied, and Accounts Receivable at 2,060,069 against the same figure on the
open-invoice subledger.

## Consequences

- `chase_settings` is untouched: this is not a policy option. A business does
  not get to switch on demanding money it is sitting on.
- `heldCreditCents` is optional on `ChaseableInvoice`, so every existing caller
  compiles and reads as "nothing held" — which is what it was.
- The held-credit subqueries in `chaseCandidates` and `customersWithBalances`
  exclude void payments, the same exclusion the last-payment subquery makes and
  for the same reason (Phase 52).
- `customersWithBalances` gets its held figure from a subquery rather than a
  second join, because joining it alongside `invoices` would multiply the credit
  by the number of open invoices.

## What this does not do

It does not net held credit on the **customers screen** (Phase 45) or in the
**aging report**, and the second is deliberate — see Decision 3.

It does not decide *where* the credit should go. That is the point: the phase
buys the time for a person to decide, and Phase 53 built both ends they can
choose between.
