import { BRAND } from './identity'

/**
 * Whose name goes on a letter (spec §8, §19, Phase 74).
 *
 * ## One string, two opposite meanings
 *
 * `'Accountrix Plus'` was written as a literal in six modules, and it meant two
 * different things depending on which one you were reading:
 *
 * 1. **This letter is from the product.** A password reset, an invitation, the
 *    issuer in somebody's authenticator app, the `/Producer` of a PDF, the
 *    actor on an automatic send in the communications log. All correct: those
 *    letters *are* from us, and signing them with a company's name would be a
 *    lie in the other direction.
 *
 * 2. **We do not know whose letter this is, so use ours.** One place, and it is
 *    the one that matters:
 *
 *    ```ts
 *    fromName: campaign.fromName ?? profile?.legalName ?? 'Accountrix Plus'
 *    ```
 *
 *    That is a **marketing campaign a company sends to its own customers**.
 *    `companyProfiles` is optional and `legalName` is nullable, so a business
 *    that has not filled in the Design Center and did not name a sender on the
 *    campaign sends its own marketing from "Accountrix Plus" — to its own
 *    customers, under our name, over its own unsubscribe link.
 *
 * The company's actual name was never consulted. `companies.name` is
 * `NOT NULL`, it exists for every tenant from the moment they register, and
 * `campaigns.ts` did not load it.
 *
 * ## The rule
 *
 * > **A letter is either ours or theirs. Ours may carry our name; theirs never
 * > may.**
 *
 * ADR 0073 said the same thing about the mark — *"a customer's invoice is
 * their document, and putting our mark on it would be the same mistake as a
 * template that assumes one industry"* — and then this code did exactly that
 * with the sender line, where it is harder to see and reaches further.
 *
 * Nothing here touches the database or the clock.
 */

/** What the product signs its own letters with. */
export const OUR_NAME = BRAND.full

/**
 * The name on a letter a **company** sends to its own contacts.
 *
 * Three sources, in the order a business would expect: what they chose for
 * this campaign, then the legal name on their profile, then the name of the
 * company itself. The last one always exists, which is the point — the chain
 * ends somewhere real instead of falling through to us.
 *
 * Blank is not a choice. A sender field somebody emptied is the same as one
 * they never filled in, and `''` on the `From:` line of a marketing email is
 * how a message arrives from nobody.
 */
export function senderName(input: {
  /** What they typed on the campaign, if anything. */
  chosen?: string | null
  /** The legal name from their Design Center profile, if they have one. */
  legalName?: string | null
  /** The company's own name. Required, and required to be non-empty. */
  companyName: string
}): string {
  const company = input.companyName.trim()
  if (!company) {
    // Not a fallback: a company with no name is a broken tenant, and quietly
    // signing its post with ours would hide that rather than fix it.
    throw new Error('A company must have a name before it can send anything.')
  }

  return firstFilled(input.chosen, input.legalName) ?? company
}

function firstFilled(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? '').trim()
    if (trimmed) return trimmed
  }
  return null
}
