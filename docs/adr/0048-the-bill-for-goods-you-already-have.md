# ADR 0048 — The bill for goods you already have

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §5, §13, §19. Phase 14 built the clearing account and the
  function that clears it. Nothing ever called that function, and the bill that
  would clear the account could not be entered at all.
- **Builds on:** [ADR 0014](0014-inventory-costing.md),
  [ADR 0033](0033-books-that-check-themselves.md),
  [ADR 0047](0047-the-supplier-reference-is-not-our-number.md)

## Context

Receiving stock posts `Dr Inventory / Cr Goods Received Not Invoiced`. The
goods are on the shelf and the money is owed, but not yet to a named supplier
on a named invoice — so `2050` holds it in the meantime. That is right, and it
has worked since Phase 14.

Then the supplier's invoice arrives, and **the bill that clears `2050` could
not be entered.** `documentLineAccounts(ctx, 'vendor')` offers a bill line
`expense | cogs | other_expense | asset`; `2050` is a **liability**, so it was
not on the list. `attachBillToReceipts` — written in Phase 14 for exactly this,
with a doc comment describing the posting — had **no caller anywhere in the
codebase**, and neither did `matchPurchaseOrder`.

The consequence compounds every delivery:

- the bill gets coded to Inventory or an expense instead, so the **cost is
  recognised twice** — once when the goods arrived and once when the paperwork
  did;
- `2050` grows for ever, because nothing in the application can debit it;
- and **no integrity check watched that account**, so nothing said so.

Measured on the demo before this phase: `1400 Inventory` at $28,559.20 and
`2050 Goods Received Not Invoiced` at **$28,700.00** — a clearing account
holding almost the entire value of the stock, which nothing could clear. The
inventory screen displayed that balance, itemised, next to no control at all.

## Decision 1: a caller that may name the account, because it derived it

The rule in `documentLineAccounts` — *"accounts something else maintains, which
nothing may post to by hand"* — is right and stays. Receivables, payables,
undeposited funds and accumulated depreciation all sit behind it, each with a
check watching them.

**This is the something else.** `billReceipts` takes deliveries rather than
accounts: it is handed receipt ids, derives the amount to clear from the
receipts themselves, names `2050` because that is the only account it is
allowed to name, and marks the receipts in the same breath. Nothing in its
signature accepts a chart account.

## Decision 2: what comes out is what went in

`2050` was credited with what the goods were taken into stock at, so that is
the figure that has to come back out for the account to reach zero. The bill's
amount is what the supplier is asking for, and the two are often not the same.

**This corrects Phase 14's stated decision.** `attachBillToReceipts` says the
difference *"stays in that account as a visible residue"*. It is not visible: a
residue in `2050` is **indistinguishable from a delivery nobody has billed**.
Both read as "we owe for goods we have", and nothing can tell three dollars of
price variance from a $3,000 invoice somebody forgot to enter. A clearing
account that cannot be reconciled against a list is a suspense account with a
nicer name — which is precisely how this one reached $28,700 unseen.

So the difference posts to `5450 Purchase Price Variance`, where it belongs: it
is a cost of buying, it is on the profit and loss where somebody will see it,
and `2050` goes back to being exactly the sum of the deliveries nobody has
billed.

## Decision 3: the difference is its own entry

Not a second line on the bill. An undercharge needs a **credit** to variance,
and a bill line is always a debit — `journal_lines_single_side` refuses a
negative one, correctly. A separate entry handles both directions with positive
lines, and is the truer record anyway: the supplier's document says what they
asked for, and the adjustment says what the books did about the difference.

## Decision 4: post the variance, mention it only when it matters

Half a percent. Below that it is a rounded freight charge or a rate that moved
between order and delivery, and a notice on every delivery is one nobody reads
by the end of the week — ADR 0024's rule again. The variance is **posted**
either way; the tolerance decides only whether anybody is told.

## Decision 5: the check that was missing

`inventory.goods_received` compares the sum of unbilled receipts against
`2050`, as a **fault** — receiving credits it and billing debits it, so the two
are the same event seen from either end and a difference is never a timing
artefact.

Deliberately computed the long way round: the left side sums the deliveries
nobody has billed, from `goods_receipts`, rather than deriving both sides from
the ledger. A check that reads the ledger twice agrees with itself and proves
nothing.

Had this check existed in Phase 14, the defect would have shown on the first
delivery instead of on the twenty-eighth thousand dollar.

## Decision 6: choosing a delivery answers Phase 47's question

Found by probing the previous phase against this one. A supplier delivering the
same order twice in a week sends two invoices for the same amount; Phase 47
refuses the second unless somebody says *"it is a different bill"*, and
`billReceipts` had no way to say it. The second delivery could be received and
never billed — putting back the exact balance this phase exists to clear.

`billReceipts` now answers that question by construction. Choosing a *different
delivery* is the answer: these are two bills because they are for two
deliveries, and the deliveries are named on both the bill and the entry. The
rule is not weakened — the same *delivery* still cannot be billed twice, refused
first by the verdict and again by a conditional claim that only fires while the
receipt is unclaimed.

## Consequences

- The cost of stock is recognised once. Inventory is carried at what it was
  taken in at, whatever the invoice said.
- `2050` reconciles to a list of deliveries, and a nightly check says so.
- A supplier quietly repricing between order and delivery shows up on the
  profit and loss rather than disappearing into stock valuation.
- The inventory screen's itemised balance is now something a person can act on
  rather than only read.
- `matchPurchaseOrder` is still uncalled. It compares ordered against received,
  which is a different question from this one and belongs with a purchase-order
  screen that does not exist yet.
