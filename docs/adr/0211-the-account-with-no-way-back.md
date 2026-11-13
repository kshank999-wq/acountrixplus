# 0211 — The account with no way back

**Status:** accepted
**Date:** 2026-11-13
**Phase:** 211

---

## The nomination, measured — and dropped

ADR 0210 nominated **the stock nobody received**: `bill_lines.item_id` has no
writer, so a stocked item *bought* through a bill receives no stock, where
Phase 169 had built the picker for the same column on the sales side. It was
nominated with one instruction attached: *"the question of whether a bill line
or a `goods_receipts` receipt line is the right place to record what arrived has
to be answered first. That answer is the phase."*

**It is the receipt line, and it was built in Phase 14.** `receiveGoods` takes
a vendor, a date and lines; it needs no purchase order; and each line writes
`goods_receipt_lines.item_id`, a lot, a unit cost and a stock movement, and
posts `Dr Inventory / Cr Goods Received Not Invoiced`. The supplier's bill then
*clears* the delivery through `billReceipts` and names no item, because by the
time it arrives the stock is already on the books at what it cost.

So a picker on a bill line would have been a second way to receive stock — two
answers to the one question an inventory subledger exists to answer. And the
column itself turned out to be Phase 49's shape rather than Phase 169's:
**nothing ever wrote it and nothing ever read it.** Both inserts omit it, and
the one query that fetches these rows is a projectionless `select()` whose
mapper names six columns, none of them this. It came from Phase 14 as a copy of
`invoice_lines.item_id` with the invoice's docstring copied along with it —
*"the catalogue item **sold**… which is what tells the invoice to relieve
inventory"* — on the payables side, where nothing is sold and no invoice is
being raised.

It is dropped. Migration `0104`. The composer's own comment claimed
`inventory/purchasing` *"already sets it from a purchase order"*; nothing set
it, ever, and that sentence is now the argument for why the column is gone.

## The question that answer raised

If the bill is not where stock arrives, what happens today when a business buys
stock and codes the supplier's bill to Inventory? Because the composer offers
`1400`, and says so in its own docstring:

> An invoice line is income; a bill line is a cost or something bought — a
> supplier bill for a van legitimately debits Fixed Assets, and **one for stock
> debits Inventory**, so assets are offered.
>
> **Two kinds of account are held back even so**, because coding a line to one
> silently breaks an invariant something else is checking…

The second paragraph is the rule. The first is its exception, two sentences
earlier, in the same docstring.

**Measured.** Every account `documentLineAccounts` offers on a bill line, coded
one at a time onto a $1,000 bill, with all nineteen integrity checks run after
each:

```
  1250 Payments in Transit   ->  payments.in_transit   fault   0 vs 100000
  1400 Inventory             ->  inventory.lots        fault   0 vs 100000
  1450 Work in Process       ->  manufacturing.wip     fault   0 vs 100000
  1500 Fixed Assets          ->  assets.register       fault   0 vs 4000000
```

The invoice side broke nothing: it offers revenue only.

## The control, and what makes it one

Four faults, and one of them is not a defect. The symptom is identical; the
difference is whether the application has a way back.

```
  bill a truck to 1500           assets.register   disagrees   0 / 4000000
  register the asset             assets.register   agrees      4000000 / 4000000

  bill timber to 1400            inventory.lots    disagrees   0 / 1000000
  receive the same goods         inventory.lots    disagrees   1000000 / 2000000
```

A bill line **is** the intended way to capitalise an asset.
`RegisterAssetInput` says so: `postAcquisitionCreditAccountId` is *"left unset
for the normal case, where a supplier bill already coded the cost to Fixed
Assets and posting it again would put the truck on the balance sheet twice"*. So
that fault is a to-do with one action behind it, and `assets.register`'s own
`meaning` names the action: *"an asset was capitalised without being
registered."*

Stock has no adoption step, because `receiveStock` posts the debit itself.
**Doing the right thing afterwards doubles the difference.** The only way back
is a hand-written journal entry — which is exactly the act `FALSIFIERS` records
as the one thing that breaks the check.

Without `1500` in the measurement this would read as *a fault-severity check can
be broken from a dropdown*, and the honest finding is narrower and sharper: of
the four accounts that can be, three have no way back and one is the intended
path.

## The two lists that answered one question differently

The class was already written down twice, by two files that each needed it.

- **`documentLineAccounts`** held back four — `1100`, `2000`, `1200`, `1510` —
  in a bare array under the rule quoted above.
- **`receipt-credit.ts`'s `CONTROL_ACCOUNTS`** held back two — `1100`, `2000` —
  under the heading *"the accounts whose balance must equal the documents behind
  them"*, having argued at length that what it excluded was *"a single,
  **statable** class"*.

It is statable. Measured against `FALSIFIERS` — the register that already
records, per check, that the one act which breaks it is *"post a manual journal
entry against `<account>`"* — **the class has fifteen members with a check
watching them** — eighteen, counting the two more a check reconciles without
naming them in its falsifier and the one clearing account nothing watches at
all. Between them the two lists named **four**, and three of the gaps were
reachable from the bill composer's account dropdown, needing no journal screen
and no accountant.

Two answers to one question is the defect this project keeps finding. Here it
cost three findings, and the reason neither list caught them is visible in both:
each was written for its own call site, by a phase that was right about the two
or four accounts in front of it.

## What each account was protected by

Of the eighteen accounts a check or a composer rule has an opinion about:

| protected by | count | which |
| --- | --- | --- |
| the composer's own list | 4 | 1100 2000 1200 1510 |
| the cash-and-bank subtype filter | 2 | 1000 (every bank account) 1060 |
| the liability type filter | 8 | 2050 2310 2320 2500 2520 2550 2580 2590 |
| nothing | 3 | 1250 1400 1450 |
| offered on purpose | 1 | 1500 |

**Eight were safe only because a bill line may not name a liability** — a filter
written to decide what a *cost* is, not to protect a clearing account. It holds
today and nothing recorded that eight fault-severity checks depend on it, so
adding `liability` to the bill side's `wanted` types for one honest reason (a
bill for a loan repayment) would reach eight faults at once. `receipt-billing.ts`
already said *"`documentLineAccounts` deliberately refuses to offer `2050`"*,
which was true and had nothing behind it: `2050` was kept off the list by the
type filter, not by the rule the sentence states.

A third membership of the same class exists and is the only complete one:
`categorizableAccounts` offers the bank feed revenue, cost and expense accounts
only, so no watched account can be reached from a categorisation. Complete by
accident, and now pinned by a test so that widening it fails loudly.

## What was built

**`coa/maintained.ts`**, one register of eighteen entries, each carrying what
maintains the account, which check watches it, what to do instead, and — the
part that matters — **what it is protected by other than this register**,
because an incidental protection is one a future change removes without
noticing.

It answers **per act**, not with one flag. A single flag would have been wrong
in both directions: `2050` is exactly what a goods receipt must credit and
exactly what a person must never type, and `1450` is what a finished
manufacturing run credits through `receiveStock` and what no bill line should
name. The disagreement is now written down instead of living in two files.

Read in three places:

- `documentLineAccounts` filters the picker by it, resolved to ids per company;
- `createBill` and `createInvoice` **refuse** a line that names one, because a
  dropdown is cosmetic and the service takes a `chartAccountId` from whatever
  built the payload (Phase 116, one level above the database);
- `creditableByReceipt` is now a reader of it rather than the owner of a
  two-member copy.

`billReceipts` says which authority it is using — `actingAs:
'receipt_clearance'`, the register's one named act — and a source assertion
keeps it the only caller that does.

## The membership that is not a list of numbers

`reconcileInventory` compares the lots against `1400` **and every account an
item names for itself**, which is how Phase 27's manufacturer keeps raw
materials on `1440` and finished goods on `1460` with nothing on `1400`. So the
refusal cannot be four numbers:

- the chart's own `subtype` of `inventory` catches the accounts this chart ships
  and anything a company adds, and
- `stockCarryingAccountIds` — lifted out of `reconcileInventory` so the
  composer and the reconciliation read **one function** — catches the rest,
  because `setItemPostingAccounts` deliberately does not type-check the choice:
  *"the accounts are not validated by type here."*

Measured: filing a stocked item's inventory account as `1300 Prepaid Expenses`
takes `1300` off the bill composer and makes a bill line coded to it refuse,
which no number and no subtype could have done.

## The licence the measurement missed, and what that says about the measurement

`MaintainingAct` was written with one member and this sentence: *"one member. A
second would mean a second entry point had been given the same licence, which is
worth having to write down."* The suite produced one before the phase was over.

`billProposalStage` and the conversion that raises a won proposal's deposit both
raise an **invoice credited to the retainer account** — `2550`, or `2500` where
the pack installed no `2550` — because money taken before the work is not
revenue, and crediting revenue for it would recognise income nobody has earned.
That is `billReceipts`' shape exactly, and the register now names it
`deposit_billing`.

**The interesting part is why the measurement missed it.** Both censuses asked
what the *pickers* offer: the bill side offers no liability, the invoice side
offers revenue only, and the invoice side therefore measured clean. **Nine
modules raise documents with accounts they choose themselves, and the picker is
involved in none of them.** A guard measured against the dropdown it backs is
measured against the wrong thing — which is also the argument for the guard
existing at all. If the composer were the only writer of a document line, the
picker would have been enough, and the twelve failing tests in
`progress-billing-from-a-contract` are what a measurement of the picker cannot
tell you.

## Two things the measurement caught that reading would not have

**The register refused nothing by number for about ten minutes.** The licence
test was written as `entry.documentLineAllowedFor === options.actingAs`, and
with both sides normally `undefined` that is a licence for every entry naming no
act. The subtype rule went on working, so the failure was silent in the
direction that mattered and loud in another: `1100`, `1200` and `1510` came
*back* onto the bill composer's list after eighty phases off it, which is the
only reason it was caught at once. The fourth of that list, `2000`, stayed off
throughout — because a bill line may not name a liability. For those ten
minutes the incidental protection was the only thing working, which is a better
argument for writing it down than the one in this ADR. The comment stays where the bug was.

**The guard accepted an account the picker refused.** Written as a correlated
`exists` on the same row, `si.inventory_account_id = ${chartAccounts.id}`
rendered the outer column unqualified, so `id` resolved against the subquery's
own table and compared each item's primary key with its inventory account —
always false. It is now a second query reading `stockCarryingAccountIds`, which
is also the answer to the general problem: there is no third derivation of the
set to be wrong.

## What else was corrected in passing

`assets.register` declared that it compares *"Σ register cost and depreciation
against 1500 and **1590**"*. Accumulated depreciation has been `1510` since the
first chart was written. Phase 179's shape — a number in prose that nothing
reads is a number nothing corrects — so every account number in every check's
`compares` string is now asserted to exist in some chart.

## What this does not do

**It does not guard a journal entry.** A manual entry at `1400` is still
accepted, and should be: it is a deliberate act by somebody who can read a trial
balance, and `FALSIFIERS` depends on it being possible. The composer is the
everyday screen, which is the whole difference.

**It does not repair books that already hold such a line.** A posted entry is a
fact (ADR 0021). The checks go on reporting it, which is what they are for, and
the refusal stops the next one.

**It does not settle stock bought outright.** `1000` is the one entry where a
receipt may credit what a document line may not, because `receiveStock`'s
parameter exists for it and `banking.cash_tie_out` is a *position* precisely
because money legitimately reaches a bank ledger account without a feed row.
The real tension — that the feed row for that purchase, when it arrives, is
categorised by a person who could post the cost a second time — is recorded in
the register's entry and is a phase about the bank feed, not about a list.

**It does not give `1200` a check.** Nothing watches undeposited funds. That is
the one `watchedBy: null` in the register, declared rather than left to be
found, and it is Phase 48's shape: a clearing account with no check on it.

## What moved

The column census is **95 candidates and 13 findings over 15 columns**, across
**2,176 columns and 185 tables** — one column fewer in every figure, because
`bill_lines.item_id` was dropped rather than filled. The isolation census is
**304 writes and 977 reads**, the two new reads being the chart the composer
filters and the chart the bill service re-reads behind it, both `scoped()`.

One migration, `0104`, dropping one column. No new audit action, no new record
kind: nothing in this phase had to say *not that one* about anything new.

## What the full run found, and the key that guarded nothing

Two census assertions moved that this phase's own targeted runs could not have
reached, both about the dropped column and both found only by running the whole
tree — ADR 0178's prediction, for the fourth time in this programme.

`the-id-a-caller-hands-in` counts every foreign key between tenant-scoped
tables: **294 and 39**, down from 295 and 40. This is the first entry in that
running tally that falls, and it falls in **both** figures. Had only the total
fallen, the share carrying the tenant would have improved by subtraction — 40 of
294 reads better than 40 of 295 — and a tally that can only rise reads like
progress whether any was made or not.

`one-name-and-two-references` asserted that `item_id` was constrained on
*both* invoice and bill lines. That is the uncomfortable part of this phase and
it belongs in the record rather than only in the test: **Phase 169 put a foreign
key on `bill_lines.item_id`, Phase 170 made that key composite so it could not
name another tenant's item, and both phases were protecting a column that was
always empty.** Forty-one phases of green on that assertion was never evidence
the protection did anything.

So the assertion is no longer a list of two tables. It measures every column in
the schema named `item_id` or `service_item_id` and insists each one is a foreign
key into `service_items` — the claim the two-table version was standing in for
and could not make — and then names the twelve exactly, so that a key
*disappearing* fails as loudly as a thirteenth arriving unkeyed.

## Nominated for Phase 212

**The job that cannot be finished.**

`projects.end_date` has no writer, and `projects.notes` with it. A job can be
created, billed, have its retainage held and its costs coded, and there is no
way to say it is over. The column is read — the register's entry for it names
what reads it — so this is not Phase 49's shape and a migration is not the
answer.

Its measurement is deliberately undone, and the thing to measure is the same
thing this phase had to measure: **what else is a finished job supposed to
mean?** A job with an end date is presumably out of the picker on a new
timesheet, absent from the open-jobs list, and possibly refused new costs — and
each of those is a reader that either exists and ignores the column or does not
exist at all. On this run's record the nomination is still the least reliable
part of a phase: three in a row have changed under measurement, and ADR 0210's
was answered by **dropping** the column it was about.

Behind that: the remaining findings, of which the four `notes` columns and the
two `journal_entry_id` columns are the substantial ones; the CRM account panel's
missing payables side (ADR 0208); the four joins from an unscoped primary (ADR
0198); and §11's six remaining functions.
