# ADR 0052 — The payment you cannot take back

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §16, §19. There was no way to void a payment at all,
  and Phase 51's refusal pointed at the button that did not exist.
- **Builds on:** [ADR 0031](0031-the-control-accounts-against-the-documents.md),
  [ADR 0041](0041-the-document-you-raise-yourself.md),
  [ADR 0049](0049-what-you-owe-and-choosing-what-to-pay.md),
  [ADR 0051](0051-the-entry-you-cannot-correct.md)

## Context

Not a function with no caller. Not a screen missing a button. **Nothing at
all** — no status column on `payments`, no service function, no action.

`recordPayment` has existed since Phase 2. Phase 41 made it reachable, Phase 44
gave it a card path, Phase 49 turned it into a batch that pays several suppliers
in one click. A receipt keyed as $1,500 instead of $150, or a pay run aimed at
the wrong supplier, was **permanent**: the document showed settled, the bank
showed the money gone, and the only move left was a hand-posted journal entry
that fixes the ledger and leaves the invoice still claiming to be paid.

Phase 51 then closed the last bad door — you may no longer void the ledger half
of a payment from the journal screen, because doing so would break the agreement
between subledger and ledger that ADR 0031 proves. Its refusal reads *"Void the
payment that produced it"*, and pointed at nothing. This is the other end of
that sentence.

Payments were also never **listed** anywhere. Recorded from the invoices screen
and the payables screen, then gone into balances — *"did that $1,500 go in
twice?"* was a question with no screen behind it.

## The costly wrong answer

Not "a wrong payment stayed on the books". It is **unwinding a payment whose
money somebody else has already counted.**

A receipt banked on a deposit, counted into a till at the end of a shift, or
settled by a card processor is money a second record already claims. Putting it
back silently leaves a deposit that no longer adds up, a shift count somebody
signed that no longer matches, or a processor payout with nothing behind it —
and the person who finds out is whoever reconciles the bank next month.

So most of `payment-void.ts` is refusals, and each one names the record that has
the money now.

## Decision 1: four refusals, ordered by whose record it is

1. **Banked on a deposit** — void that deposit and bank the rest again.
2. **Counted into a closed shift** — a count somebody signed cannot become
   retrospectively untrue; post an adjustment instead.
3. **Settled at the card processor** — the money really did arrive; refund it
   through the processor.
4. **A document it settled has since been voided** — restoring the balance would
   leave a cancelled document claiming to be owed.

The order is deliberate. A deposit outranks a closed period even when both are
true, because *"the bank has this money"* is the more useful thing to be told
first.

## Decision 2: the ledger unwinds by Phase 51's rule

Voided when the payment is in an open period, **reversed** when it is in a
closed one — applied here rather than re-decided, so there is one answer in the
codebase to "how does a correction reach a period somebody has reported on".

Reached through `voidJournalEntry`, the **internal** path, inside the same
transaction. `voidEntry` — the person-initiated one — now refuses an entry that
belongs to a document, and a payment's entry is one of those. That refusal is
Phase 51's guard working, not an obstacle to route around.

## Decision 3: the applications stay, and every reader excludes them

`payment_applications` is the record of what the payment settled. Deleting those
rows would leave a void payment stating an amount with nothing saying where it
went.

So they stay, and **eight query sites** now exclude void payments:

- **cash-basis reporting** — the worst place for a void to be forgotten. It
  reads applications to link cash to the revenue accounts on the document it
  paid, so a voided receipt left in place reports revenue never received.
- **1099 contractor reporting** — a figure filed with a tax authority.
- **customer statements** — a statement showing a payment that was taken back is
  one the customer can disprove.
- **the chase run** — a voided payment bought no quiet; the invoice is owed
  again and the chase should resume.
- **undeposited funds** — never offer to bank money that was taken back.
- **deposit creation**, and **two drawer-takings sums**.

`payments_company_status_idx` is what makes that cheap.

## Decision 4: a reason is required

A void with no reason is a hole somebody has to reconstruct from dates six
months later. `voidPayment` refuses a blank one, the reason shows on the row,
and it goes into the audit log alongside what was restored.

## Decision 5: what a document goes back to

`open` when the whole of it is owed again, `partial` when something else has
also been paid against it — and **never back to `draft`**. A document that was
issued and part-paid was still issued, and rewinding it to draft would take it
off the aging report a business works from every Friday.

The functional balance is recomputed from the restored balance at the document's
own rate rather than added back application by application, because
`payment_applications` stores the amount in the *document's* currency and never
the functional amount that was relieved. Converting the restored balance at the
rate the document was raised at is the same arithmetic that set it originally.

## What the browser found

**The refusal named an operation that does not exist.** Its first draft read
*"take it off the deposit first"*, and there is no such thing: a deposit is
voided whole, which is what the Deposits screen offers, and its receipts go back
to waiting to be banked. That is precisely the defect Phase 51 shipped and this
phase existed to fix — advice pointing at a button nobody has — and it was found
by following the sentence in the browser rather than by reading it. Now it names
the screen and the actual operation.

The rest held up. Taking back a $5,040 cheque gave *"INV-1008 is owed again. The
ledger entry is void with it"*, the invoice went from `paid` to `partial` at
$5,040 outstanding, its journal entry read `void`, the received total dropped by
exactly that amount — and the AR control account still equalled the sum of open
invoice functional balances to the cent (5,560,469 both sides). Banking a
receipt turned its row from "Take it back" to "cannot be undone" with the
deposit named.

A second false alarm worth recording: my first tie-out compared `balance_cents`
against the control account and was out by $208.75. The books were right; the
comparison was wrong, because a euro invoice's `balance_cents` is in euros while
the control account holds functional currency. Comparing
`functional_balance_cents` agreed exactly.

## Consequences

- `payments` carries `status`, `voided_at`, `voided_by`, `void_reason`.
- **Money in and out** is a screen, fourth in the accounting nav.
- `payment.void` joins the audit actions.
- `voided_by` is deliberately **not** a foreign key to `users`, matching what
  Phase 50 did for `bills.approved_by`: the person can leave the company and
  their row can go, and the fact that they voided a $1,500 receipt in March must
  not go with it. A `SET NULL` there would erase the thing the column exists for.

## What this does not do

It does not void a **deposit item** — only whole deposits, which is what the
Deposits screen already offers. Removing one receipt from a banked deposit and
leaving the rest is a real thing businesses do, and it is a different phase.

It also does not offer a **refund**, which is the other half of taking money
back: a void says the payment never happened, and a refund says it happened and
then went the other way. Conflating them would let somebody erase a receipt the
customer's bank statement still shows.
