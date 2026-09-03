/**
 * Changing the address you sign in with (Phase 98).
 *
 * ## The address you could not change
 *
 * The README has said, since Phase 19:
 *
 * > **No confirmed change of email.** Reset re-checks the current address, so
 * > the machinery is ready, but changing your email is still a direct write
 * > with no confirmation to either address.
 *
 * That understates it. There is no direct write either: the only `update(users)`
 * in the application sets `passwordHash`. Nothing has ever changed
 * `users.email`. A person who mistypes their address at registration, or leaves
 * the company whose domain it is on, or changes their name, is holding an
 * account whose only route back in — password reset — sends to an address that
 * no longer reaches them.
 *
 * The caveat is corrected in the README along with this phase, on Phase 91 and
 * Phase 97's reasoning: a wrong reason written down is more dangerous than
 * none, because the next person builds on it. This one would have had somebody
 * looking for a write to secure.
 *
 * ## The judgement: an address is not yours until you prove it
 *
 * So the change is a **claim**, not a write. Nothing about the account moves
 * until somebody opens the letter sent to the address being claimed. Until then
 * the old address still signs in, still receives resets, still works — a
 * half-finished change must not be able to lock anybody out, because the person
 * most likely to abandon one halfway is the person who mistyped.
 *
 * ## The judgement: the address you are leaving is told, and told without the link
 *
 * This is the part that matters, and it is easy to get wrong by sending one
 * letter instead of two.
 *
 * Moving the recovery address is the first move in taking an account over.
 * Somebody who has a session — a borrowed laptop, a shared machine, a stolen
 * cookie — can point recovery at an address they own, and from then on the real
 * owner is locked out of their own books. A confirmation sent only to the new
 * address is a letter sent only to the attacker.
 *
 * So two letters go out: the **confirmation**, to the address being claimed,
 * carrying the link; and the **notice**, to the address being left, carrying no
 * link at all. The notice is a warning, not a second way to finish the job —
 * a link in it would let whoever holds the old address complete a change they
 * never asked for, which is the same defect wearing the other coat.
 *
 * Phase 91 made the same distinction for a different reason: *the body is what
 * was said; the link is what it granted*. Here the granting is exactly what the
 * second letter must not do.
 *
 * ## The judgement: it says the same thing whether or not the address is taken
 *
 * `requestPasswordReset` already decided this — *"sends a letter if the address
 * belongs to somebody, and says exactly the same thing either way"* — and a
 * screen that answered differently would make this the one page in the
 * application that confirms whether an account exists. The claim is accepted,
 * and quietly does nothing when the address is somebody else's.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * The address as this application matches it when somebody signs in.
 *
 * `trim().toLowerCase()`, which is what `requestPasswordReset` and registration
 * have always done inline. Named here so the new code and the reset path read
 * the same function rather than two copies that could drift; the remaining
 * inline copies in `onboarding.ts` are noted in the README rather than
 * refactored in a phase about something else.
 */
export function normaliseLogin(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/**
 * Whether a string could be an address at all.
 *
 * Deliberately shallow: one `@`, something either side, no whitespace. A
 * stricter pattern rejects addresses that genuinely work, and the real proof is
 * the letter — an address that cannot receive one never gets confirmed, which
 * is a better test than any regular expression.
 */
export function looksLikeAddress(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
}

export type ClaimVerdict = { ok: true; address: string } | { ok: false; why: string }

/**
 * Whether this claim may be made at all.
 *
 * Refuses only what is wrong with the request itself. Whether the address
 * belongs to somebody else is **not** checked here and must not be: see the
 * judgement above.
 */
export function claimCheck(input: { current: string; requested: string }): ClaimVerdict {
  const address = normaliseLogin(input.requested)

  if (!address) {
    return { ok: false, why: 'Type the address you want to use.' }
  }

  if (!looksLikeAddress(address)) {
    return { ok: false, why: 'That does not look like an email address.' }
  }

  if (address === normaliseLogin(input.current)) {
    return { ok: false, why: 'That is already the address you sign in with.' }
  }

  return { ok: true, address }
}

/** One of the two letters a claim sends. */
export type ChangeLetter = {
  to: string
  subject: string
  body: string[]
  /**
   * The link, on the one letter that carries it.
   *
   * Null on the notice, and the type says so rather than the caller
   * remembering: the notice going to the address being left must never be a
   * second way to complete the change.
   */
  url: string | null
}

/**
 * Both letters, decided together.
 *
 * Returned as a pair rather than two functions, because the property that
 * matters is a property of the pair — one link, sent to the address being
 * claimed, never to the one being left — and a rule split across two functions
 * is one somebody can later satisfy half of.
 */
export function lettersFor(input: {
  current: string
  requested: string
  companyName: string
  url: string
  /**
   * How long the link lasts, in minutes.
   *
   * Passed in rather than declared here. `TOKEN_TTL_MINUTES` has owned every
   * token's lifetime since Phase 19, and a second constant in this file that
   * had to agree with it is the defect this codebase keeps removing — the two
   * would drift the first time somebody shortened one of them.
   */
  ttlMinutes: number
}): { confirm: ChangeLetter; notice: ChangeLetter } {
  const current = normaliseLogin(input.current)
  const requested = normaliseLogin(input.requested)

  return {
    confirm: {
      to: requested,
      subject: `Confirm your new sign-in address for ${input.companyName}`,
      body: [
        /*
         * Both addresses named, rather than "to this one".
         *
         * Several addresses aliased into one inbox is ordinary, and somebody
         * reading a letter that says "this one" cannot tell which of theirs it
         * means — in a letter whose entire purpose is proving control of a
         * particular address.
         */
        `Somebody asked to change the address they sign in to ${input.companyName} with from ${current} to ${requested}.`,
        'If that was you, open the link below. Nothing changes until you do — until then you carry on signing in with the old address.',
        `The link works once and stops working after ${input.ttlMinutes} minutes.`,
        'If it was not you, ignore this. Nothing has happened to the account.',
      ],
      url: input.url,
    },
    notice: {
      to: current,
      subject: `Somebody asked to change your sign-in address for ${input.companyName}`,
      body: [
        `A request was made to move sign-in for ${input.companyName} from ${current} to ${requested}.`,
        `You are being told at ${current} because it is the address that would stop working, and because moving it is the first thing somebody does when they take an account over.`,
        'Nothing has changed yet. This message deliberately carries no link — if you did not ask for this, sign in and change your password, then check your active sessions.',
      ],
      // Deliberately null. See the type, and the judgement above.
      url: null,
    },
  }
}

export type RedemptionVerdict = { ok: true } | { ok: false; why: string }

/**
 * Whether a claim may still be completed when somebody opens the link.
 *
 * Time passes between the letter and the click, and the world moves: the
 * address may have been registered by somebody else in between, or the person
 * may have changed it again by another route. The token proves who asked and
 * for what; it cannot prove the answer is still available.
 */
export function redemptionCheck(input: {
  /** The address the token was issued for. */
  claimed: string
  /** The address the account signs in with right now. */
  current: string
  /** Whether the claimed address now belongs to somebody. */
  takenByAnother: boolean
}): RedemptionVerdict {
  if (input.takenByAnother) {
    return {
      ok: false,
      why: 'That address now belongs to another account. Sign in with your current address and try a different one.',
    }
  }

  if (normaliseLogin(input.claimed) === normaliseLogin(input.current)) {
    return {
      ok: false,
      why: 'That is already the address you sign in with, so there is nothing to confirm.',
    }
  }

  return { ok: true }
}
