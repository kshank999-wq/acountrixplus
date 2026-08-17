# ADR 0031 — What is owed is owed by somebody

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §13, §19, §23
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0029](0029-a-booking-is-a-promise-and-part-of-the-money-was-never-yours.md),
  [ADR 0030](0030-nobody-bills-past-what-was-authorised.md)

## Context

Three consecutive ADRs — 0028, 0029 and 0030 — listed the same follow-up:
*nothing settles a receivable at the counter.* It read like a missing feature.
It was a defect, and the follow-up list was the wrong place for it.

Phases 29 and 30 each gave their module its own posting for what a customer
owed:

```
  Dr 1100 Accounts Receivable    total
      Cr Service Revenue                 …
```

Balanced, tested, and wrong. **Accounts Receivable is a control account** — the
ledger's one-line summary of a subledger made of customers — and this posted to
the summary without touching the subledger. Measured on the seeded demo before
the fix:

| Company | Balance sheet | Aging report |
| --- | ---: | ---: |
| Ashgrove Motors | $365.00 | $0.00 |
| Fenwick Row Studio | $199.00 | $0.00 |
| Ridgeline Construction | $39,891.94 | $39,891.94 |

Ridgeline agrees because Phase 7 raises real invoices. The other two do not,
and both are internally consistent: the balance sheet is right, the aging report
is right, and neither mentions the other. A garage owner could read $365 of
receivables off the balance sheet and have **no way to find out who owed it** —
no aging, no statement, no dunning letter, no PDF, and no way to record the
payment when the customer paid at the counter.

Four claims, asserted in `tests/control-accounts.test.ts`:

1. **What the balance sheet says is owed, the aging report can name.**
2. **A service delivered raises a real invoice.**
3. **A hand-written entry against a control account is caught.**
4. **A walk-in is somebody**, and is billed to a house account.

## Decision 1: service documents raise invoices rather than posting their own AR

`completeAppointment` and `completeRepairOrder` now call Phase 2's
`createInvoice` inside their existing transaction, and hold the invoice id.
Everything that reads invoices — aging, statements, payments, PDFs, dunning —
works on them immediately, because none of it had to change.

This is ADR 0007's rule pointed inward. The industry modules were told not to
fork the *ledger*; they forked the *receivable* instead, which is the same
mistake one level down. The fix is a deletion: both modules now build lines and
hand them over.

Two things stay outside the invoice, and deliberately:

- **The practitioner's share** (`Dr 5220 / Cr 2320`) is its own entry. The
  client is not being billed for the stylist's cut, and putting it on their bill
  would be both wrong and rude. It is a cost of delivering what the invoice sold.
- **The parts consumed** by a repair order stay with `consumeStock`, which
  debits `5160 Parts Cost` — the distinction the automotive pack exists for.
  `createInvoice` would relieve stock itself for a line naming an `itemId`, so
  repair-order lines deliberately pass none; passing it would consume the same
  part twice.

## Decision 2: a walk-in is billed to a house account, not to nobody

An invoice needs a customer, and half a salon's book is people who rang that
morning. Refusing to bill them would be wrong about the trade.

`completeAppointment` falls back to a single `Walk-in` customer per company,
found or created. That is what a shop does on paper too, and a payment at the
counter clears it. Naming the client later is an ordinary edit.

The alternative — allowing an invoice with no customer — recreates the exact bug
this phase exists to close: a document nobody is chasing.

A repair order still refuses. A garage always knows whose car it is, the vehicle
already carries a keeper, and inventing a house account there would hide a data
problem rather than model a real one.

## Decision 3: a gift card settles the invoice, not just the ledger

Phase 29's redemption credited `1100` and left the invoice at its full balance.
Under Phase 29 that was invisible, because there was no invoice. Now it would
be exactly the drift this phase detects, so `redeemGiftCard` reduces the
invoice's balance and closes it in the same transaction.

This surfaced an ordering bug. The idempotency guard — `unique(appointment_id)`
on the redemption row — used to be reached before the "nothing owing" check.
After the fix, the first redemption clears the invoice, so a retried click hit
"that appointment has nothing owing on it" and *threw* where it used to return
quietly. The claim is now checked first: the honest answer to doing something
twice is "it is already done", the same rule Phase 28 established for a
retrying importer.

## Decision 4: the detector is a report, and it lives with the ledger

`controlAccounts` compares each control account against the documents behind
it, for receivables and payables both. It is in `modules/ledger/` rather than in
any industry module, because the property it checks belongs to double-entry
bookkeeping and not to salons.

The two sides are genuinely different in the sense Phase 26 established: the
left is a sum over journal lines, the right a sum over invoice balances, and
neither is derived from the other. Unlike the payout and tips positions, these
two **should** agree exactly — nothing legitimately moves a control account
except a document — so a difference is always a fault, and the report names the
parties so the first question after "they disagree" has an answer.

One caveat is stated in the code rather than hidden: the ledger side is measured
*as at a date* while the subledger side is the balance a document carries
*now*, because invoices keep no history of what they were owed on an arbitrary
past date. An `asOf` in the past therefore differs by anything paid since.
Reconstructing historical document balances means replaying every payment
application, which is a bigger machine than this check justifies.

## The other bug this phase found

`createInvoice` accepts an executor so it can run inside a caller's
transaction — and read the customer through `db` regardless. A function handed
an executor has to use it for its **reads** as well as its writes, or it cannot
see rows the caller created in the same transaction. It had always been wrong
and had never mattered, because every caller passed a customer that was already
committed. The walk-in fallback creates one and invoices it in the same
transaction, and the first test run said `Customer not found`.

## Consequences

- **Both service modules changed their posting shape.** A delivered visit is now
  an invoice entry plus a share entry, and a repair order is an invoice entry
  plus per-part stock entries. Tests asserting the old single-entry shape were
  rewritten to state the new one.
- **An appointment with no client now bills `Walk-in`.** A salon that wants
  named clients has to put them on the booking; nothing forces it.
- **Nothing yet takes money at the counter in one gesture.** Phase 2's
  `recordPayment` can settle these invoices — that was the whole point — but a
  one-press "paid, cash" on the appointment and repair-order screens is not
  built. The gap the last three ADRs named is *closed at the ledger*, not yet at
  the till.
- **`controlAccounts` is not scheduled.** It is a report somebody opens, not a
  check that runs nightly — Phase 24's health surface would be the place, and
  this does not put it there.
- **Historic `asOf` is approximate**, per Decision 4.
- **Opening balances imported through Phase 17** post to AR directly and will
  show as a difference until they are represented as invoices. Named here
  because it is the most likely legitimate-looking failure of this check.

## Follow-up

1. **Take payment at the counter** — one press on the appointment or repair
   order, into undeposited funds, with change handled.
2. **Run `controlAccounts` nightly** in Phase 24's health checks, so drift is
   noticed by somebody rather than waited for.
3. **Represent imported opening balances as invoices**, so the check is clean on
   a migrated company.
4. **The same treatment for other control accounts** — inventory against the
   lot register already has `reconcileInventory`, and the pattern generalises.
