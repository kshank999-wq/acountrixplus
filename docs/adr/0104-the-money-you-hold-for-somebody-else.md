# 0104 — The money you hold for somebody else

**Status:** accepted
**Date:** Phase 104
**Amends:** ADR 0013 (the data export), ADR 0103, whose "what this does not do"
named this.

## The defect

The export answers two of the three questions a set of books has to answer about
money and people:

- **what are we owed** — `invoices.csv`
- **what do we owe suppliers** — `bills.csv`
- **what are we holding that is somebody else's** — nothing

The third is not a smaller question. A retainer is a customer's money sitting in
the company's bank account against work not yet done. A credit note with a
balance is a promise to a named customer. A gift card is a promise to whoever
holds the code. All three are liabilities to people outside the business, and
the export mentions none of them.

The ledger does — as a lump. `journal.csv` will show a liability account with a
balance on it, and that is where the trail stops. An accountant rebuilding these
books somewhere else gets *"Customer retainers: 12,400"* and no way to find out
whose 12,400 it is. **You cannot honour a gift card from a trial balance.**

That is the module's own stated test failing:

> the test this has to pass is not "does it produce a file" but could an
> accountant rebuild these books somewhere else from it

A company that leaves with only these eight files has taken its receivables and
left behind its obligations to named people.

## Decision 1: standing obligations, not completed acts

Three datasets are added — `retainers`, `credit_notes`, `gift_cards` — and one
that looks like it belongs is deliberately left out.

`refunds` is a *completed act*. The money has gone; the row records that it went,
and both the journal and `payments.csv` already carry it. Adding it would put the
same event in a third file and invite somebody to count it twice.

The line is: **does this row represent something the company still owes to
somebody outside it?** A retainer with a balance does. A refund does not. A
credit note that has been fully applied does not, but it is still exported —
see decision 3.

## Decision 2: a gift card has no owner, and the file says so

The other two datasets name a customer. A gift card does not, and this is not a
gap in the schema — it is what a gift card *is*. `gift_cards` has a
`purchaser_customer_id`, which is who paid for it, and the person who will spend
it is whoever holds the code. Those are usually different people and the second
one is unknowable by design.

So the export carries the code and the purchaser, under column names that say
which is which. Leaving the party column blank would read as missing data;
naming the purchaser as though they were the holder would be worse, because it
is a plausible-looking wrong answer.

`gift_cards` also has **no currency column**, having been built in Phase 29
before the currency work began. Every balance is therefore in the company's own
currency by construction, and the file says so — the same treatment
`bank_transactions` got in Phase 103, for the same reason. It is a real
limitation and it is written down in the README rather than papered over.

## Decision 3: spent rows are exported, and the tally counts only what is left

A fully-drawn retainer and a redeemed gift card are exported with a zero
remaining balance rather than filtered out.

Two different readers want two different things. Somebody reconciling the
liability account wants what is **outstanding**. Somebody answering *"was this
card already used?"* — which is the actual support question a gift card
generates — wants the row to exist at all. Filtering serves the first and
silently fails the second.

So every row is exported, and the **manifest tallies the remaining balance**,
not the issued amount. That makes the manifest figure the one that should tie to
the liability account in `journal.csv`, which is the reconciliation an accountant
does first — and a test asserts exactly that correspondence rather than trusting
it.

## Decision 4: one declaration of what a dataset is

`DatasetName`, `DATASETS` and `DATASET_LABELS` were three parallel hand-written
structures. Only one of them was checked: `DATASET_LABELS` is a
`Record<DatasetName, string>`, so it cannot miss an entry. **`DATASETS` is a
plain array and could.**

That is not hypothetical for this phase — it is the exact mistake three new
datasets invite. A dataset added to the union and the labels and the switch, but
forgotten in `DATASETS`, would compile, be selectable by name, and silently never
appear in the default export. The failure is a missing file in somebody's leaving
archive, discovered by its absence.

So the labels record becomes the single declaration: `DatasetName` is
`keyof typeof DATASET_LABELS`, and `DATASETS` is derived from its keys. Three
lists become one, and the switch in `buildDataset` stays exhaustive because
TypeScript already checks that against the union.

## Decision 5: the browser was quietly dropping the last files

Adding three datasets took the export from nine files to twelve, and browser
verification caught what that broke: **ten arrived.** The notice said twelve, the
server recorded all eleven datasets and 375 rows, and `gift_cards.csv` and
`manifest.csv` reached nowhere.

The cause is one line. `runExport` created an object URL per file and called
`URL.revokeObjectURL(url)` on the line after `anchor.click()`. A download is
asynchronous, so revoking synchronously races the browser's fetch of the blob —
a race it won with eight files and stopped winning at twelve. The anchor is now
put in the document, and the URL released after the browser has had a turn.

Two things about this are worth keeping. The first is that **it was silent**:
nothing failed, the count came from `result.files.length` rather than from what
was actually delivered, so the message was a statement about intent. It now
counts what it saved. The second is that this had been latent since Phase 13 and
was invisible until the file count grew — the failure was never in the code that
changed, and no unit test could have found it, because the thing that broke was
the browser's behaviour and not the program's.

## Decision 6: an empty file and a file with no money are different

`summarise` returned *"holds no money columns"* whenever a file had no currency
tallies, and an empty `gift_cards.csv` has four money columns and no rows. Both
produced the same sentence, which told the reader of an empty file something
untrue about the shape of their own data.

Introduced in Phase 103 and found here only because this phase was the first to
add a dataset that could be legitimately empty. The tallies are now `null` for a
file with no money concept and `[]` for one with money and no rows, and the
manifest says which.

## What this does not do

**It does not export lease deposits.** Phase 23 holds tenant deposits as
somebody else's money too, and they are the same shape of obligation. They live
in the properties module with their own model, and giving them a dataset means
deciding what a leaving landlord needs — the deposit, the unit, the tenant, the
protection scheme reference — which is a property question rather than an export
one.

**It does not reconcile the manifest to the ledger at export time.** The test
asserts the correspondence; the export does not check itself and refuse to
produce a file when it fails. A leaving company should get its data even when
something does not tie, and being told what does not tie is the integrity
register's job (Phase 33), not this one's.
