# ADR 0041 — The document you raise yourself

- **Status:** Accepted
- **Date:** 2026-08-27
- **Context:** Spec §3, §13. Phase 2 built invoices, bills, payments, customers
  and vendors. Nothing since built a way to reach any of them.
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0040](0040-a-bank-account-is-an-account.md),
  [ADR 0011](0011-the-same-books-read-two-ways.md)

## Context

`createInvoice`, `createBill`, `recordPayment`, `createCustomer` and
`createVendor` have been written, posted, audited and tested since Phase 2.
**Not one of them was reachable from a screen.**

Every invoice in the system arrived as a by-product of something else: a won
opportunity, a completed appointment, a repair order finished, a rent schedule
falling due, a progress claim on a job, a recurring arrangement billing its
month. Every one of those is a real path, and none of them is *"bill this
customer for a day's work"*.

So the application could age a receivable, chase it, credit it, write it off,
recover the write-off, put it on a statement, render it as a PDF, apply a
vendor credit against it and reconcile the cash that settled it — for invoices
a business had no way to create. A plumber who signed up, opened a bank account
(Phase 40) and imported a statement (Phase 39) still could not invoice anybody
or record the electricity bill.

Nothing here is new accounting. It is a door onto rooms that were already
built, and the phase is mostly a pure core, some actions and a screen.

## Decision 1: allocation is a decision, and it is made in one place

`recordPayment` requires applications summing **exactly** to the amount —
deliberately, since Phase 2, because a payment that half-lands is worse than
one refused. That pushes a real decision up to the caller: a customer sends
£1,000 against three open invoices and, most of the time, does not say which.

`allocation.ts` answers it, oldest first, and refuses both ways of getting it
wrong:

- **Never past a document's balance.** Over-applying leaves a negative balance,
  an invoice that looks overpaid, and a receivables control account that no
  longer equals the sum of open balances — the exact fault `ledger.receivables`
  exists to catch.
- **Never absorbs the remainder.** What it could not place is handed back. Cash
  recorded against nothing balances the bank and not the customer's statement,
  and nobody finds out until the customer asks why they are still being chased.

An overpayment is therefore **refused with the arithmetic** — *"£999.99 is more
than the £6.50 outstanding; reduce it to £6.50, or raise the document the rest
covers first"* — rather than recorded and left sitting somewhere.

The ordering is total: due date, then issue date, then number. The last is not
decoration. Two invoices raised on one day for one customer are distinguished
by nothing else, and an ordering that flips between runs would make the same
payment settle different invoices each time.

## Decision 2: a written-off invoice is not open

`openDocumentsFor` excludes drafts, paid, void — and **written off**, which is
the interesting one. A written-off invoice is real, owed, and given up on.
Money arriving against it is a *recovery*: Phase 11 built `recoverWriteOff` for
exactly that, and it posts differently because it takes the bad debt back off
the profit and loss. Quietly applying a receipt to it here would make that
decision on somebody's behalf, in the direction that flatters the result.

## Decision 3: the account list is where the invariants get protected

A line has to name an account, and offering the whole chart is how a sale ends
up in Accounts Payable. Income on an invoice, costs and assets on a bill — a
van or a pallet of stock genuinely arrives on a supplier bill, so assets are
offered.

Two kinds are held back even so, because coding a line to one silently breaks
something another part of the system is checking:

- **Accounts maintained elsewhere** — receivables and payables, built from the
  documents underneath them; undeposited funds, moved by a receipt and a
  deposit; accumulated depreciation, owned by the depreciation run and what the
  asset register reconciles to. Each has an integrity check watching it, and
  each would be broken by the tool meant to keep the books straight.
- **Cash.** Every bank and card account has a ledger account of its own since
  Phase 40 and is tied out against its own feed. *"I owe a supplier, and the
  money went into my current account"* is not a thing that happens, and
  recording it puts that tie-out permanently out.

## Decision 4: no default account on a line

The party defaults to the first there is, and the date to today, because both
are nearly always right and wrong in a way somebody notices. The **account does
not**. Coding a sale to whichever revenue account happens to be first is a
quiet mistake that surfaces a quarter later on a profit and loss nobody can
explain, and the cost of making somebody choose is one click.

## The three bugs browser verification caught

**Adding your first customer left the form unable to submit.** `partyId` was
held in state, initialised from `parties[0]` when the list was empty. Adding a
customer from inside the composer refreshed `parties` underneath it — so the
select cheerfully displayed "Harborview LLC" while the state was still `''`,
and *Raise it* stayed disabled under a hint saying a customer was needed. The
party is derived from the list now rather than held.

**A bill line could be coded to Accounts Receivable, or to a bank account.**
Both invariant-breaking, per Decision 3, and neither visible from the code —
the list looked reasonable until it was read on the screen.

**And the fix for that was half a fix.** Excluding cash by "has a
`financial_accounts` row pointing at it" leaves a brand-new company's `1000
Checking Account` on the list, because nobody has opened one against it yet —
which is precisely the company this phase exists for. Cash is cash whether or
not an aggregator knows about it, so the chart's own `subtype` does the work as
well. Written the obvious way that filter then removed **nearly the entire cost
side**: `subtype NOT IN (...)` is *unknown*, not true, when subtype is NULL, and
most expense accounts have no subtype. Caught by a test asserting an ordinary
cost account was still on the list.

## Consequences

- **A draft is not a state anybody can reach.** `createInvoice` posts on
  creation; the composer raises a live document. "Save as draft, send later" is
  a real workflow and it wants the send step Phase 21's PDF snapshot implies.
- **An invoice cannot be edited after it is raised.** Void and re-raise, which
  is correct for a posted document and heavy-handed for a typo caught ten
  seconds later.
- **Tax is a lump figure typed in.** Phase 9 built jurisdictions and codes and
  `createInvoice` accepts `taxLines`; the composer does not offer them, so a
  company using tax codes still cannot reach them from this screen. That is the
  next obvious piece of work here.
- **No line-level job or cost code**, though `DocumentLineInput` carries both.
  A contractor billing against a job still goes through progress billing.
- **The allocation cannot be overridden per document from the screen.** The
  action accepts `documentIds` and honours their order; nothing renders a
  chooser yet, so "this cheque is for 1043" is only reachable through the API.
- **Nothing emails the invoice.** Phase 38 can send mail and Phase 21 can
  render the PDF; joining them to "send this invoice to the customer" is a
  phase, not an afternoon.

## Follow-up

1. **Send an invoice**, joining Phase 21's PDF to Phase 38's transactional
   channel, with the communication recorded on the customer's timeline.
2. **Tax codes on the composer**, so a company that set up jurisdictions in
   Phase 9 can use them where the document is raised.
3. **Choose which document a payment settles**, rendering what the action
   already accepts.
4. **Edit a draft before it posts**, which is the same work as the send step
   and should be decided with it.
