import { addressLines, type Letterhead } from '@/modules/brand/letterhead'

/**
 * Who a proposal is between, frozen at the moment it was offered (Phase 77).
 *
 * ## The defect
 *
 * A signed proposal is a contract, and this application froze everything about
 * one except the two parties to it.
 *
 * | Question | Where the answer lives | Does it move? |
 * | --- | --- | --- |
 * | What was offered | `proposal_versions.snapshot` | no |
 * | What the client looked at | `pdf_document_id`, content-addressed | no |
 * | Who signed, from where, against which version | `proposal_acceptances` | no |
 * | **Which two businesses are bound** | a walk to live rows | **yes** |
 *
 * The company side resolved through `companyId` to `companies` and
 * `company_profiles`; the client side through the opportunity to
 * `organizations`. Both are ordinary editable records — Phase 74 established
 * that people do rename a company in the Design Center, and ADR 0045 made
 * correcting a client a first-class action. Rename either, and every acceptance
 * ever made reports a contract with the new name.
 *
 * Phase 76 put both parties into the rendered PDF, permanently. That made the
 * gap worse rather than better: the picture is now right forever while the
 * queryable record still resolves live, so the two can disagree about who
 * agreed with whom.
 *
 * ## The rule
 *
 * > **A record of an agreement names the parties as they were, not as they are.**
 *
 * The same rule Phase 55 applied to a statement and Phase 62 to a payment's
 * currency: a claim about a moment does not get to move afterwards.
 *
 * Nothing here touches the database or the clock.
 */

export type Party = {
  /**
   * Every name this party went by, most formal first.
   *
   * A list rather than `name` plus `legalName`, because the two sides disagree
   * about which is which: a company is registered as one thing and trades as
   * another, while `organizations` has a single `name` and no registration at
   * all. Naming the fields for one side would leave the other holding a column
   * that is structurally always null.
   */
  names: string[]
  /** The postal address as it stood, one line each. */
  address: string[]
}

export type Parties = {
  offeredBy: Party
  offeredTo: Party
}

/** What a client organisation looked like when the offer was made. */
export type ClientParty = {
  name?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
}

/** A party with nothing on the record. Better than an empty string on a screen. */
export const UNNAMED = 'Unnamed'

export function partiesFor(input: {
  /** The offering company's letterhead, as Phase 75 built it. */
  letterhead: Letterhead
  client: ClientParty | null | undefined
}): Parties {
  const { letterhead } = input

  return {
    offeredBy: {
      // The letterhead leads with the registered name where there is one, and
      // keeps the trading name beside it — the same order the document prints.
      names: [letterhead.name, letterhead.tradingName].filter(nonEmpty),
      address: letterhead.address,
    },
    offeredTo: {
      names: [filled(input.client?.name) ?? UNNAMED],
      address: addressLines(input.client),
    },
  }
}

/**
 * What a proposal sent before Phase 77 can say about its parties: nothing.
 *
 * Deliberately not reconstructed from today's rows. Reading the live company
 * and organisation would produce a confident answer that is wrong in exactly
 * the case this record exists for — after somebody renamed one of them.
 */
export const NOT_RECORDED = 'Not recorded' as const

/** The party as a person reads it, for a screen or a letter. */
export function describeParty(party: Party): string {
  return [...party.names, ...party.address].join('\n')
}

/**
 * Whether a stored value is a `Parties` this module wrote.
 *
 * The column is `jsonb` and holds rows written by every version of this code
 * that ever ran, so a reader checks rather than assumes — the same forgiveness
 * `parseBlocks` applies on the document read path.
 */
export function isParties(value: unknown): value is Parties {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Parties>
  return isParty(candidate.offeredBy) && isParty(candidate.offeredTo)
}

function isParty(value: unknown): value is Party {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Party>
  return (
    Array.isArray(candidate.names) &&
    candidate.names.every((name) => typeof name === 'string') &&
    candidate.names.length > 0 &&
    Array.isArray(candidate.address) &&
    candidate.address.every((line) => typeof line === 'string')
  )
}

function nonEmpty(value: string | null | undefined): value is string {
  return Boolean(value && value.trim())
}

function filled(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed || null
}
