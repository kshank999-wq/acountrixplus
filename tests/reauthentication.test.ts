import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { actionTokens, transactionalMessages, users } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { changePassword, disableMfa, regenerateRecoveryCodes } from '@/modules/auth/mfa'
import { requestAddressChange } from '@/modules/notify/email-change'
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

/**
 * The guard, on the four acts themselves.
 *
 * The core above proves the rule is written down. These prove it is *applied*
 * — which is the failure mode this phase exists to fix, since Phase 13 wrote
 * the argument in `disableMfa`'s docstring and two acts were added afterwards
 * without reading it.
 */
describe('against the database', () => {
  const PASSWORD = 'correct-horse-battery'
  const WRONG = 'not-the-password'

  let fixture: Fixture

  beforeEach(async () => {
    fixture = await createCompanyFixture({ name: 'Guarded Co' })
  })

  const emailNow = async () => {
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, fixture.ctx.userId))
    return row.email
  }

  it('refuses to change the password without the old one', async () => {
    const result = await changePassword(fixture.ctx, {
      currentPassword: WRONG,
      newPassword: 'a-brand-new-password',
    })

    expect(result).toEqual({ ok: false, error: WRONG_PASSWORD })
  })

  it('refuses to switch off two-factor without it', async () => {
    const result = await disableMfa(fixture.ctx.userId, WRONG)
    expect(result).toEqual({ ok: false, error: WRONG_PASSWORD })
  })

  it('refuses to replace recovery codes without it', async () => {
    // Unguarded from Phase 13 to Phase 99. Regenerating destroys the printout
    // the owner has and hands ten fresh codes to whoever is at the screen.
    await expect(
      regenerateRecoveryCodes(fixture.ctx.userId, WRONG),
    ).rejects.toThrow(WRONG_PASSWORD)
  })

  it('refuses to claim a new sign-in address without it', async () => {
    // Unguarded in Phase 98, whose own ADR admitted it.
    const result = await requestAddressChange(fixture.ctx, {
      requested: 'somewhere-else@hartleyco.test',
      companyName: 'Guarded Co',
      currentPassword: WRONG,
    })

    expect(result).toEqual({ accepted: false, error: WRONG_PASSWORD })
  })

  it('sends no letter and starts no claim when the password is wrong', async () => {
    const before = await emailNow()

    await requestAddressChange(fixture.ctx, {
      requested: 'somewhere-else@hartleyco.test',
      companyName: 'Guarded Co',
      currentPassword: WRONG,
    })

    // Not one letter — including to the address being left, which would
    // otherwise be a way to post mail at somebody by guessing passwords.
    const letters = await db.select({ id: transactionalMessages.id }).from(transactionalMessages)
    expect(letters).toHaveLength(0)

    const tokens = await db
      .select({ id: actionTokens.id })
      .from(actionTokens)
      .where(eq(actionTokens.purpose, 'email_change'))
    expect(tokens).toHaveLength(0)
    expect(await emailNow()).toBe(before)
  })

  it('asks before saying anything about the address itself', async () => {
    // The refusal for a wrong password must not depend on what was typed in
    // the other box: "that is already your address" would answer a question
    // on behalf of whoever is holding the session.
    const result = await requestAddressChange(fixture.ctx, {
      requested: await emailNow(),
      companyName: 'Guarded Co',
      currentPassword: WRONG,
    })

    expect(result).toEqual({ accepted: false, error: WRONG_PASSWORD })
  })

  it('lets the right password through', async () => {
    const result = await requestAddressChange(fixture.ctx, {
      requested: 'somewhere-else@hartleyco.test',
      companyName: 'Guarded Co',
      currentPassword: PASSWORD,
    })

    expect(result).toEqual({ accepted: true })
  })
})
