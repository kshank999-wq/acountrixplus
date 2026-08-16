# ADR 0023 — Somebody else's money

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §5 (Real Estate / Property: "properties, tenants, rents,
  CAM/expenses, property-level reporting"), §7, §20 Phase 7 ("add specialized
  workflows without forking the core ledger"), §13, §19
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0016](0016-the-parts-sum-to-the-whole.md),
  [ADR 0015](0015-an-hour-is-billed-once.md)

## Context

Ten industry modules were declared in Phase 0. Four were built. `properties`
was one of the six that were switched on by the pack that asked for them and
did nothing — and so were the four accounts the real-estate pack has been
installing since Phase 0: `2580 Tenant Security Deposits`, `4300 Rental
Income`, `4310 CAM Reimbursements`, `4320 Late Fee Income`.

Three claims, asserted in `tests/properties.test.ts`:

1. **A security deposit is somebody else's money.** It never reaches the profit
   and loss on the way in or the way out.
2. **Rent is billed once per lease per period**, however many times the run
   fires and however many fire at once.
3. **Property-level reporting is Phase 16's dimensional profit and loss**,
   which is why it sees costs this module never posted.

## Part one: the deposit

### Decision 1: a deposit is a liability, and the arithmetic follows

A deposit received credits `2580`, a liability. It is not income, and a
landlord holding £30,000 across ten flats has not earned £30,000. Refunding it
debits that liability and is **not an expense** — money that was never income
cannot become a cost on the way out. Booking a refund to an expense account is
how a set of property books shows a loss in every month somebody moves out, and
it is the single most common error in this domain.

### Decision 2: keeping it is the only moment it becomes income — and even then it depends

Applying a deposit has two shapes, and the difference is whether the thing it
covers has already been recognised:

- **Against an unpaid invoice** — the rent was recognised when the invoice was
  raised. The deposit settles the receivable: debit `2580`, credit Accounts
  Receivable, and revenue does not move. Recognising it again here would count
  the same month's rent twice, and the books would balance while the income
  statement lied.
- **Against damage, with no invoice** — nothing has been recognised, so this is
  the moment somebody else's money becomes the landlord's: debit `2580`, credit
  income.

Both cases are tested against the profit and loss rather than against the
journal lines, because the claim is about what the statement says.

### Decision 3: a settled deposit is not a payment

The obvious implementation reuses `recordPayment` with the liability account
standing in for the bank. It is wrong, and Phase 12 is why: a receipt with no
financial account means *cash in hand, not yet banked*. It appears on the
undeposited funds list and the bank deposit screen offers to pay it in.

A deposit being kept is not cash in hand — it is money banked months ago moving
out of a liability. Recording it as a payment would invent cash nobody can
deposit, and the first person to find out would be whoever tried. So
`settleInvoiceWithoutCash` moves the invoice balance and the caller posts its
own entry, and a test asserts the undeposited list stays empty.

Extracting that also removed a duplicate: `reduceDocumentBalance` is now the one
implementation of "zero means paid, anything else means partial".

### Decision 4: the held balance is derived, never stored

`Σ received − Σ refunded − Σ applied`, computed on demand from
`deposit_movements`. Not a column on the lease.

Phase 20 shipped a cached `reference_count` and the delete path trusted it; a
count drifted upwards would have leaked storage for ever and one drifted
downwards would have destroyed somebody's evidence. The fix was to make the
rows the authority. Here the stakes are higher than storage: a drifted deposit
balance is a landlord refunding money they no longer hold, or keeping money
that was never theirs. The rows cannot drift.

### Decision 5: the register reconciles to the account

`depositsHeld` proves `Σ movements === the 2580 balance`, the same shape as
Phase 16's fixed asset reconciliation. A landlord who cannot show that the
deposits they are holding match the liability on their balance sheet has a
problem no report will fix, and in most jurisdictions a legal one.

### Decision 6: ending a tenancy does not touch the deposit

`endLease` frees the unit and stops the billing, and deliberately leaves the
money alone. What happens to a deposit is a decision somebody has to make —
doing it automatically would refund one that should have been kept against
damage. The confirmation message says so rather than staying silent.

## Part two: the rent

### Decision 7: billed once, arbitrated by the database

`unique(lease_id, period_start)` on `rent_charges`. The run does not read the
table, work out what is missing, and then insert — that is a race, and it is
exactly the race a scheduled job and an impatient landlord clicking the button
will find. It inserts, and the duplicate loses on the index.

The charge row goes in **first**, before the invoice. Losing that insert means
another run got there and this one rolls back having raised nothing; inserting
the invoice first would leave a duplicate invoice behind when the charge lost.

Same shape as Phase 15's billed-once clause, Phase 16's
one-charge-per-asset-per-month index, Phase 19's token redemption and Phase 22's
task completion. Where two people can act at once, the database decides.

### Decision 8: one transaction per lease, not one per run

A block of forty flats where the thirty-ninth tenant's account has a problem
should bill thirty-nine. The idempotency key is what makes that safe: fix the
fortieth, run it again, and nobody is billed twice.

### Decision 9: the month is a parameter

`runRent` takes `month`; nothing reads the clock. The same rule Phase 16
applied to depreciation and Phase 21 to the PDF's timestamp, for the same
reason: a run that reads the clock cannot be re-run for March and cannot be
asserted on.

### Decision 10: prorate by day, and never prorate a whole month

A tenancy starting on the 15th pays from the 15th inclusive; one ending on the
10th pays to the 10th inclusive — somebody with the keys that day had them.
Rounding is `Math.round`, not "in the landlord's favour": a rule that always
rounds up collects a few cents more than the lease says over a year, and
somebody eventually notices.

A whole period never divides at all, so the common case returns exactly the
rent on the lease and no arithmetic can drift it. And a proration that rounds
to nothing raises no charge — a $0.00 invoice is a row nobody can explain.

`dueDay` is capped at 28 by the schema rather than 31, so "the 30th" never
silently becomes "the 28th" in February and shifts a due date twice a year.

## Part three: the reporting

### Decision 11: a property is a dimension, not a report

Spec §5 asks for "property-level reporting", and the obvious reading is a
per-property profit and loss written inside this module. That would be the
second reporting stack ADR 0007 forbids. It would sum the rent and repairs this
module knows about and miss the insurance premium a bookkeeper coded to the
property from the transaction inbox — and two answers to "how is Elm Street
doing" is worse than none, because only one is wrong and nobody knows which.

So creating a property creates a value in a company-wide **Property**
dimension, every posting tags its line, and `propertyProfitAndLoss` is four
lines that call Phase 16's report. A test posts a roof repair by hand, through
no part of this module, and asserts it lands on the property's column.

The dimension is marked `expected`, so Phase 16 measures coverage and lists
what is untagged — advisory rather than enforced, for ADR 0016's reason.

### Decision 12: occupancy is measured against units

A property with four flats and one tenant is 25% let. Measuring against leases
would report 100% — every lease is occupied, by definition — which is why units
exist as a table separate from tenancies at all. A unit held back for
refurbishment stays in the denominator: it is still a flat earning nothing.

### Decision 13: the module installs the accounts it needs

`createProperty` creates any of the four missing accounts. The real-estate pack
has them; a contractor who bought the yard next door and switched the module on
does not — and without this, everything works until the first rent run fails
with "your chart of accounts is missing 4300", which is a message about a
problem the application could have solved itself. It only ever adds: an
existing `4300` named something else is that company's decision.

## A gap closed on the way

`DocumentLineInput` carried job dimensions and not user-defined ones, so an
invoice could not be tagged with a Location or a Property. Phase 16 wired
dimensions to manual entries only, and the README has called that "the largest
gap in Phase 16" ever since — a company slicing its books by Location saw its
costs and missed its revenue.

Property reporting needs the revenue side, so invoices and bills now carry
`dimensions` through to their journal lines. One field, two call sites, and a
test that asserts the rent invoice itself is tagged rather than assuming it.

## Consequences

- **Rent is monthly.** Weekly tenancies, quarterly commercial rents and
  annual ground rents are not expressible. The period is a month because the
  idempotency key is a month, and widening it means a period *type* on the
  lease and a rethink of proration.
- **Nothing schedules the rent run.** It is a button. The Phase 10 queue is
  right there and the run is already idempotent — which is the hard half — so
  this is a handler registration away, and it is the obvious next thing.
- **No late fees, and no CAM.** `4310 CAM Reimbursements` and `4320 Late Fee
  Income` are installed and unused. Service-charge apportionment is a real
  feature with real arithmetic, and half of one is worse than none.
- **No rent reviews or indexation.** Changing the rent means editing the lease,
  which restates nothing already billed — correct, but there is no record of
  what it was before or when it changed.
- **A deposit is not held per scheme.** Many jurisdictions require deposits in a
  protected scheme with a registration reference and statutory deadlines. This
  models the money and not the compliance.
- **No tenant statement of their own.** Phase 11's customer statement covers a
  tenant, because a tenant is a customer — but it says "Invoice" rather than
  "Rent for March", and it does not show the deposit held.
- **The rent roll is a snapshot, not a history.** It answers "who is in today".
  "Who was in last March" needs the charges, and there is no screen that asks
  it that way.
- **Occupancy is by unit count, not by area or by rent.** A portfolio of one
  large unit and three small ones reports 25% let when the large one is empty,
  which understates the problem; `areaUnits` is recorded and unused.
- **A property is not a fixed asset.** Phase 16's register would depreciate the
  building and this module does not link to it, so the same address can exist
  in both places with nothing reconciling them.

## Follow-up

1. **Schedule the rent run** on the Phase 10 queue. The idempotency that makes
   it safe already exists.
2. **Late fees**, from the invoice due date the run already sets, into the
   `4320` account already installed.
3. **CAM/service charge apportionment** by area, which is what `areaUnits` was
   recorded for.
4. **Link a property to its fixed asset**, so the building depreciates and the
   two registers reconcile.
5. **Rent reviews with a history**, so a lease can say what changed and when.
