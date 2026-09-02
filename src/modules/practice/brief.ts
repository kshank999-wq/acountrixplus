import { RUNGS, type Rung, type Triage } from './triage'

/**
 * The firm's morning brief (Phase 88).
 *
 * ## The digest that reaches the one person who cannot act
 *
 * Phase 24 built a daily digest that tells somebody when background work has
 * given up or a letter has bounced. Its recipients are the memberships holding
 * `company:manage` — and that permission belongs to **`owner` alone**. A
 * practice engagement grants `accountant` by default and is capped by the
 * client, never above it.
 *
 * So the digest goes to the client's owner and never to the firm. The
 * bookkeeper engaged to keep those books — the person who would actually retry
 * the dead job, clean the bounced list, or find out why a check stopped
 * agreeing — is told nothing at all. The person who *is* told is the one least
 * equipped to act on "2 background jobs gave up".
 *
 * And the obvious fix is worse than the defect. Adding practice members to the
 * per-company digest means a firm with forty clients is woken forty times every
 * morning, which is precisely the noise failure ADR 0024 exists to prevent,
 * multiplied by the roster. **One brief a day per firm, not one per client.**
 *
 * ## The judgement: news, not state
 *
 * Phase 87 can already say what most needs somebody at every client. Sending
 * that every morning would be a message that says the same thing every day —
 * and a daily message that never changes is a daily message nobody reads, which
 * is the same failure by a slower route.
 *
 * So a client appears in the brief only when its rung is **worse than the last
 * one observed**. A client that was `wrong` yesterday and is `wrong` today is
 * not news; the firm already knows, and the roster is there when they want to
 * look. A client that slid from `waiting` to `stuck` to `wrong` over three days
 * is news on each of the three, because each step is a thing that changed.
 *
 * That is Phase 33's `newlyBroken` — *"sent the night a difference appears, and
 * not again while it is still there"* — generalised from one company's checks
 * to a firm's whole roster, and it reuses Phase 87's ladder rather than
 * inventing a second ordering.
 *
 * Nothing here touches the database or the clock.
 */

/** How many clients are named before the rest become a count. */
export const NAMED_LIMIT = 3

export type BriefClient = {
  companyId: string
  companyName: string
  triage: Triage
}

export type BriefLine = {
  companyId: string
  companyName: string
  rung: Rung
  headline: string
  /** What was last observed here, or null the first time we look. */
  from: Rung | null
}

export type Brief = {
  /** Worst first. Only clients that got worse since last time. */
  lines: BriefLine[]
  subject: string
  /** Plain paragraphs, in the shape `sendTransactional` wants. */
  body: string[]
  /**
   * Every client's rung as observed today, to be written down whatever the
   * brief says.
   *
   * Recorded even for clients that recovered and clients nothing was said
   * about — a memory that only holds the bad news cannot tell a relapse from a
   * standing problem, and would report a client that got better and worse again
   * as though nothing had happened.
   */
  observed: Array<{ companyId: string; rung: Rung }>
}

function worseThan(now: Rung, before: Rung | null): boolean {
  // First sight of a client. Everything wrong with it is news, which is the
  // answer `newlyBroken` gives for a first run: a firm that has just taken on
  // a client should be told what is wrong with those books.
  if (before === null) return now !== 'clear'
  return RUNGS.indexOf(now) < RUNGS.indexOf(before)
}

function names(lines: readonly BriefLine[]): string {
  const named = lines.slice(0, NAMED_LIMIT).map((line) => line.companyName)
  const rest = lines.length - named.length

  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`

  // A list of forty names is not a message. Three and a count is.
  return rest > 0 ? `${list} and ${rest} more` : list
}

/**
 * What to tell a firm this morning, or `null` when there is nothing new.
 *
 * Null rather than an empty brief: the caller sends no mail at all, which is
 * the silence ADR 0024 depends on. A firm that hears from this once a fortnight
 * reads it; one that hears every morning does not.
 *
 * `clients` is the firm's own roster, already scoped by `practiceWorkQueue` —
 * this function never decides who may be seen, only what is worth saying.
 */
export function briefFor(
  clients: readonly BriefClient[],
  lastSaid: ReadonlyMap<string, Rung>,
): Brief | null {
  const observed = clients.map((client) => ({
    companyId: client.companyId,
    rung: client.triage.rung,
  }))

  const lines: BriefLine[] = clients
    .filter((client) => worseThan(client.triage.rung, lastSaid.get(client.companyId) ?? null))
    .map((client) => ({
      companyId: client.companyId,
      companyName: client.companyName,
      rung: client.triage.rung,
      headline: client.triage.headline ?? 'Something changed',
      from: lastSaid.get(client.companyId) ?? null,
    }))
    .sort((a, b) => {
      const byRung = RUNGS.indexOf(a.rung) - RUNGS.indexOf(b.rung)
      return byRung !== 0 ? byRung : a.companyName.localeCompare(b.companyName)
    })

  if (lines.length === 0) return null

  const subject =
    lines.length === 1
      ? `${lines[0].companyName} needs a look`
      : `${lines.length} clients need a look`

  return {
    lines,
    subject,
    body: [
      `${names(lines)} changed since we last wrote.`,
      ...lines.map((line) => `${line.companyName}: ${line.headline}.`),
      // Said once, at the bottom, because a reader who has understood it after
      // the first brief does not need convincing again — but a reader seeing
      // their first one needs to know what the silence means.
      'Nothing else has changed. This only arrives when something does.',
    ],
    observed,
  }
}
