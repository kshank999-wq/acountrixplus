# ADR 0016 — The parts sum to the whole

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §13 ("Classes/departments/locations/projects/jobs **or
  equivalent** accounting dimensions"; "Fixed asset register/depreciation
  support can be a later professional module if not in MVP")
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0012](0012-the-statements-an-accountant-asks-for.md),
  [ADR 0014](0014-one-inventory-five-industries.md),
  [ADR 0015](0015-an-hour-is-billed-once.md)

## Context

Two things in §13 were still open, and they are the last two: user-defined
accounting dimensions, and a fixed asset register.

They look unrelated and they share a claim. Both are *derived views of the same
ledger* that must agree with it — a dimensional report whose columns sum to
something other than the profit and loss, or a register whose costs sum to
something other than the Fixed Assets account, is not a slightly-wrong report.
It is a second set of books that happens to be printed on the same paper.

So the claim for both halves is one sentence: **the parts sum to the whole.**

## Part one: dimensions

### Decision 1: a dimension is a row, not a column

Projects and cost codes have been dimensions since Phases 2 and 7, and they are
hard columns on `journal_lines` because every company has jobs in some form.
What was missing is the rest of §13's sentence: a restaurant with three sites,
an agency with two departments, a nonprofit with restricted funds. A location
is not a project — it does not start, finish, or get billed — and giving each
new way of looking at a business its own column means a migration every time an
owner has an idea.

So `dimensions` and `dimension_values` are rows a company creates, and a line's
value lives in `journal_line_dimensions`. The cost is one join in the reporting
queries. The benefit is that "Region" is a thing an owner can add on a Tuesday.

### Decision 2: `unique(journal_line_id, dimension_id)` is the whole model

One value per dimension per line. Without it a line could carry two Locations
and would be counted in both columns, so the report would sum to more than the
account it came from — and every figure on the page would be inflated by an
amount nobody could determine.

This is the fifth time the database has been the right place to enforce a claim
the application could only hope for: the deposit uniqueness index in Phase 12,
stock relief inside the invoice transaction in Phase 14, the billed-once WHERE
clause in Phase 15, and in this phase both this and the depreciation index
below.

### Decision 3: Unassigned is a column, not an omission

The tempting alternative is to report only the lines that carry a value. That
produces a page which is internally consistent, adds up to less than the
business earned, and gives no hint of by how much.

Instead every untagged line is gathered into a column called Unassigned and
shown. `dimensionalProfitAndLoss` also computes `totalsAgree` on every run, and
the screen refuses to be trusted if it is ever false.

Coverage is measured on **gross** movement rather than net, because netting
hides exactly what it is meant to expose: $50,000 of untagged revenue against
$50,000 of untagged cost nets to zero, and "100% covered" would be a lie about
$100,000 nobody can attribute.

### Decision 4: `expected` is advisory, and that is a real concession

A dimension can be marked `expected`, which means its coverage is measured and
reported. It does **not** mean a posting without it is refused.

Refusing would mean every derived posting path — invoices, bills, payroll,
depreciation, inventory relief — must be able to supply a value, and the ones
that cannot would simply stop working. A rule that turns off payroll to protect
a report is not a rule anybody keeps; they turn the rule off instead, and then
the books have a dimension nobody trusts and no coverage figure to say so.

What `expected` buys is a number and a work list: this is how much of your
profit and loss carries a Location, and here are the lines that do not.

### Decision 5: reclassifying moves no money, and is allowed in a closed period

Assigning a value to an already-posted line changes no debit and no credit. The
trial balance is identical before and after; all that changes is which column
of a dimensional report the same money appears in. So it writes to
`journal_line_dimensions`, posts nothing, and is permitted inside a closed
period — nothing a close protects has moved.

It is still audited, because "who decided a quarter of the year's costs
belonged to the Airport" is a question somebody will ask and the ledger has no
record of it.

### Decision 6: there is no balance sheet by dimension

Assets and liabilities can be tagged — this truck belongs to the Airport site.
Equity cannot. There is no such thing as the Airport site's share capital, and
its retained earnings depend on inter-site transfers nobody records.

Every product that ships "balance sheet by location" balances it with a plug,
usually called something like "Due to/from divisions", and that plug is a
number the business never transacted. What is offered instead is
`balanceActivityByValue` — the *movement* on balance-sheet accounts carrying a
value, which answers "what did the Airport buy" without pretending to answer
"what is the Airport worth". The screen says so in as many words.

Dimensional reporting is also **accrual only**. The cash-basis engine restates
entries by walking payment applications back to the documents that produced
them (ADR 0012), and a restated figure has no single journal line to inherit a
dimension from. Offering the toggle would mean inventing the attribution.

## Part two: the fixed asset register

### Decision 7: the total is authoritative, the periodic amount is derived

The same discipline as inventory lot value in ADR 0014, for the same reason. An
asset costing $10,000 with $1,000 salvage over three years depreciates $9,000 —
exactly, to the cent, however the 36 monthly figures round.

So the schedule tracks what is *left* and lets rounding correct on the very
next period rather than at the end. Deriving each month independently leaves
eight cents of an asset on the balance sheet forever, and a fully depreciated
asset with a residue is the kind of thing that survives ten years of closes and
then has to be explained.

`tests/assets.test.ts` runs 756 schedules across every method, convention, life
and awkward cost, and asserts on each that the months sum to the depreciable
base and the last book value is the salvage value. Not approximately.

### Decision 8: registering an asset posts nothing

The third time this has been right — a purchase order posts nothing (ADR 0014),
recording time posts nothing (ADR 0015) — and the sharpest reason yet. By the
time an asset reaches the register the money has *already* been spent and
coded, usually as a supplier bill against Fixed Assets. Posting the acquisition
again would put the truck on the balance sheet twice.

`reconcileFixedAssets` is what catches the cases where it has not: an asset on
the register nobody coded, or a purchase coded that nobody registered. Both are
common, both are invisible on every other report — the balance sheet is right,
the register is right on its own terms — and only the comparison finds them.

The ledger is the authority and the register is the explanation. When they
disagree the ledger is not wrong, and neither is fixed by adjusting the
register to match.

### Decision 9: `unique(fixed_asset_id, period_end)` is the idempotency

Depreciation *will* be run twice. Somebody clicks the button, a scheduled job
fires an hour later, a period is reopened and closed again. Each is reasonable
on its own.

The insert is `ON CONFLICT DO NOTHING` and the run compares what it claimed
against what it expected; a shortfall throws, and **the whole journal entry
rolls back** because the insert is inside its transaction. A read-then-write
lets both runs commit, the asset depreciates twice in March, and nothing on any
report reveals it until the asset is fully written off two years early.

### Decision 10: a period is owed once it has ended

Not once its month has been *reached*. The first version rounded the cut-off up
to the end of the month it was given, so asking "what is owed today" on the
16th of August offered a full month of August depreciation dated the 31st — a
future-dated entry for a month that had not happened. Found by looking at the
screen, not by a test, which is why the screens get looked at.

Arrears are charged to **their own months**. A truck bought in January and
registered in June owes five months, posted as five entries dated to
themselves. The months are when the truck was wearing out; one lump in June
would put five months of cost into one period's profit and misstate both.

### Decision 11: disposal charges the arrears first

Gain or loss is proceeds less book value, and book value uses the depreciation
*actually charged*, never the schedule's expectation. An asset last depreciated
in month 14 and sold in month 20 has six months uncharged; disposing at the
schedule's book value would book a gain the accumulated-depreciation account
never supported, and the register would stop reconciling on the spot.

A gain goes to **Other income** and a loss to **Other expense**, never to Sales
Revenue — putting it there flatters the trading margin of a business that sells
services, in a month it happened to sell a van.

## Consequences

- **A dimension is not enforced at posting.** See Decision 4. A company that
  genuinely needs every line tagged has a coverage figure and a work list, not
  a gate.
- **Defaults exist and nothing populates them from the document paths yet.**
  `dimension_defaults` and `resolveDefaults` are built and tested; the invoice,
  bill and payroll paths do not call them, so today a dimension is set by hand
  on a manual entry or by reclassifying afterwards. This is the largest gap in
  the phase.
- **A dimension cannot be reported hierarchically.** Values nest —
  `parentId` is there and validated — and no report rolls a child up into its
  parent. "West / Portland" and "West / Seattle" appear as two columns rather
  than one with a subtotal.
- **No dimension on the transaction inbox.** The natural moment to tag a cost
  is while categorizing the transaction it arrived on, and that screen has no
  picker.
- **Cash basis has no dimensional report**, per Decision 6.
- **Depreciation is not scheduled.** It is a button. The Phase 10 scheduler
  could run it monthly, and the idempotency that would make that safe is
  already in place — the constraint exists precisely so a job and a person can
  both fire it — but no schedule is registered.
- **No partial-year or tax-book depreciation.** One schedule per asset. A
  company that keeps a book life and a different tax life has to keep the
  second one somewhere else, which is most companies past a certain size.
- **No revaluation, impairment, or componentisation.** An asset has one cost
  and one life from registration to disposal. Changing the estimate means the
  remaining schedule changes for every future period and the past is not
  restated — which is the correct accounting treatment, and it is untested
  because nothing in the interface can change an estimate yet.
- **A disposal in the middle of a month charges no part-month.** Only completed
  months are charged, so an asset sold on the 15th gets nothing for that month.
  Defensible and consistent with Decision 10; some conventions would charge
  half.
- **The register has no attachments.** A serial number and a location are
  fields; the invoice, the photograph and the warranty are not.

## Follow-up

1. **Resolve dimension defaults on the document paths** — an invoice line from
   a customer with a default Location, a bill from a vendor with a default
   Department. The resolver exists; the callers do not.
2. **A dimension picker on the transaction inbox**, at the moment somebody is
   already deciding what a cost was.
3. **Roll up values on the dimensional report**, using the `parentId` that is
   already validated and stored.
4. **Register depreciation as a monthly schedule** on the Phase 10 worker.
5. **A second depreciation book** for tax, which is what most companies past a
   certain size actually need.
