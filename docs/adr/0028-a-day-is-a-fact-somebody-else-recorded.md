# ADR 0028 — A day is a fact somebody else recorded

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §5 ("Restaurant and Food Service — **POS imports, tips,
  daily sales summaries**" and "E-commerce — **marketplace/payment processor
  feeds, fees, returns**"), §13, §23
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0023](0023-somebody-elses-money.md),
  [ADR 0026](0026-a-restriction-is-the-donors-not-the-charitys.md)

## Context

`pos_import` has been a declared industry module since Phase 0, switched on by
the restaurant and e-commerce packs, doing nothing. This phase makes it real,
and it is the first module to serve **two** of §5's fourteen rows.

That is the whole argument for building it this way. A restaurant's Z-report and
a marketplace's settlement file look nothing alike on paper — one has tips and a
cash drawer, the other has commission and returns — but they are the same fact:
*a day of trading happened inside somebody else's system, and it has to become
double-entry here.* Building "POS import" and "marketplace feed" as separate
features would have produced two modules that both take a summary, both split it
into revenue and tender, and both have to be right about fees. ADR 0007 said
industry modules extend the common platform rather than forking it; this is that
rule applied one level up, to two industries at once.

Five claims, asserted in `tests/pos.test.ts`:

1. **A day's takings are one journal entry**, not one per sale.
2. **Revenue is the gross**, never the deposit.
3. **Tips are somebody else's money**, and appear on no profit and loss.
4. **The till is counted, and the difference is named.**
5. **A day imported twice is imported once.**

## Decision 1: the unit of import is a day, not a transaction

A café serving four hundred covers produces four hundred sales and one useful
accounting fact. Importing the four hundred would give a general ledger nobody
can read, a reconciliation nobody can perform, and — because a POS export is not
a system of record — a false promise that the detail is trustworthy.

So the row is `pos_days`, one per company per business date per source, and the
entry is one entry. The per-category and per-tender lines are stored
(`pos_day_categories`, `pos_day_tenders`) because somebody opening a day wants
to see what it was made of, but they are evidence of what the source said, not
postings.

The `business_date` is the trading day, which is deliberately not the calendar
day. A bar closing at 2am books Friday's takings to Friday.

## Decision 2: the claim row goes in before the entry

`pos_days` carries `unique(company_id, business_date, source)` and the insert
uses `onConflictDoNothing`, before anything is posted — the same ordering
Phase 23 used for a rent charge and Phase 26 for a fund release. Where two
people (or a scheduled importer and a person) can act at once, the database
arbitrates. An entry posted first would survive the claim being refused, which
is exactly how a nightly job that retries doubles a restaurant's revenue.

`tests/pos.test.ts` races two importers with `Promise.all` and asserts exactly
one of them created the day.

## Decision 3: a second import is not an error

`importDay` returns `{ created: false }` with the row that is already there,
rather than throwing. This is a departure from the other idempotent operations
in the application, which raise.

The reason is who calls it. A rent run is invoked by a person who wants to know
that they already did it. A POS import is invoked by a machine, nightly,
retrying on failure — and a retry that produces an exception produces an alert,
a dead job, and eventually somebody who turns the alerting off. The honest
answer to "import Tuesday" when Tuesday is already in is "Tuesday is already
in", not an error.

## Decision 4: gross, not net — the fee is a separate line

The clearing account is debited at the **net** deposit and the fee is debited
separately, so the credit side still carries the full gross:

```
  Dr Payment Processor Clearing   282.00 − 42.30
  Dr Marketplace and Platform Fees         42.30
      Cr Food Sales                                282.00 (less tax, tips)
```

Booking the deposit instead loses two facts at once — the sales figure is
understated and the cost of selling is invisible — and it is the single
commonest reason a small e-commerce business ends up with a profit and loss that
reconciles to nothing. It is also nearly impossible to detect afterwards,
because the books still balance.

The fee is recorded **per tender** rather than as one figure for the day, so a
business taking card at 1.6% and a delivery platform at 15% can see which one is
expensive. The seed shows exactly that contrast.

## Decision 5: tips are a liability from the moment they are taken

Money collected from a customer on a member of staff's behalf was never the
restaurant's. It is credited to `2310 Tips Payable` and touches no revenue
account, so it appears on no profit and loss — asserted directly, by running the
P&L and checking the total is the sales figure and not the sales figure plus the
tips.

This is ADR 0023's rule — a security deposit is the tenant's money and a
landlord who spends it has borrowed it — applied to a different industry. The
recurrence is the point: "whose money is this" is an accounting question, not a
property question or a restaurant question.

## Decision 6: the till is counted, and the difference is named

Two numbers exist at the end of a shift: what the register says it took, and
what is in the drawer. Cash is banked at **what was counted**, and the
difference goes to `6870 Cash Over and Short`.

A summary that quietly adjusts the cash figure to match the register balances
perfectly and hides theft. A running balance near zero on 6870 is a well-run
till; a drifting one is a question somebody should be asked.

`counted_cash_cents` is nullable, and null means *nobody counted* — which is a
real and common state, and is not the same as counting and finding it exact. A
null produces no over/short line at all. A zero produces none either, but for a
reason somebody can point at.

The float is subtracted before the comparison: it was in the drawer yesterday
and will be there tomorrow, so it is not takings.

## Decision 7: when the source contradicts itself, name it — do not refuse it

A POS export whose tenders do not equal its sales plus tax plus tips is
internally inconsistent. That is a fact about the export, not about the
business.

The first implementation refused such a day outright, on the reasoning that *a
plug is a lie that balances*. That was wrong, and the test written to describe
the desired behaviour is what surfaced it. An entry has to balance, so the
choice is never "plug or don't" — it is **which account absorbs the
difference**, and the only dishonest answers are the ones that hide it inside
cash or revenue. Refusing is not a third option, it is the worst one: a
restaurant whose till software is out by 5p could not record that it traded at
all, and what happens next in the real world is that somebody keys the day in by
hand and the discrepancy disappears without ever being seen.

So the day posts, the difference goes to `1220 POS Import Suspense`, and
`out_of_balance_cents` is on the row and on the screen. A suspense account says
"this much of this day is unexplained" in the one place somebody is obliged to
look, and stays on the balance sheet until it is cleared.

This left `planImbalanceCents` doing something genuinely useful. It is no longer
a validation of anybody's data — the data is allowed to be wrong — but an
assertion about our own arithmetic: every plan `summariseDay` can produce
balances, and if one does not, that is a defect in this codebase and the import
refuses rather than putting an unbalanced entry in the ledger.

## Decision 8: the tips reconciliation compares two different things

`tipsPosition` puts what the imported days say was collected against the balance
on 2310 after payroll has drawn on it. The two are allowed to differ, and once
tips have been paid out they must: the gap *is* the answer to "did last month's
tips go out".

The load-bearing detail is that money leaves 2310 by a door this module does not
control. The seed pays staff with an ordinary journal entry, and the test pays
them with `postManualEntry` — deliberately, in both cases. A reconciliation
whose two sides are both maintained by the same code reconciles to itself and
proves nothing, which is the mistake caught and fixed in Phase 26 and avoided
here by construction.

## Decision 9: gated on the module, not on the industry

A market stall on the general pack takes a day's cash; a restaurant that only
does invoiced catering does not. The workspace and `importDay` both ask
`moduleEnabled(companyId, 'pos_import')`, which reads the company's
configuration rather than its industry — the rule since Phase 14.

The accounts the module needs are installed on first use rather than assumed.
`6870 Cash Over and Short` and `1220 POS Import Suspense` are in no industry
pack, because until now nothing counted a till. A café on the general pack has
none of the eight, and without `ensureAccounts` its first import would fail with
a message about a chart of accounts the application could have fixed itself. It
only ever adds, following properties, funds and manufacturing.

## Decision 10: the arithmetic is a pure function

`summariseDay` takes a day and returns lines, with no database and no clock, for
the reason every phase since Phase 16 has had a pure core: this is the
arithmetic somebody disputes. Here the dispute is usually with a manager who is
certain the till was right, and being able to run the numbers in a test — or in
a REPL, in front of them — is worth more than the indirection costs.

## Consequences

- **No POS integration.** There is no adapter for Square, Toast, Shopify or
  Amazon. A day arrives through `importDay`, from a form or a caller; connecting
  it to a real provider is a provider abstraction that does not exist yet.
- **No file upload.** The workspace takes a typed day. A CSV settlement file has
  to be turned into a call by something else, even though Phase 17 has a CSV
  parser that could be pointed at it.
- **A day cannot be corrected or reversed from this module.** Getting Tuesday
  wrong means a manual journal entry against it. The claim row makes re-import
  impossible by design, and no un-import was built.
- **Inventory is not relieved.** A restaurant on this module posts food sales
  without touching food inventory, so cost of sales comes from purchases rather
  than from consumption. Both packs enable `inventory` too, but nothing joins
  the two: there is no recipe from menu item to ingredient.
- **Sales tax is one figure per day.** It credits 2200 in total, with no
  jurisdiction breakdown, so Phase 9's per-jurisdiction return cannot see inside
  a day's takings.
- **Tips are not allocated to people.** 2310 holds one balance. Who is owed what
  out of it is not modelled, and paying it out is payroll's job.
- **`1220 POS Import Suspense` can accumulate silently.** It is on the day row,
  on the board and on the balance sheet, but nothing chases it — no alert, no
  entry in Phase 24's health surface.
- **`takings` is a new journal source**, so anything that enumerated the
  existing ones and assumed they were all of them needs updating.

## Follow-up

1. **A provider abstraction for POS and marketplace feeds**, so a day arrives
   nightly instead of being typed — Phase 10's queue and Phase 5's provider
   pattern are both already there.
2. **CSV settlement upload**, on Phase 17's parser.
3. **Recipes**, joining a menu item to its ingredients, so a day's sales relieve
   food inventory and food cost stops being purchases.
4. **Per-jurisdiction tax on a day**, so a multi-site business can file from its
   takings.
5. **Chase what is sitting in 1220**, in Phase 24's health checks.
6. **Tips by person**, if and when payroll needs to distribute them.
