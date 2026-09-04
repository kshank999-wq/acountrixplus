/**
 * What currency a recurring schedule bills in (Phase 126).
 *
 * ## The defect
 *
 * Every way of raising an invoice in this system can raise a foreign one —
 * except the one that raises them unattended, month after month.
 *
 * `createInvoice` has taken a `currency` since Phase 64, documented as
 * *"Defaults to the company's own currency"*. The composer offers the choice on
 * screen. `raiseInvoiceFor` — the function a billing schedule calls — never
 * passes it, and `recurring_invoices` has no column to pass:
 *
 * ```
 * raise an invoice by hand      currency offered
 * raise one from a proposal     currency offered
 * raise one from a schedule     company currency, always
 * ```
 *
 * So a business with a European customer on a monthly retainer has two
 * choices: accept a dollar invoice for a customer whose every other document is
 * in euros, or raise all twelve by hand and keep the schedule switched off. The
 * feature exists and the customer it exists for cannot use it — Phase 49's
 * class, in a module that has looked finished since Phase 37.
 *
 * ## A correction to ADR 0125
 *
 * Phase 125 traced the recurring-billing screen and wrote:
 *
 * > A schedule billing a customer in euros raises euro invoices, and the screen
 * > showing what that schedule has billed puts the company's symbol on every
 * > one of them.
 *
 * The first half is false. A schedule cannot bill in euros at all, so the
 * company's symbol on that screen has been *correct* — and correct for a worse
 * reason than the one the phase was looking for. The display was right and the
 * thing it displayed was impoverished.
 *
 * That is worth stating rather than quietly restating: Phase 125's repair to
 * that screen stands (an invoice raised from a schedule can be foreign *now*),
 * but its account of why was wrong.
 *
 * ## A function with no caller is a feature that does not exist
 *
 * The first draft of this file also exported `mayChangeCurrency(raisedCount)`,
 * refusing to re-denominate a schedule that had already issued invoices — the
 * customer holds those, and changing the schedule under them would leave its
 * own history adding up to nothing in either currency.
 *
 * It is a real rule and it had **no caller**. `billing/service.ts` exports
 * `createSchedule`, `setScheduleActive`, `runDueSchedules`, `raiseOccurrence`,
 * `listSchedules` and `scheduleDetail` — and no update of any kind. A
 * schedule's currency is therefore fixed at creation *by construction*, and a
 * guard against changing it answers a question nobody can ask.
 *
 * Phase 49 named that defect — a function with no caller is a feature that does
 * not exist — and Phase 118 found the codebase had done it again. Writing a
 * third instance in the same breath as citing the first would be worse than the
 * omission, so it is gone rather than propped up with an edit screen nobody
 * asked for. If schedules ever become editable, the rule is in this paragraph.
 */

/**
 * The currency an occurrence was billed in.
 *
 * An occurrence records what a schedule billed for one period. Until Phase 126
 * it recorded no currency, because there was only ever one it could be — which
 * is why `recurring_invoice_occurrences.total_cents` was one of the three
 * amounts ADR 0125 classified `unrecorded`.
 *
 * Now there is a real answer and three places it can come from, in order:
 *
 * 1. **The invoice it raised**, where it raised one. That is the document the
 *    customer actually has, and it is the only one of the three that is a fact
 *    rather than an intention.
 * 2. **The schedule**, for an occurrence still waiting for somebody to raise
 *    it. What it *will* be billed in, which is what a forecast wants.
 * 3. **The company's own**, for rows written before this phase existed and
 *    backfilled by its migration.
 */
export function occurrenceCurrency(
  invoiceCurrency: string | null,
  scheduleCurrency: string | null,
  home: string,
): string {
  return invoiceCurrency ?? scheduleCurrency ?? home
}

/** One period a schedule is expected to bill. */
export type ForecastRow = {
  scheduleId: string
  currency: string
  totalCents: number
  autoRaise: boolean
  overdue: boolean
}

/** What a forecast can honestly report about one currency. */
export type ForecastTotals = {
  currency: string
  totalCents: number
  /** Due to be raised without anybody doing anything. */
  automaticCents: number
  /** Waiting for a person. */
  manualCents: number
  /** Already due before the window opened, and still not billed. */
  overdueCents: number
  scheduleCount: number
}

/**
 * A forecast's totals, one set per currency.
 *
 * ## Why this exists in the same phase that caused it
 *
 * Before Phase 126 the billing forecast added four figures across every active
 * schedule — total, automatic, manual, overdue — and every one of them was
 * sound, because every schedule billed the company's own currency and there was
 * no other currency for them to be in. Giving a schedule a currency is what
 * breaks that: a €4,000 retainer beside a $2,000 one would have been reported
 * as "6,000.00" with the company's symbol on it, and it would have been the
 * *only* wrong number this phase introduced.
 *
 * Phase 122 named that defect and Phase 123 found the form of it this would
 * have been — a `reduce()` over amounts nothing had checked were comparable.
 * Neither tripwire would have caught this one: `recurring_invoice_lines` is not
 * a face table and this file reads no face column, so the scanner has no reason
 * to look here. That is an argument for fixing it in the commit that creates
 * it, not an argument that it is somebody else's problem.
 *
 * ## Grouping rather than refusing
 *
 * Phase 123's `refuseMixedCurrency` is for a **write**: a deposit is one
 * paying-in slip and there is no honest way to bank euros and dollars on it, so
 * it stops. A forecast is a report of things that have not happened, and there
 * is nothing wrong with a business intending to bill in two currencies — the
 * report just cannot add them. So this groups instead of refusing, the same
 * answer Phase 122 gave the vendor-credit balances.
 *
 * Ordered by currency code so the screen does not reshuffle between loads, and
 * so a business with one currency — which is most of them — sees exactly the
 * single row it saw before this phase.
 */
export function forecastTotals(rows: ForecastRow[]): ForecastTotals[] {
  const byCurrency = new Map<string, ForecastRow[]>()
  for (const row of rows) {
    const existing = byCurrency.get(row.currency)
    if (existing) existing.push(row)
    else byCurrency.set(row.currency, [row])
  }

  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, group]) => ({
      currency,
      totalCents: group.reduce((sum, row) => sum + row.totalCents, 0),
      automaticCents: group
        .filter((row) => row.autoRaise)
        .reduce((sum, row) => sum + row.totalCents, 0),
      manualCents: group
        .filter((row) => !row.autoRaise)
        .reduce((sum, row) => sum + row.totalCents, 0),
      overdueCents: group
        .filter((row) => row.overdue)
        .reduce((sum, row) => sum + row.totalCents, 0),
      scheduleCount: new Set(group.map((row) => row.scheduleId)).size,
    }))
}
