/**
 * Proving you are still there (Phase 99).
 *
 * ## The guard three acts shared and two forgot
 *
 * `disableMfa` has asked for the current password since Phase 13, and its
 * docstring says exactly why:
 *
 * > an unattended browser is the exact situation MFA is protecting against,
 * > and "switch off the protection" is the first thing somebody sitting at one
 * > would do.
 *
 * `changePassword` asks too. Two acts beside them do not, and both move the way
 * back into an account:
 *
 * - **`regenerateRecoveryCodes`**, unguarded since Phase 13. Recovery codes are
 *   a way in. Regenerating them destroys the ones the real owner has written
 *   down and hands ten fresh ones to whoever is sitting at the screen — the
 *   same situation `disableMfa` refuses, with a better prize.
 * - **`requestAddressChange`**, unguarded since Phase 98 — this codebase's own
 *   most recent work, and its ADR admitted the gap rather than fixing it:
 *   *"Somebody who walks up to an unlocked session can start a claim."*
 *
 * ## The rule, said once
 *
 * > **An act that changes how you get back in must prove you are still there.**
 *
 * Not "acts on the security page", which is where the reasoning would have
 * gone if the question were asked by looking at the screen. Exporting the
 * company's data is on that page and does not qualify: it is a read, it changes
 * nothing about access, and guarding it would train people to type their
 * password for the ordinary. Ending another device's session does not qualify
 * either — it *removes* access rather than granting it, and somebody who wants
 * to lock a stranger out of their books should not be slowed down.
 *
 * What qualifies is narrow and worth naming: the password, the second factor,
 * the recovery codes, and the address recovery is sent to. Between them they
 * are every route back in this application has.
 *
 * ## Each act says why, rather than carrying a flag
 *
 * `ACTS` gives each one a sentence. That is Phase 70's `Reach` device applied
 * again, and for the same reason it gave: *so the next one somebody adds has to
 * answer the question that matters rather than copy a flag from the row above
 * it.* A boolean would have let `requestAddressChange` be added with `false`
 * and no argument, which is roughly what happened.
 *
 * ## One refusal, not two
 *
 * `disableMfa` said *"That password is not right."* and `changePassword` said
 * *"That is not your current password."* — two sentences for one event, on one
 * screen, which is the defect this codebase keeps removing. There is one now.
 *
 * Nothing here touches the database or the clock.
 */

/** The acts that move a route back into an account. */
export type GuardedAct =
  | 'password.change'
  | 'mfa.disable'
  | 'mfa.recovery_codes'
  | 'address.claim'

export type Guarded = {
  act: GuardedAct
  /**
   * Why this one needs the password, in the words somebody would use to argue
   * for it. Kept as prose rather than a category, because the argument is the
   * thing worth reading when a fifth act is added.
   */
  because: string
  /** What the field above the box is labelled. */
  prompt: string
}

const ACTS: Record<GuardedAct, Guarded> = {
  'password.change': {
    act: 'password.change',
    because:
      'The password is the way in. Somebody who can set a new one without knowing the old one has taken the account, not changed a setting.',
    prompt: 'Your current password',
  },
  'mfa.disable': {
    act: 'mfa.disable',
    because:
      'An unattended browser is the exact situation two-factor authentication protects against, and switching it off is the first thing somebody sitting at one would do.',
    prompt: 'Your password, to switch it off',
  },
  'mfa.recovery_codes': {
    act: 'mfa.recovery_codes',
    because:
      'Recovery codes are a way in. Regenerating them destroys the ones the owner wrote down and hands ten fresh ones to whoever is at the screen.',
    prompt: 'Your password, to replace the codes',
  },
  'address.claim': {
    act: 'address.claim',
    because:
      'Password resets go to the sign-in address, so moving it moves the way back in. It is the first move in taking an account over, and Phase 98 shipped without asking.',
    prompt: 'Your password, to confirm it is you',
  },
}

export function guardFor(act: GuardedAct): Guarded {
  return ACTS[act]
}

export function everyGuardedAct(): Guarded[] {
  return Object.values(ACTS)
}

export type GuardVerdict = { ok: true } | { ok: false; why: string }

/**
 * The one sentence a wrong password gets, everywhere.
 *
 * Deliberately the same whether the password was blank, wrong, or the account
 * has none: three different answers would tell somebody holding a borrowed
 * session which of those they are up against.
 */
export const WRONG_PASSWORD = 'That is not your password. Nothing has changed.'

/**
 * Whether an act may go ahead.
 *
 * `matches` is decided by the caller, which is the only place that can hash and
 * compare. This function exists so the *answer* — including its wording and its
 * treatment of a blank box — is decided once rather than in four service
 * functions that would drift.
 */
export function guardVerdict(input: {
  act: GuardedAct
  given: string | null | undefined
  matches: boolean
}): GuardVerdict {
  if (!input.given?.trim()) return { ok: false, why: WRONG_PASSWORD }
  if (!input.matches) return { ok: false, why: WRONG_PASSWORD }

  return { ok: true }
}
