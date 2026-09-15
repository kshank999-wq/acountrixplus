/**
 * What a progress billing will bill, and why it cannot (Phase 146).
 *
 * ## The defect
 *
 * `priceApplication` carries this, and has since it was written:
 *
 * > Separated from `createProgressBilling` so the UI can show the person what
 * > they are about to bill, and so the arithmetic — the part worth testing — is
 * > reachable without writing to the database.
 *
 * The UI does not call it. Measured: `priceApplication` has exactly one caller
 * in `src/`, and that caller is `createProgressBilling`. The screen it was
 * separated out for — `BillingPanel` in `app/jobs/[id]/panels.tsx` — works the
 * figures out again in a `useMemo`, and the two do not agree:
 *
 * ```
 *                        screen                         service
 * backwards line         Math.max(0, …) — contributes 0  refuses the application
 * beyond scheduled value no check — bills the excess     refuses the application
 * percent above 100%     no bound                        refuses the application
 * retainage above 100%   no bound                        refuses the application
 * ```
 *
 * So the preview shows a total, the person clicks, and the server refuses. The
 * clamp is the worst of the four: a line billed backwards silently contributes
 * nothing to the preview, so the figure looks right and is not the figure
 * anybody will be invoiced.
 *
 * This is ADR 0110's shape again — a declaration argued from a fact that is not
 * a fact — and Phase 49's rule underneath it: a function with no caller is a
 * feature that does not exist. `priceApplication` was built as a preview and
 * has only ever been used as a step inside the commit.
 *
 * ## Why the screen could not have called it anyway
 *
 * `priceApplication` **throws on the first bad line**. That is right for a
 * commit and useless for a preview: somebody filling in twelve items wants to
 * see all twelve problems, not to fix one, click, and be told about the next.
 * So even wiring the screen to the existing function would have produced a
 * preview that hides four of five faults.
 *
 * The split this module makes is the one that lets both have what they need:
 *
 * - the arithmetic and every rule live here, and problems come back as a
 *   **list** beside the figures;
 * - a preview renders the list;
 * - a commit refuses if the list is not empty, which is the behaviour
 *   `priceApplication` has today.
 *
 * No database and no clock: the items and what was previously billed are
 * passed in, because reading them is the part that needed a transaction and
 * the part a screen already has in hand.
 */

/** A contract item, with what earlier applications have already billed of it. */
export type ScheduleItem = {
  id: string
  itemNumber: string
  scheduledValueCents: number
  previouslyBilledCents: number
}

/**
 * What somebody is claiming for an item this period.
 *
 * Either a percent complete or an amount, which is the choice
 * `ApplicationLineInput` already offers: the percent is the question a person
 * filling in an application knows the answer to, and the amount is for when
 * they would rather state it.
 */
export type ProgressEntry = {
  scheduleOfValuesId: string
  percentCompleteBp?: number
  thisPeriodCents?: number
}

export type PricedLine = {
  scheduleOfValuesId: string
  itemNumber: string
  scheduledValueCents: number
  previousCompletedCents: number
  thisPeriodCents: number
  completedToDateCents: number
  percentCompleteBp: number
}

/**
 * Something that stops this application posting, in a sentence for the person
 * filling it in.
 *
 * Carries the item number separately from the sentence so a screen can put the
 * message against the row it belongs to rather than in a list at the bottom —
 * the difference between a refusal somebody can act on and one they have to go
 * looking for (Phase 119).
 */
export type LineProblem = {
  scheduleOfValuesId: string
  itemNumber: string
  why: string
}

export type PricedApplication = {
  lines: PricedLine[]
  /** Summed over the lines with no problem, so a preview still has a figure. */
  thisPeriodCents: number
  retainedCents: number
  netDueCents: number
  /**
   * Empty means this will post. Non-empty means **nothing** posts — not that
   * the sound lines go through — because an application is one document.
   */
  problems: LineProblem[]
}

/** The retainage refusal, which is about the application rather than a line. */
export const RETAINAGE_OUT_OF_RANGE = 'Retainage must be between 0% and 100%.'

/**
 * Prices an application and says everything wrong with it.
 *
 * The rules are `priceApplication`'s own, moved rather than restated — the
 * sentences are the ones already shown to people, so wiring the service through
 * this changes no message anybody has seen.
 */
export function priceApplicationLines(
  items: readonly ScheduleItem[],
  entries: readonly ProgressEntry[],
  retainagePercentBp: number,
): PricedApplication {
  const itemById = new Map(items.map((item) => [item.id, item]))
  const problems: LineProblem[] = []
  const lines: PricedLine[] = []

  if (retainagePercentBp < 0 || retainagePercentBp > 10_000) {
    problems.push({ scheduleOfValuesId: '', itemNumber: '', why: RETAINAGE_OUT_OF_RANGE })
  }

  for (const entry of entries) {
    const item = itemById.get(entry.scheduleOfValuesId)
    if (!item) {
      problems.push({
        scheduleOfValuesId: entry.scheduleOfValuesId,
        itemNumber: '',
        why: 'That contract item is not on this job.',
      })
      continue
    }

    const previousCompletedCents = item.previouslyBilledCents

    let completedToDateCents: number
    if (entry.percentCompleteBp !== undefined) {
      if (entry.percentCompleteBp < 0 || entry.percentCompleteBp > 10_000) {
        problems.push({
          scheduleOfValuesId: item.id,
          itemNumber: item.itemNumber,
          why: `Item ${item.itemNumber}: percent complete must be between 0% and 100%.`,
        })
        continue
      }
      completedToDateCents = Math.round(
        (item.scheduledValueCents * entry.percentCompleteBp) / 10_000,
      )
    } else {
      completedToDateCents = previousCompletedCents + (entry.thisPeriodCents ?? 0)
    }

    const thisPeriodCents = completedToDateCents - previousCompletedCents

    // Both of these are refusals in the service today, and both are things the
    // screen currently lets somebody do and then discover on the server.
    if (thisPeriodCents < 0) {
      problems.push({
        scheduleOfValuesId: item.id,
        itemNumber: item.itemNumber,
        why:
          `Item ${item.itemNumber} would bill a negative amount. Completion cannot go backwards ` +
          'on an application; raise a credit instead.',
      })
      continue
    }

    if (completedToDateCents > item.scheduledValueCents) {
      problems.push({
        scheduleOfValuesId: item.id,
        itemNumber: item.itemNumber,
        why:
          `Item ${item.itemNumber} would be billed beyond its scheduled value. Approve a change ` +
          'order first.',
      })
      continue
    }

    lines.push({
      scheduleOfValuesId: item.id,
      itemNumber: item.itemNumber,
      scheduledValueCents: item.scheduledValueCents,
      previousCompletedCents,
      thisPeriodCents,
      completedToDateCents,
      percentCompleteBp:
        item.scheduledValueCents > 0
          ? Math.round((completedToDateCents / item.scheduledValueCents) * 10_000)
          : 0,
    })
  }

  const thisPeriodCents = lines.reduce((sum, line) => sum + line.thisPeriodCents, 0)

  // Rounded once on the total rather than per line, which is what the service
  // already does and says it does. Worth noting a phase after Phase 145 found
  // the sales tax comment making the same claim and being wrong: this one is
  // true, and the test holds it rather than the comment.
  const retainedCents =
    retainagePercentBp < 0 || retainagePercentBp > 10_000
      ? 0
      : Math.round((thisPeriodCents * retainagePercentBp) / 10_000)

  return {
    lines,
    thisPeriodCents,
    retainedCents,
    netDueCents: thisPeriodCents - retainedCents,
    problems,
  }
}

/**
 * Whether this application will post.
 *
 * A named question rather than `problems.length === 0` written at each call
 * site: a preview and a commit have to agree about it, and agreeing about a
 * predicate somebody can read is easier than agreeing about an expression two
 * people wrote separately — which is the fault this whole module is about.
 */
export function willPost(priced: PricedApplication): boolean {
  return priced.problems.length === 0
}
