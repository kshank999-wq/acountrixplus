/**
 * Whether a company's mail is still welcome (Phase 84).
 *
 * ## The number nobody was told
 *
 * Phase 83 made a bounce a real thing for the first time: a hard bounce now
 * suppresses the address, and the rate is measurable. Nothing watches it.
 *
 * A rising bounce rate is the signal that a sending domain is in trouble, and
 * it is the one failure in this application that gets *worse while you do
 * nothing about it* — mailbox providers score a sender over weeks, and by the
 * time the symptom is visible (campaigns "not arriving") the reputation that
 * would have to recover has already been spent. Phase 24 built a digest that
 * tells somebody when a background job dies. This is a fact of the same kind
 * and a worse one, because a dead job is still there tomorrow and a burnt
 * domain is not.
 *
 * ## The judgement
 *
 * Two decisions, and both are about not crying wolf.
 *
 * **A rate needs a denominator.** One bad address in a ten-recipient campaign
 * is a 10% bounce rate and means nothing at all. Below `MIN_VOLUME` this
 * reports no verdict rather than a reassuring one — the honest answer to "how
 * is your sending reputation" after forty emails is that nobody knows yet.
 *
 * **The thresholds are the ones the mailbox providers actually use**, not
 * numbers chosen to look calm. Google's sender guidance puts the complaint
 * ceiling at 0.3% and asks senders to stay under 0.1%; a bounce rate over
 * about 2% is the usual "something is wrong with your list" line and 5% is
 * where suspensions start. The `watch` level is deliberately below the level
 * where anything bad has happened yet, because the whole value of the number
 * is the weeks of warning it gives.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * Sends below which no rate is reported.
 *
 * A hundred is small enough that a real small business reaches it in a
 * campaign or two, and large enough that a single dead address is 1% rather
 * than 10%.
 */
export const MIN_VOLUME = 100

/** Bounces, as a share of what a provider accepted. In basis points. */
export const BOUNCE_WATCH_BP = 200 // 2%
export const BOUNCE_URGENT_BP = 500 // 5%

/** Complaints, as a share of what a provider accepted. In basis points. */
export const COMPLAINT_WATCH_BP = 10 // 0.1% — Google's "stay under" number
export const COMPLAINT_URGENT_BP = 30 // 0.3% — Google's ceiling

export type SendingCounts = {
  /** Everything a provider accepted, including what later bounced. */
  accepted: number
  bounced: number
  complained: number
}

/**
 * The statuses that mean a provider took the message (Phase 85).
 *
 * Written down once because it had been written down three times, differently.
 * `campaignStats` excluded `skipped`, `failed` and `pending`; `sendingCounts`
 * agreed; and `marketingOverview` — never revisited when Phase 83 introduced
 * `failed` — excluded `bounced` and counted `failed`, which is both halves
 * wrong. A `failed` row never reached a provider at all, and a `bounced` row
 * was accepted and then rejected downstream, so a denominator that drops the
 * bounces flatters itself by exactly the thing being measured.
 *
 * An allow-list rather than the `NOT IN` it replaces, deliberately. A status
 * added to the enum and forgotten here falls *out* of the denominator, which
 * makes every rate look worse than it is — a false alarm. The deny-list fails
 * the other way, quietly enlarging the denominator and hiding a real one, and
 * Phase 84 exists because the missed alarm is the expensive mistake.
 */
export const ACCEPTED_BY_PROVIDER = [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'unsubscribed',
] as const

export function wasAccepted(status: string): boolean {
  return (ACCEPTED_BY_PROVIDER as readonly string[]).includes(status)
}

export type SendingLevel = 'ok' | 'watch' | 'urgent'

export type SendingHealth = {
  level: SendingLevel
  accepted: number
  bounceRateBp: number
  complaintRateBp: number
  /**
   * What to say, or null when there is nothing to say.
   *
   * A sentence rather than a code, because the only consumers are a digest
   * somebody reads on a phone and a line on a page — and because the number
   * alone does not tell a person which of the two problems they have.
   */
  concern: string | null
}

function rateBp(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 10_000)
}

function asPercent(bp: number): string {
  // One decimal, because 0.3% and 0.1% are a meaningful distance apart and
  // rounding a complaint rate to whole percent makes every value zero.
  return `${(bp / 100).toFixed(1)}%`
}

/**
 * The verdict on a window of sending, or `null` when there is not enough of it.
 *
 * Null rather than an `ok` with a zero rate: "we have not sent enough to know"
 * and "we have sent plenty and it is fine" are different answers, and a caller
 * that shows the second when it means the first is lying quietly.
 */
export function sendingHealth(counts: SendingCounts): SendingHealth | null {
  if (counts.accepted < MIN_VOLUME) return null

  const bounceRateBp = rateBp(counts.bounced, counts.accepted)
  const complaintRateBp = rateBp(counts.complained, counts.accepted)

  const concerns: string[] = []
  let level: SendingLevel = 'ok'

  if (bounceRateBp >= BOUNCE_URGENT_BP) {
    level = 'urgent'
    concerns.push(`${asPercent(bounceRateBp)} of mail is bouncing`)
  } else if (bounceRateBp >= BOUNCE_WATCH_BP) {
    level = 'watch'
    concerns.push(`${asPercent(bounceRateBp)} of mail is bouncing`)
  }

  if (complaintRateBp >= COMPLAINT_URGENT_BP) {
    level = 'urgent'
    concerns.push(`${asPercent(complaintRateBp)} of readers marked it as spam`)
  } else if (complaintRateBp >= COMPLAINT_WATCH_BP) {
    // Never downgrades an urgent bounce rate to a watch.
    if (level === 'ok') level = 'watch'
    concerns.push(`${asPercent(complaintRateBp)} of readers marked it as spam`)
  }

  return {
    level,
    accepted: counts.accepted,
    bounceRateBp,
    complaintRateBp,
    concern: concerns.length > 0 ? concerns.join(', and ') : null,
  }
}

/**
 * How far back to look.
 *
 * Longer than the digest's own failure window, and deliberately so: a bounce
 * arrives hours or days after the send, so a rate measured over the last
 * twenty-four hours of *sends* misses the bounces those sends are about to
 * produce and flatters itself. Seven days is what a mailbox provider is
 * scoring over anyway.
 */
export const REPUTATION_WINDOW_DAYS = 7
