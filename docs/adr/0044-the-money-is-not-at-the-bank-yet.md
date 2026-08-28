# ADR 0044 — The money is not at the bank yet

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §3, §19. Phase 42 got the invoice to the customer and
  Phase 43 reminded them. Neither gave them a way to pay.
- **Builds on:** [ADR 0042](0042-what-the-customer-opens-is-the-ledger.md),
  [ADR 0040](0040-a-bank-account-is-an-account.md),
  [ADR 0002](0002-double-entry-ledger.md)

## Context

Four phases built a path: open a bank account, raise an invoice, send it, chase
it. At the end of it a customer opens a link, reads what they owe, and has no
way to hand over the money. ADR 0042's fourth follow-up said so: *"Pay from the
page. The link is the natural place for it."*

The chart of accounts had been saying it for longer. **`6850 Merchant and
Processing Fees` has been in the standard chart since Phase 0 and used by
nothing** — an account describing a feature that did not exist.

## Decision 1: three entries, because there are three events

The obvious entry for a $1,000 card payment is `Dr Bank / Cr Accounts
Receivable`, and it is wrong twice.

**The amount is wrong.** The processor keeps a fee; $970.70 arrives. Booking
the gross overstates cash and hides a real operating expense that never reaches
the profit and loss, so the business cannot know what card acceptance costs
them.

**The date and the shape are wrong.** The money is at the processor on Tuesday
and arrives on Friday, *batched* with eleven other payments as one deposit. The
statement has one line for $8,431.15; the ledger, posted the obvious way, has
twelve lines on three days. Phase 40's tie-out fails and cannot be made to
pass, because the two sides genuinely do not correspond.

So `1250 Payments in Transit`, and three entries:

```
capture   Dr Payments in Transit 1,000.00   Cr Accounts Receivable 1,000.00
fee       Dr Merchant Fees          29.30   Cr Payments in Transit    29.30
payout    Dr Checking            8,431.15   Cr Payments in Transit 8,431.15
```

**Not Undeposited Funds**, deliberately. That is cash in hand waiting to be
walked to the bank, and Phase 12's deposit screen offers to bank it. Money at a
processor is neither in hand nor bankable — it arrives on its own, net, in a
batch — and summing the two would offer to deposit money already on its way.

## Decision 2: the gross settles the debt

The customer paid what they were asked for. The fee is a cost the business
chose by accepting a card, and charging it back to the customer's balance would
leave every card-paid invoice showing 29 dollars outstanding for ever.

The three numbers are also derived rather than each computed: `net = gross −
fee`, always, so no rounding rule anywhere can strand a penny in a clearing
account that then never reaches zero. A test walks every amount from 0 to
$50 and asserts they add up.

## Decision 3: no card data ever touches this application

`createCheckout` returns a **URL**, not a form. The customer goes to the
processor's own page. That is not only convenience: a payment form served from
here would put this application in PCI DSS scope, which is a different product
with a different budget, and spec §19 requires a security review before payment
features go to production.

The mock's stand-in page says so out loud rather than dressing itself as a card
form, which would teach somebody the wrong thing about where their card number
goes. And `confirmMockPaymentAction` — the only endpoint that can mark a
payment succeeded without a processor saying so — **refuses to run at all**
once a real adapter is configured. It would otherwise be the most dangerous
thing in the codebase.

## Decision 4: the database stops the double payment

A customer double-clicking Pay is the ordinary case. `checkouts.payment_id` is
unique, and claiming a checkout is a conditional update that only fires while
it is still `pending` — two requests race, one wins the row, the loser reads
back what already happened and reports it as success, because from the
customer's point of view nothing is wrong: they paid.

Three things can settle a checkout — the browser returning, a webhook, a sweep
— and all three racing is the expected case, not the exceptional one.

Failed attempts are kept. *"The customer tried three times on Friday and the
card was declined"* is the most useful thing a business can know about an
unpaid invoice, and it is invisible if only successes are stored.

## Decision 5: the clearing account is checkable, and that is the point

Nothing posts to `1250` except the three entries above, so a difference is
never a timing artefact — which is why `payments.in_transit` is a **fault**
where Phase 40's bank tie-out is a position. A difference means a fee posted
without a capture, a payout that swept a checkout it did not settle, or the
expensive one: a payment the customer made that never reached these books.

Posting card money straight to the bank would have thrown that away. There
would be nothing to check it against.

## The defect browser verification caught

**The deposit posted two days before it arrived.** The mock announced a batch
arriving on the 30th and `importPayouts` posted it on the 28th, so the bank
ledger showed $23,303.70 the business did not have — the exact error this whole
phase exists to prevent, committed at the last step instead of the first.

A processor announces a batch before it lands, `pending`, with an arrival date
a day or two out. An unarrived batch is now left alone: the money stays in
`1250`, which is the truthful place for it, and the next run picks the batch up
on the day it lands. The mock was made self-consistent too — it reports a batch
it is paying out *now* as arriving now, and the settlement delay it models is
the one that matters, money sitting at the processor until a payout exists at
all.

Every unit test passed while this was broken, because each of them asked about
balances rather than dates.

## Consequences

- **No refunds.** A refund is a real thing a business needs and this phase has
  nothing for it: no reversing entry, no effect on the clearing account, and a
  payout that nets one off reports as a discrepancy rather than explaining
  itself.
- **No webhooks.** Settlement depends on the customer's browser returning or on
  somebody pressing "check for deposits". A customer who closes the tab leaves
  a payment captured at the processor and unposted here — visible in the
  integrity check, which is where it will be found, rather than automatically.
- **The fee is estimated until the processor says otherwise.** The company's
  own schedule is used at capture and the reported fee wins when there is one.
  A schedule that does not match the processor's actual pricing shows up as a
  payout discrepancy rather than silently mis-stating the expense.
- **One currency per payout.** A processor settling euro and dollar payments
  into separate batches works; one that nets them does not, and the
  reconciliation would report the difference rather than converting.
- **`1250` is not cash on the statement of cash flows.** It is an operating
  asset, so the payout appears as an operating inflow when the money actually
  arrives. That is right, and it means the cash flow statement does not claim
  the business has money that is still at the processor.
- **No per-invoice control.** Card payments are on or off for the whole
  company; there is no way to accept a card on one invoice and not another.

## Follow-up

1. **Refunds**, including what they do to a payout that nets one off.
2. **Consume provider webhooks**, so a payment settles without the customer's
   browser having to make it back.
3. **A sweep for stranded captures** — anything claimed and unposted, or
   succeeded at the processor and never seen here.
4. **Reconcile the payout against the bank feed**, closing the loop Phase 40
   opened: the deposit is now one row, so it can be matched to one statement
   line automatically.
