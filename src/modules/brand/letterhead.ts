import { senderName } from './voice'

/**
 * Who a company is, on a document it sends (spec §4, §8, Phase 75).
 *
 * ## The defect
 *
 * ADR 0074 nominated the shape of this: the Design Center's thirteen profile
 * boxes are `z.string().trim().max(200).optional()` with no `.min(1)`, and the
 * form is controlled, so a cleared box saves `''` rather than null — and `''`
 * does not trip `??`. Following that into the documents found something worse
 * than a blank-handling bug.
 *
 * **The invoice carries no letterhead at all.** `modules/pdf/invoice` puts
 * `companies.name` on the cover and the same string in the footer, and reads
 * nothing else from the profile except the payment instructions. No address,
 * no telephone number, no email, no website. A customer holding that invoice
 * cannot tell where the business is or how to reach it — on the one document
 * this application produces that a stranger receives, may have to pay against,
 * and in most places has to keep.
 *
 * The company had typed all of it in. Nothing asked for it.
 *
 * **And four spellings of the same question.** "What is this company called,
 * and how do you reach it" was answered four ways:
 *
 * | Where | What it said |
 * | --- | --- |
 * | `campaigns.ts` | `senderName({...})` — Phase 74 |
 * | `marketingRenderContext` | `profile?.legalName ?? company.name` |
 * | `proposalRenderContext` | `profile?.legalName \|\| company.name` |
 * | `pdf/invoice` | `company.name`, and no contact details at all |
 *
 * The middle two sit in the same file, thirty lines apart, and differ by one
 * character. `??` keeps `''` and `||` does not — so with the legal name
 * cleared, the proposal was right and the marketing preview showed a company
 * with no name. That is the Phase 74 defect still live, one file over.
 *
 * ## The rule
 *
 * > **A blank box is an unanswered question, not an answer.**
 *
 * Every field here is dropped when it is missing, null, or blank, and a line
 * made only of blanks is not printed. The letterhead of a company that has
 * filled in nothing is its name — which always exists — and nothing else.
 *
 * Nothing here touches the database or the clock.
 */

/** The profile fields a letterhead reads. All optional, all nullable. */
export type LetterheadProfile = {
  legalName?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  documentFooter?: string | null
}

export type Letterhead = {
  /** What to call them. Always present. */
  name: string
  /**
   * What they trade as, when that is not what they are registered as.
   *
   * `name` resolves to the registered name whenever they have given one,
   * because that is the name a payment has to reach. But the customer knows
   * them as "Ridgeline", not "Ridgeline Construction LLC", and an invoice from
   * a name they do not recognise is one that gets queried instead of paid.
   *
   * Null when the two are the same — printing a name twice reads as a bug.
   */
  tradingName: string | null
  /** Postal address, one line each, blanks dropped. */
  address: string[]
  /**
   * The three ways to reach them, kept apart rather than pre-joined.
   *
   * A PDF prints all three down the page; the customer-facing web page shows
   * the email as a `mailto:` and the phone as a `tel:`. A single joined string
   * would serve the first and force the second to take it apart again — which
   * is how one answer becomes two. `contactLines` is the joined view.
   */
  phone: string | null
  email: string | null
  website: string | null
  /** Whatever they chose to say at the foot of a document. */
  footer: string | null
}

export function letterheadFor(input: {
  /** `companies.name`. Not null, and the reason this always resolves. */
  companyName: string
  profile?: LetterheadProfile | null
}): Letterhead {
  const profile = input.profile ?? null

  // The same question Phase 74 answered for the `From:` line, so the same
  // answer. A letter's masthead and its sender cannot disagree.
  const name = senderName({ legalName: profile?.legalName, companyName: input.companyName })
  const trading = input.companyName.trim()

  return {
    name,
    tradingName: trading && trading !== name ? trading : null,
    address: addressLines(profile),
    phone: filled(profile?.phone),
    email: filled(profile?.email),
    website: filled(profile?.website),
    footer: filled(profile?.documentFooter),
  }
}

/** Telephone, email, website — whichever they gave, in that order. */
export function contactLines(letterhead: Letterhead): string[] {
  return lines(letterhead.phone, letterhead.email, letterhead.website)
}

/**
 * The address, laid out the way an envelope is.
 *
 * The city line is assembled first and then kept or dropped as a whole,
 * because "Seattle, " with a missing region is worse than "Seattle".
 */
export function addressLines(profile: LetterheadProfile | null | undefined): string[] {
  const cityRegion = join(', ', profile?.city, profile?.region)

  return lines(
    profile?.addressLine1,
    profile?.addressLine2,
    join(' ', cityRegion, filled(profile?.postalCode)),
    profile?.country,
  )
}

/** One block of text: the name, the address and the contact details. */
export function letterheadText(letterhead: Letterhead): string {
  return [
    letterhead.name,
    letterhead.tradingName && `trading as ${letterhead.tradingName}`,
    ...letterhead.address,
    ...contactLines(letterhead),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

/** Trimmed, or null when there is nothing there. */
function filled(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed || null
}

/** The values that are actually there, trimmed, in order. */
function lines(...values: Array<string | null | undefined>): string[] {
  return values.map(filled).filter((value): value is string => value !== null)
}

function join(separator: string, ...values: Array<string | null | undefined>): string | null {
  return lines(...values).join(separator) || null
}
