# ADR 0014 — One inventory, five industries

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §5 (Retail, Restaurant, Manufacturing, E-commerce, and
  Wholesale all name inventory first), §13 ("inventory"), §23 (industry
  customization extends the common platform)
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md),
  [ADR 0007](0007-industry-modules-without-forking-the-ledger.md)

## Context

Eight of the ten industry modules were declared and empty. Building all eight
would have produced eight shallow features; the question was which one carries
the most weight.

Inventory does, by a distance. Five of the eight empty modules name it as their
opening capability, and they are **not five features**. A restaurant's food
cost, a wholesaler's warehouse, a manufacturer's raw materials, and an
e-commerce seller's stock are the same perpetual inventory with different words
on the screen — which is exactly what spec §23's "extends the common platform
rather than creating separate products" means when taken literally.

It is also the hardest accounting left in the product. Cost flow is the one
piece of arithmetic where an error is invisible: the books still balance, the
quantities are still right, and the gross margin is quietly wrong for every
period afterwards.

The claim this phase is built around: **the inventory subledger equals the
Inventory account in the ledger, always.**

## Decision 1: the item catalogue is the one that already exists

`service_items` gained `isInventoried` and three companion columns rather than
a parallel `products` table. A business sells a mix of services and things off
a shelf, and the person building an invoice does not think of them as living in
two catalogues.

`isInventoried` defaults to **false**, so every item that existed before this
phase, and every service after it, stays exactly what it was: a description and
a price with no stock behind it.

## Decision 2: a lot carries its value, not a rate to recompute from

This is the important one, and the first implementation got it wrong in a way
that passed twenty-nine of thirty-one tests.

The obvious lot is a quantity and a unit cost, with value derived as
`quantity × cost`. The derivation re-rounds on every read, against a rate that
a pooled consumption never used:

```
  lot A  1.000 @ 100  = 100        pool = 300 over 2.000 units
  lot B  1.000 @ 200  = 200

  weighted-average sale of 1.500 costs round(300 × 1500 / 2000) = 225
  remaining: A empty, B holds 0.500

  recomputed value  = round(500 × 200 / 1000) = 100
  ledger says       = 300 − 225                =  75      ← 25 apart
```

Twenty-five cents, from one ordinary sale. It recurs, it compounds, and nobody
can trace it — which is the profile of the variance that stops a small
business's balance sheet from being signed.

So `remainingValueCents` is stored and authoritative; `unitCostCents` remains
as the rate the stock arrived at, for reading and never for arithmetic. Two
clamps make the identity hold by construction rather than by luck:

- **the last lot touched takes whatever cost is left**, so the parts sum to the
  pooled total instead of the total plus a rounding error;
- **a lot emptied along the way gives up exactly its remaining value**, so no
  lot is ever left holding cents with no units behind them.

A database CHECK enforces that quantity and value empty together.

## Decision 3: lots under both methods

FIFO needs lots; weighted average does not. They are kept either way.

Changing method becomes a setting rather than a data migration, and the lots
remain the audit trail for how a cost was arrived at — which somebody
eventually has to explain to an auditor. "The average was $4.13" is not an
explanation; "these four receipts" is.

The method is **one setting for the company, not one per item.** Mixing them
inside a set of books makes cost of sales unexplainable: an accountant asked
"how is this valued" has to answer "it depends which line", which is not an
answer.

## Decision 4: a purchase order posts nothing

An order is a commitment to buy. No goods have moved and no money is owed.
Systems that post one overstate both inventory and payables for as long as the
supplier takes to ship, which on a slow order is a quarter.

What it buys is the first leg of the three-way match — ordered 100, received
96, billed for 100. Each figure is defensible alone; together they say a
supplier is charging for four units that never arrived. That comparison is the
entire control, and it exists only because all three were recorded separately.

## Decision 5: Goods Received Not Invoiced

Receiving posts `Dr Inventory / Cr Goods Received Not Invoiced` — not to
Accounts Payable, because no supplier has invoiced and a payable no invoice
matches is a payable nobody can reconcile.

Most small systems collapse this and post inventory when the bill arrives. That
is wrong in a specific and expensive way: between the pallet arriving and the
invoice being entered — often weeks — the stock is physically on the shelf and
absent from the books. Sell from it in that window and cost of sales has
nothing to relieve. At a month end it misstates inventory, cost of sales, and
margin simultaneously.

When the supplier's invoice differs from the receipt, the difference stays in
that account as a visible residue. Absorbing it into inventory would change
what stock is carried at, weeks after it arrived, with nothing on any report to
say so.

## Decision 6: the cost posts inside the invoice's transaction

An invoice line naming a stocked item relieves inventory and posts cost of
sales in the invoice's **own** transaction. Doing it afterwards is where a
crash leaves a sale with no cost — overstating margin on every report until
somebody notices.

Two consequences:

- **Selling stock you do not have is recorded, not refused.** A shop that sells
  the last one twice on a busy Saturday has a real problem, and a system that
  refuses to record it teaches people to record something else instead. The
  shortfall is returned so the caller can say so.
- **A return goes back at the cost it left at**, read from a frozen
  `invoice_costings` row. Restoring at today's average invents value out of
  nothing: sell at $4, prices rise, take the return in at $6, and $2 of
  inventory exists with no transaction behind it.

## Decision 7: shrinkage is not cost of sales

A count shortage debits Inventory Shrinkage, not Cost of Goods Sold. Stock that
was sold and stock that went missing are different facts about a business, and
a gross margin quietly containing theft explains nothing to whoever reads it.

A reason is required, for the same purpose as a write-off's: stock that
vanished with no explanation is either theft, breakage, or a counting error,
and which one it is changes what the business should do next. A count that
finds exactly what was expected is still recorded, and posts nothing.

## Consequences

- **Five industry packs now have their opening capability**; three still do
  not. `time_billing`, `pos_import`, `properties`, `funds`, `appointments`, and
  `vehicles` remain declared and empty, and the settings page still lists them
  under "Not built yet" rather than hiding them.
- **There is one stock location.** No warehouses, no bin locations, no
  transfers between them. Wholesale and multi-site retail will want them, and
  the movement table has the shape to carry them.
- **No bill of materials.** Manufacturing's pack gets stock without the ability
  to consume components into a finished good, which is the half of
  manufacturing that makes it manufacturing.
- **Landed cost is not apportioned.** Freight and duty go to their own expense
  accounts rather than into the cost of the stock they arrived with, so margin
  on imported goods is flattered.
- **Attaching a bill to receipts is a service function with no UI.**
  `attachBillToReceipts` clears Goods Received Not Invoiced correctly and
  nothing in the interface calls it yet, so in practice the account is cleared
  by a manual journal entry.
- **A negative stock position values at zero.** Selling into a shortfall
  relieves what exists and no more, so cost of sales is understated until the
  replenishment arrives. Costing the shortfall at the next receipt's price is
  the correct treatment and needs the sale revisited when that receipt lands.
- **Cost method cannot be changed once stock has moved** — nothing prevents it,
  and doing so leaves historic costs computed one way and future ones another.
  A guard belongs here.

## Follow-up

1. **Clear Goods Received Not Invoiced from the bill screen**, so the account
   is worked rather than journalled.
2. **Locations and transfers**, which wholesale and multi-site retail need
   before they can use this.
3. **Landed cost**, apportioning freight and duty across a receipt.
4. **Bills of materials**, which is what would make `manufacturing` real.
5. **Refuse a cost-method change once stock has moved**, or make it an explicit
   revaluation with an entry behind it.
