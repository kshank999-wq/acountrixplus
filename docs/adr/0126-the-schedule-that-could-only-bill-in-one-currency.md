# 0126 — The schedule that could only bill in one currency

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 126

---

## How this was found

ADR 0125 declared three tables whose money is `unrecorded` — a denomination that
exists but is written down nowhere — and nominated closing them:

> **It does not give the three tables a currency column.** That is a migration
> per table and a decision about backfilling rows already written, and each has
> a different right answer — the write-off can take its invoice's, a deposit can
> take its receipts', an occurrence has nothing to take.

"An occurrence has nothing to take" is the sentence that turned out to matter.
The reason an occurrence had nothing to take is that **a billing schedule had no
currency at all**, and going to look at why found something larger than a
missing column.

## The defect

Every way of raising an invoice in this system can raise a foreign one — except
the one that raises them unattended, month after month.

```
raise an invoice by hand      currency offered
raise one from a proposal     currency offered
raise one from a schedule     company currency, always
```

`createInvoice` has taken a `currency` since Phase 64, documented as *"Defaults
to the company's own currency"*, and the composer offers the choice on screen.
`raiseInvoiceFor` — the function a billing schedule calls — never passed one,
and `recurring_invoices` had no column to pass:

```ts
return createInvoice(ctx, {
  customerId: schedule.customerId,
  issueDate: occurredOn,
  dueDate: addDays(occurredOn, schedule.paymentTermsDays),
  // …and no currency, ever
```

So a business with a European customer on a monthly retainer had two choices:
accept a dollar invoice for a customer whose every other document is in euros,
or switch the schedule off and raise all twelve by hand. Phase 49's class — a
feature that exists and the customer it exists for cannot use — in a module that
has looked finished since Phase 37.

## A correction to ADR 0125

Phase 125 traced the recurring-billing screen and wrote:

> A schedule billing a customer in euros raises euro invoices, and the screen
> showing what that schedule has billed puts the company's symbol on every one
> of them.

**The first half is false.** A schedule could not bill in euros at all, so the
company's symbol on that screen had been *correct* — and correct for a worse
reason than the one the phase was looking for. The display was right and the
thing it displayed was impoverished.

Phase 125's repair to that screen stands: an invoice raised from a schedule can
be foreign *now*, so the currency it passes is load-bearing. Its account of why
was wrong, and restating it quietly would be worse than the error.

## What it takes

`recurring_invoices.currency` and `recurring_invoice_occurrences.currency`, both
backfilled rather than defaulted blindly — the schedule from its company, the
occurrence from the invoice it raised where it raised one and its schedule
otherwise. Nothing changes an amount; the migration only writes down what every
existing number was already denominated in.

`occurrenceCurrency(invoiceCurrency, scheduleCurrency, home)` is the whole pure
core, and the order is the argument: **the invoice it raised, then the schedule,
then the company.** A fact beats an intention — the customer holds the invoice —
and an intention beats a default, because a period nobody has raised yet is
exactly what a forecast wants to show.

Verified on seeded data rather than asserted: a €2,500 monthly retainer
backdated to June raised four euro invoices, and each carries the functional
value at **its own** issue date's rate — 1.0835 for June, 1.10 for July onwards.
A schedule does not freeze one rate across its history.

## The defect this phase would have introduced

The billing forecast added four figures across every active schedule — total,
automatic, manual, overdue. Every one was sound while a schedule could only bill
the company's own currency. **Giving it a currency is what breaks them**: a
€4,000 retainer beside a $2,000 one would have been reported as "6,000.00" with
the company's symbol on it, and it would have been the only wrong number this
phase produced.

Neither existing tripwire would have caught it. `recurring_invoice_lines` is not
a face table and `reporting.ts` reads no face column, so Phase 122's scanner and
Phase 123's `reduce` form both have no reason to look there. That is an argument
for fixing it in the commit that creates it, not an argument that it is somebody
else's problem.

`forecastTotals` groups rather than refusing. Phase 123's `refuseMixedCurrency`
is for a **write** — a deposit is one paying-in slip and there is no honest way
to bank euros and dollars on it, so it stops. A forecast reports things that have
not happened, and there is nothing wrong with intending to bill in two
currencies; the report just cannot add them. Same answer Phase 122 gave the
vendor-credit balances. A business billing in one currency sees exactly the
single line it saw before.

## A function with no caller is a feature that does not exist

The first draft of `billing/currency.ts` also exported
`mayChangeCurrency(raisedCount)`, refusing to re-denominate a schedule that had
already issued invoices — the customer holds those, and changing the schedule
under them would leave its own history adding up to nothing in either currency.

It is a real rule and it had **no caller**. `billing/service.ts` exports
`createSchedule`, `setScheduleActive`, `runDueSchedules`, `raiseOccurrence`,
`listSchedules` and `scheduleDetail`, and no update of any kind. A schedule's
currency is fixed at creation *by construction*, and a guard against changing it
answers a question nobody can ask.

Phase 49 named that defect and Phase 118 found the codebase had done it again.
Writing a third instance in the same breath as citing the first would be worse
than the omission, so it is gone rather than propped up with an edit screen
nobody asked for. The rule is in the file's prose, where the next person to make
schedules editable will find it.

## The registry noticed, exactly as it was built to

Phase 124's `DOCUMENT_TABLES` listed the five tables carrying a currency, and its
test said out loud:

> If a sixth ever grows one, this list is where somebody has to notice.

This phase grew two. Both are declared, and two consequences follow: the
`Forecast` entry that ADR 0125 recorded as `unrecorded` is now `document`,
because the denomination is a fact on the row rather than something knowable only
by reading the write path; and the `Detail` entry drops the `fields` narrowing
Phase 125 added, since the reason for it — that a schedule's own totals had no
currency — has gone.

Two of the three `unrecorded` tables remain: `invoice_write_offs` and `deposits`.

## The tripwire that was a number nobody measured

`UNCLASSIFIED_CARRIERS` is the honest remainder — carriers the scan cannot rule
out and no entry classifies. Its test asserted:

```ts
expect(UNCLASSIFIED_CARRIERS).toBeLessThanOrEqual(13)
```

against a constant of `13`. **That is true whatever the codebase does**, and
equally true of Phase 124's wrong `19` — which is how that error survived a green
suite for an entire phase before Phase 125 caught it by reading rather than by
running anything.

A tripwire made of a number nobody measures is not a tripwire, however carefully
the number was arrived at. The test runs the scan now and compares exactly, so
the figure can be wrong once and not twice. It reads **12**: `Waiting` — periods
claimed on a schedule and left for a person to raise — was one of the thirteen
and now carries its occurrence's currency.

That currency is the occurrence's own, not the schedule's, on purpose: an
occurrence records what was decided when the period was claimed, and a schedule
re-denominated later must not restate a period already sitting on somebody's
desk. Nothing can re-denominate a schedule today, which is precisely why the
rule belongs in the query rather than in a guard.

## What this does not do

**It does not give write-offs or deposits their currency column.** Each is a
migration and a backfill decision of its own — the write-off takes its invoice's,
a deposit takes its receipts' (single since Phase 123, recorded nowhere). ADR
0125's nomination is one third closed, and the remaining two thirds are named
here rather than quietly dropped.

**It does not fix `badDebtSummary`.** It still sums write-off amounts across
customers, each in its own invoice's currency, and still cannot be fixed without
the migration above. It stays in `NAME_COLLISIONS` saying so.

**It does not make a schedule editable.** Setting the currency at creation and
leaving it fixed is the whole of what a schedule can express. If that changes,
the rule that has to arrive with it is written down.

**It does not convert a forecast.** Two currency lines is the answer, not one
line converted at today's rate — a forecast is about periods that have not
happened, and there is no rate for a period that has not happened either.
