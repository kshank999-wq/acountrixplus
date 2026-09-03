import { describe, expect, it } from 'vitest'
import {
  everyGuardedAct,
  guardFor,
  guardVerdict,
  WRONG_PASSWORD,
  type GuardedAct,
} from '@/modules/auth/reauthentication'

/**
 * Proving you are still there (Phase 99).
 *
 * The list at the top is a tripwire in the same shape Phase 70 and Phase 96
 * used: adding an act that moves a route back in, and not registering it, fails
 * here. Two acts reached production unguarded — one of them added four phases
 * before this one, one of them added *last* phase — so the list is the point.
 */

const ALL: GuardedAct[] = [
  'password.change',
  'mfa.disable',
  'mfa.recovery_codes',
  'address.claim',
]

describe('what the guard covers', () => {
  it('names every act that moves a route back in', () => {
    expect(everyGuardedAct().map((one) => one.act).sort()).toEqual([...ALL].sort())
  })

  it('makes each one argue for itself rather than carry a flag', () => {
    // Phase 70's device: a boolean would have let address.claim be added with
    // `false` and no argument, which is roughly what happened in Phase 98.
    for (const guarded of everyGuardedAct()) {
      expect(guarded.because.length).toBeGreaterThan(40)
      expect(guarded.prompt).toMatch(/password/i)
    }
  })

  it('gives no two acts the same prompt', () => {
    const prompts = everyGuardedAct().map((one) => one.prompt)
    expect(new Set(prompts).size).toBe(prompts.length)
  })

  it('covers the four routes back in and nothing else', () => {
    // The rule is "changes how you get back in", not "is on the security
    // page". Exporting data is a read; ending another device's session removes
    // access rather than granting it, and somebody locking a stranger out of
    // their books should not be slowed down.
    const acts = everyGuardedAct().map((one) => one.act)

    expect(acts).not.toContain('data.export')
    expect(acts).not.toContain('device.revoke')
  })
})

describe('the verdict', () => {
  it('lets a right password through', () => {
    expect(guardVerdict({ act: 'mfa.disable', given: 'correct horse', matches: true })).toEqual({
      ok: true,
    })
  })

  it('refuses a wrong one', () => {
    expect(guardVerdict({ act: 'mfa.disable', given: 'nope', matches: false })).toEqual({
      ok: false,
      why: WRONG_PASSWORD,
    })
  })

  it('refuses a blank box with the same sentence', () => {
    // Three different answers — blank, wrong, no password on the account —
    // would tell somebody holding a borrowed session which they are up
    // against.
    for (const given of [undefined, null, '', '   ']) {
      expect(guardVerdict({ act: 'address.claim', given, matches: true })).toEqual({
        ok: false,
        why: WRONG_PASSWORD,
      })
    }
  })

  it('says the same thing for every act', () => {
    const refusals = ALL.map(
      (act) => (guardVerdict({ act, given: 'wrong', matches: false }) as { why: string }).why,
    )

    // Two sentences for one event was the defect: disableMfa said "That
    // password is not right." and changePassword said "That is not your
    // current password.", on the same screen.
    expect(new Set(refusals).size).toBe(1)
  })

  it('says nothing has changed, because nothing has', () => {
    expect(WRONG_PASSWORD).toContain('Nothing has changed')
  })
})

describe('guardFor', () => {
  it('hands back the act it was asked for', () => {
    expect(guardFor('address.claim').act).toBe('address.claim')
    expect(guardFor('address.claim').because).toContain('resets go to the sign-in address')
  })
})
