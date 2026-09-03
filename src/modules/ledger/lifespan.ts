/**
 * What was on the books at a date, and what it held then (spec §19).
 *
 * ## The defect
 *
 * Phase 110 read the eleven checks it had left `today_only` and found two whose
 * subledger side is present-tense for reasons only the query shows. Measured
 * afterwards on the development books, at four dates:
 *
 * ```
 * assets.register    2026-03-31: agrees  cost 10125000/10125000
 *                    2025-12-31: DIFFERS cost 10125000/0
 * manufacturing.wip  2026-03-31: agrees  12600/12600
 *                    2025-12-31: DIFFERS 12600/0
 * ```
 *
 * The left figure never moves. Both are **faults** — the register's highest
 * severity — so asking about last December reported $101,250 of broken books
 * and a broken factory floor on books that were perfectly correct.
 *
 * ## Why a shared vocabulary rather than two more bespoke queries
 *
 * This is the fourth subledger to need restoring to a date. Phase 108 did the
 * two control accounts, Phase 109 did inventory, and each wrote its own
 * arithmetic:
 *
 * - control accounts: balance now **plus** the settlements dated after
 * - inventory: value now **minus** what moved after
 * - assets: a **filter** — bought by then, not yet sold
 * - work in process: a **sum** of what a run had absorbed by then
 *
 * They are genuinely different operations and collapsing them into one function
 * would be the wrong kind of tidying. What they share is a single decision that
 * every one of them makes and each one re-derived: **was this thing on the books
 * on that day at all**. That decision is one line, it is easy to get wrong by a
 * character, and getting it wrong is invisible — so it is named once, here, with
 * the argument written down.
 *
 * ## The boundary, which looks like a bug and is not
 *
 * Opening is **inclusive** and closing is **exclusive**:
 *
 * ```
 * openedOn <= asOf && (closedOn === null || closedOn > asOf)
 * ```
 *
 * The asymmetry is not a preference. Both dates are the dates of *journal
 * entries* — an asset's cost is posted with `entryDate: acquiredDate` and its
 * disposal with `entryDate: disposedOn`; a work order's material is posted on
 * `occurredOn` and its completion on `completedOn`. A report as at a date
 * includes every entry dated on or before it. So on the day a thing arrives the
 * ledger already carries it, and on the day it leaves the ledger has already
 * removed it. Anything else puts the subledger one day out of step with the
 * ledger it is being compared against, which is the whole defect this file
 * exists to close, reintroduced at the boundary.
 *
 * No database and no clock: callers pass the date they are reporting for.
 */

/**
 * When a thing came onto the books, and when it left.
 *
 * `openedOn` is nullable because "not yet on the books at all" is a real state
 * with real rows behind it — a work order raised as a draft and never released
 * has no start date because nothing has happened to it. Reading that as an
 * opening date of "the beginning of time" would put every draft run on every
 * historical report.
 */
export type Lifespan = {
  openedOn: string | null
  /** Null while it is still on the books. */
  closedOn: string | null
}

/** One dated thing a holding absorbed, in cents. */
export type DatedMovement = {
  on: string
  cents: number
}

export class LifespanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LifespanError'
  }
}

/**
 * Was this on the books at the close of `asOf`?
 *
 * Throws rather than answering when the lifespan is incoherent. A record that
 * closed before it opened is a data fault, and the two plausible silent answers
 * — always on, never on — are each wrong half the time on a report somebody
 * reconciles against. The same argument the register makes for throwing on an
 * undeclared key: a wrong number nobody questions is worse than a stop.
 */
export function onBooksAt(life: Lifespan, asOf: string): boolean {
  if (life.openedOn && life.closedOn && life.closedOn < life.openedOn) {
    throw new LifespanError(
      `This closed on ${life.closedOn}, before it opened on ${life.openedOn}. ` +
        'One of the two dates is wrong, and reporting either answer would hide it.',
    )
  }

  if (!life.openedOn) return false
  if (life.openedOn > asOf) return false

  // Exclusive, and the reason is in this file's header: the entry that takes it
  // off the books is dated `closedOn`, so a report as at that day already has
  // it gone.
  return life.closedOn === null || life.closedOn > asOf
}

/** What had been absorbed by the close of `asOf`, whatever happened later. */
export function absorbedBy(movements: readonly DatedMovement[], asOf: string): number {
  return movements.reduce((sum, movement) => (movement.on <= asOf ? sum + movement.cents : sum), 0)
}

/**
 * What this held at the close of `asOf`.
 *
 * Zero once it is off the books, whatever its movements say — the entry that
 * closed it released the whole balance, so carrying the movements past that
 * point would double-count them against a ledger that has already let them go.
 */
export function heldAt(
  life: Lifespan,
  movements: readonly DatedMovement[],
  asOf: string,
): number {
  return onBooksAt(life, asOf) ? absorbedBy(movements, asOf) : 0
}

/**
 * What a set of holdings came to, and which ones counted.
 *
 * Returns the members rather than only the total, because the first question
 * after "these two disagree by $101,250" is *which ones*, and a caller that has
 * to re-run the filter to answer it is a second place for the boundary to be
 * decided.
 */
export function positionAsAt<T>(
  holdings: ReadonlyArray<{ subject: T; life: Lifespan; movements: readonly DatedMovement[] }>,
  asOf: string,
): { cents: number; on: T[]; off: T[] } {
  const on: T[] = []
  const off: T[] = []
  let cents = 0

  for (const holding of holdings) {
    if (onBooksAt(holding.life, asOf)) {
      on.push(holding.subject)
      cents += absorbedBy(holding.movements, asOf)
    } else {
      off.push(holding.subject)
    }
  }

  return { cents, on, off }
}

/**
 * What the page says about the ones the date left out.
 *
 * Without this a reconciliation for a past date silently shows a shorter list
 * than the same reconciliation for today, and the reader is left to work out
 * whether records went missing or were simply not there yet. The whole clause
 * is built in one place because the noun and the verb have to agree on the
 * count, and Phase 96 shipped "1 recurring invoices" by pluralising one of two.
 */
export function excludedNote(
  count: number,
  noun: { one: string; many: string },
  asOf: string,
): string | undefined {
  if (count === 0) return undefined

  return count === 1
    ? `1 ${noun.one} is left out: it was not on the books on ${asOf}.`
    : `${count} ${noun.many} are left out: they were not on the books on ${asOf}.`
}
