import type { Clash, PartySide } from './addresses'

/**
 * Which of two records sharing an address can be tidied away (Phase 95).
 *
 * ## The finding nobody could act on
 *
 * Phase 94 taught the nightly register to report *"2 customers share
 * accounts@cascade.test: Cascade Joinery, Cascade Joinery Ltd."* — which is a
 * real problem, named, on a page somebody reads.
 *
 * And then it stops. The person reading it goes to the customers screen, finds
 * both records by hand, and has to decide which one the invoices should have
 * gone to with nothing in front of them but two names that look alike. The
 * register found the problem; the screen where it would be fixed did not know
 * the problem existed.
 *
 * ## The judgement: a record with a document on it is history, and history is
 * merged, not retired
 *
 * This is the whole rule, and it is deliberately one rule rather than a ladder
 * of cases.
 *
 * A customer nobody has ever invoiced is a **mistake** — somebody typed the
 * business in twice, or a lead came in under a name that already existed. It
 * carries no evidence, so retiring it loses nothing and fixes the ambiguity
 * outright.
 *
 * A customer with even one settled invoice from four years ago is **evidence**.
 * Archiving it does not delete it, but it does not fix anything either: the
 * history stays attached to a separate identity, and *"what did this business
 * buy from us"* still has two answers. Putting those two answers together is a
 * merge — a real feature with real consequences for the ledger — and this
 * application does not have one. Phase 94's ADR said so and meant it.
 *
 * So the advice a person gets is honest about which of those two situations
 * they are in, and never pretends the second is the first.
 *
 * ## What this deliberately does not say
 *
 * **It never says the records are the same business.** They share an inbox.
 * That is all anybody knows, and it is exactly why Phase 94 made the finding a
 * position rather than a fault: a parent and its subsidiary genuinely may share
 * an accounts inbox and genuinely are two customers.
 *
 * So every sentence here is about what a record *carries* — invoiced or never
 * invoiced, open or settled — and the identity judgement is left to the person,
 * who is the only one who can make it. An application that guessed and archived
 * the wrong one would be destroying somebody's customer record on the strength
 * of a matching email address.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * What one record carries. Every field is already on `PartySummary`.
 *
 * Deliberately carries no name. The clash already names its parties, and a
 * footprint that named them too would be a second answer to one question — a
 * caller could hand over a mismatched pair and the core would quietly prefer
 * one of them. A footprint is what a record *carries*; the clash is who it is.
 */
export type Footprint = {
  id: string
  /** Every document ever raised against them, settled ones included. */
  documentCount: number
  /** Documents still open — what Phase 56 refuses to archive over. */
  openDocuments: number
  /** What those open documents come to, in the home currency. */
  balanceCents: number
  /** An overpayment, or an unspent credit. Money that is somebody's. */
  heldCreditCents: number
}

/**
 * What a record is, before anything is decided about it.
 *
 * Named separately from the advice because the evidence is the thing a person
 * is actually deciding on. "Never invoiced" is a fact they can check; "retire
 * this one" is a conclusion drawn from it, and showing only the conclusion asks
 * them to trust it.
 */
export type Standing =
  /** No document has ever been raised against it. Nothing would be lost. */
  | 'untouched'
  /** It has traded, and nothing is outstanding. History, but quiet history. */
  | 'settled'
  /** Open documents, or money held. Live business. */
  | 'trading'

export type Advice =
  /** Exactly one record carries history. The empty ones can go. */
  | 'retire-the-empty'
  /** Two or more carry history. Only a person can put them together. */
  | 'merge'
  /** None carries anything. Any one will do, and nothing favours either. */
  | 'choose'

export type Disposition = {
  id: string
  name: string
  standing: Standing
  /**
   * Whether this particular record is one the advice says can go.
   *
   * False for everything under `merge`, including the settled record that Phase
   * 56 would happily deactivate — because deactivating it is not the fix, and
   * offering it as one would be the application quietly recommending that
   * somebody hide half of a customer's history.
   */
  retirable: boolean
}

export type Resolution = {
  side: PartySide
  address: string
  advice: Advice
  /** The record the evidence points at, when exactly one does. */
  keepId: string | null
  dispositions: Disposition[]
  /** What a person reads. Says what the records carry, never who they are. */
  because: string
}

/**
 * What a record carries, in one word.
 *
 * `trading` covers held money as well as open documents. A customer with no
 * open invoice but a £400 overpayment sitting against them is not a spare
 * record: somebody is owed that money back, and archiving the record is how it
 * stops being anybody's job.
 */
export function standingOf(footprint: Footprint): Standing {
  if (footprint.openDocuments > 0 || footprint.balanceCents !== 0) return 'trading'
  if (footprint.heldCreditCents !== 0) return 'trading'
  return footprint.documentCount > 0 ? 'settled' : 'untouched'
}

/** Records that carry no history at all — the only ones safe to simply retire. */
function isEmpty(standing: Standing): boolean {
  return standing === 'untouched'
}

const NOUN: Record<PartySide, [one: string, many: string]> = {
  customer: ['customer', 'customers'],
  vendor: ['supplier', 'suppliers'],
}

/**
 * What to do about one clash, given what each of its records carries.
 *
 * Footprints are matched to the clash by id. A party in the clash with no
 * footprint is treated as untouched rather than dropped — the clash came from
 * the same list of active parties, so a missing footprint means the party has
 * no documents at all, which is exactly what untouched means.
 */
export function resolve(clash: Clash, footprints: Footprint[]): Resolution {
  const byId = new Map(footprints.map((footprint) => [footprint.id, footprint]))

  const dispositions: Disposition[] = clash.parties.map((party) => {
    const footprint = byId.get(party.id)
    const standing = footprint
      ? standingOf(footprint)
      : ('untouched' satisfies Standing)

    return { id: party.id, name: party.name, standing, retirable: false }
  })

  const withHistory = dispositions.filter((one) => !isEmpty(one.standing))
  const [one, many] = NOUN[clash.side]

  if (withHistory.length > 1) {
    // Two records that have both traded. Combining them is a merge, and saying
    // "archive one" here would be advising somebody to hide half the evidence.
    return {
      side: clash.side,
      address: clash.address,
      advice: 'merge',
      keepId: null,
      dispositions,
      because: `${withHistory.length} of these ${many} have documents against them. Neither can be retired without hiding what it has traded — putting them together is a merge, and that is a decision for a person.`,
    }
  }

  if (withHistory.length === 1) {
    const keeper = withHistory[0]
    const empty = dispositions.filter((each) => each.id !== keeper.id)

    return {
      side: clash.side,
      address: clash.address,
      advice: 'retire-the-empty',
      keepId: keeper.id,
      dispositions: dispositions.map((each) =>
        each.id === keeper.id ? each : { ...each, retirable: true },
      ),
      because: `Only ${keeper.name} has documents against it. ${
        empty.length === 1
          ? `${empty[0].name} has never been invoiced and can be archived.`
          : `The other ${empty.length} have never been invoiced and can be archived.`
      }`,
    }
  }

  return {
    side: clash.side,
    address: clash.address,
    advice: 'choose',
    keepId: null,
    dispositions: dispositions.map((each) => ({ ...each, retirable: true })),
    because: `None of these ${many} has been invoiced, so nothing distinguishes them. Keep whichever ${one} is the one you meant and archive the rest.`,
  }
}

/**
 * Every clash, resolved against one pool of footprints.
 *
 * The pool is both registers at once rather than one per side, because the
 * caller has both lists already and splitting them would mean deciding twice
 * which side a footprint belongs to. Ids are unique across both tables, so a
 * clash only ever finds its own.
 */
export function resolveAll(clashes: Clash[], footprints: Footprint[]): Resolution[] {
  return clashes.map((clash) => resolve(clash, footprints))
}

/** The ids of every party caught in any clash, for marking them on a list. */
export function partiesInClashes(clashes: Clash[]): Set<string> {
  return new Set(clashes.flatMap((clash) => clash.parties.map((party) => party.id)))
}
