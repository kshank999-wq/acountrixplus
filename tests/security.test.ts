import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { loginAttempts, securityPolicies, userMfa, users } from '@/db/schema'
import { createCompanyFixture, addUserWithRole } from './helpers'
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpCodeForStep,
  totpStep,
  verifyTotp,
} from '@/modules/auth/totp'
import { decryptSecret, encryptSecret, isEncrypted } from '@/modules/auth/secret-box'
import { WRONG_PASSWORD } from '@/modules/auth/reauthentication'
import {
  beginEnrollment,
  changePassword,
  confirmEnrollment,
  disableMfa,
  hasConfirmedMfa,
  mfaStatus,
  regenerateRecoveryCodes,
  verifyChallenge,
} from '@/modules/auth/mfa'
import {
  challengeSubject,
  issueChallenge,
  readChallenge,
} from '@/modules/auth/challenge'
import {
  lockoutState,
  loginHistoryForUser,
  recordLoginAttempt,
  truncateIp,
} from '@/modules/auth/login-history'
import { exportCompanyData, toCsv } from '@/modules/tenancy/export'
import { revokeAllOtherDevices } from '@/modules/mobile/devices'
import { createSession, resolveSession, signSessionId } from '@/modules/auth/session'
import { registerDevice } from '@/modules/mobile/devices'
import { createCustomer, createInvoice } from '@/modules/receivables/service'

/**
 * Security controls (spec §14, §19).
 *
 * The claim under test: **a stolen password is not enough, and every attempt
 * to use one is on the record.** Each block below is one way that could be
 * false.
 */

describe('TOTP against the published vectors', () => {
  // RFC 6238 Appendix B. The secret is the ASCII string "12345678901234567890"
  // — the whole point of testing against these is that they were computed by
  // somebody else.
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

  it('reproduces RFC 6238 Appendix B', () => {
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
    ]

    for (const [seconds, expected] of vectors) {
      expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected)
    }
  })

  it('round-trips base32', () => {
    const buffer = Buffer.from('12345678901234567890', 'ascii')
    expect(base32Decode(base32Encode(buffer))).toEqual(buffer)
    // Apps show the secret in groups of four; people paste what they see.
    expect(base32Decode('GEZD GNBV GY3T QOJQ')).toEqual(Buffer.from('1234567890', 'ascii'))
  })

  it('counts steps of thirty seconds', () => {
    expect(totpStep(0)).toBe(0)
    expect(totpStep(29_999)).toBe(0)
    expect(totpStep(30_000)).toBe(1)
  })

  it('accepts one step of drift either way, and no more', () => {
    const secret = generateTotpSecret()
    const now = 1_800_000_000_000
    const step = totpStep(now)

    expect(verifyTotp(secret, totpCodeForStep(secret, step), now).ok).toBe(true)
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 1), now).ok).toBe(true)
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 1), now).ok).toBe(true)

    // Two steps out is a minute, and widening the window is the usual "fix"
    // for support tickets that multiplies the guessing surface.
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 2), now).ok).toBe(false)
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 2), now).ok).toBe(false)
  })

  it('refuses a code that has already been used', () => {
    const secret = generateTotpSecret()
    const now = 1_800_000_000_000
    const step = totpStep(now)
    const code = totpCodeForStep(secret, step)

    const first = verifyTotp(secret, code, now, null)
    expect(first).toEqual({ ok: true, step })

    // The same code, inside its own window, with the previous step recorded.
    // Without this a code read over a shoulder works for a full minute.
    expect(verifyTotp(secret, code, now, step)).toEqual({
      ok: false,
      reason: 'already_used',
    })

    // The next one still works.
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 1), now, step).ok).toBe(true)
  })

  it('rejects anything that is not six digits', () => {
    const secret = generateTotpSecret()
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad, Date.now()).ok).toBe(false)
    }
  })

  it('names the issuer twice, because apps disagree about which they read', () => {
    const uri = otpauthUri({
      secretBase32: 'ABCDEFGH',
      accountName: 'owner@example.com',
      issuer: 'Ridgeline',
    })

    expect(uri).toContain('otpauth://totp/Ridgeline%3Aowner%40example.com')
    expect(uri).toContain('issuer=Ridgeline')
    expect(uri).toContain('period=30')
  })
})

describe('secrets at rest', () => {
  it('round-trips, and looks nothing like the plaintext', () => {
    const secret = generateTotpSecret()
    const stored = encryptSecret(secret)

    expect(stored).not.toContain(secret)
    expect(isEncrypted(stored)).toBe(true)
    expect(decryptSecret(stored)).toBe(secret)
  })

  it('gives a different ciphertext each time', () => {
    // A fresh IV per encryption. Identical ciphertexts would tell anybody
    // reading the table which users share a secret.
    const secret = generateTotpSecret()
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret))
  })

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP')
    const parts = stored.split('.')
    const flipped = Buffer.from(parts[3], 'base64url')
    flipped[0] ^= 0xff

    // This is the whole reason for GCM over CBC: a modified secret must fail,
    // not quietly become a different secret.
    expect(() =>
      decryptSecret([parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.')),
    ).toThrow()
  })
})

describe('enrolling a second factor', () => {
  it('is not switched on until a code has worked', async () => {
    const fixture = await createCompanyFixture()

    const started = await beginEnrollment(fixture.userId)
    expect(started.secret).toMatch(/^[A-Z2-7]+$/)

    // The row exists and MFA is not on — which is what stops a mistyped secret
    // locking somebody out at their next sign-in.
    expect(await hasConfirmedMfa(fixture.userId)).toBe(false)
    expect((await mfaStatus(fixture.userId)).enrolled).toBe(false)

    const wrong = await confirmEnrollment(fixture.userId, '000000')
    expect(wrong.ok).toBe(false)
    expect(await hasConfirmedMfa(fixture.userId)).toBe(false)

    const result = await confirmEnrollment(fixture.userId, totpCode(started.secret, Date.now()))
    expect(result.ok).toBe(true)
    expect(await hasConfirmedMfa(fixture.userId)).toBe(true)
  })

  it('stores the secret encrypted, never in the clear', async () => {
    const fixture = await createCompanyFixture()
    const started = await beginEnrollment(fixture.userId)

    const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, fixture.userId))

    expect(row.secretEncrypted).not.toContain(started.secret)
    expect(isEncrypted(row.secretEncrypted)).toBe(true)
  })

  it('issues ten recovery codes, and any of them signs you in once', async () => {
    const fixture = await createCompanyFixture()
    const started = await beginEnrollment(fixture.userId)
    const result = await confirmEnrollment(fixture.userId, totpCode(started.secret, Date.now()))

    if (!result.ok) throw new Error('enrolment failed')
    expect(result.recoveryCodes).toHaveLength(10)

    const code = result.recoveryCodes[0]
    expect(await verifyChallenge(fixture.userId, code)).toEqual({
      ok: true,
      usedRecoveryCode: true,
    })

    // Single use. A recovery code that worked twice is a password.
    expect((await verifyChallenge(fixture.userId, code)).ok).toBe(false)
    expect((await mfaStatus(fixture.userId)).recoveryCodesRemaining).toBe(9)
  })

  it('never stores a recovery code in the clear', async () => {
    const fixture = await createCompanyFixture()
    const started = await beginEnrollment(fixture.userId)
    const result = await confirmEnrollment(fixture.userId, totpCode(started.secret, Date.now()))
    if (!result.ok) throw new Error('enrolment failed')

    const { mfaRecoveryCodes } = await import('@/db/schema')
    const stored = await db
      .select()
      .from(mfaRecoveryCodes)
      .where(eq(mfaRecoveryCodes.userId, fixture.userId))

    for (const row of stored) {
      for (const plain of result.recoveryCodes) {
        expect(row.codeHash).not.toContain(plain)
      }
    }
  })

  it('replaces old recovery codes when new ones are issued', async () => {
    const fixture = await createCompanyFixture()
    const started = await beginEnrollment(fixture.userId)
    const first = await confirmEnrollment(fixture.userId, totpCode(started.secret, Date.now()))
    if (!first.ok) throw new Error('enrolment failed')

    const second = await regenerateRecoveryCodes(fixture.userId, 'correct-horse-battery')
    expect(second).toHaveLength(10)

    // An old printout must stop working, or regenerating achieves nothing.
    expect((await verifyChallenge(fixture.userId, first.recoveryCodes[0])).ok).toBe(false)
    expect((await verifyChallenge(fixture.userId, second[0])).ok).toBe(true)
  })

  it('needs the password to be switched off', async () => {
    const fixture = await createCompanyFixture()
    const started = await beginEnrollment(fixture.userId)
    await confirmEnrollment(fixture.userId, totpCode(started.secret, Date.now()))

    // An unattended browser is exactly what MFA protects against, and turning
    // it off is the first thing somebody sitting at one would do.
    //
    // Asserted against the constant rather than a copy of the sentence. This
    // test used to spell out "That password is not right." and a second one
    // spelled out "That is not your current password." — two ways of saying
    // one thing, which is the duplication Phase 99's guard removed. Writing
    // the words here again would put a third copy back.
    expect(await disableMfa(fixture.userId, 'not-the-password')).toEqual({
      ok: false,
      error: WRONG_PASSWORD,
    })
    expect(await hasConfirmedMfa(fixture.userId)).toBe(true)

    expect(await disableMfa(fixture.userId, 'correct-horse-battery')).toEqual({ ok: true })
    expect(await hasConfirmedMfa(fixture.userId)).toBe(false)
  })

  it('will not silently replace a working second factor', async () => {
    const fixture = await createCompanyFixture()
    const started = await beginEnrollment(fixture.userId)
    await confirmEnrollment(fixture.userId, totpCode(started.secret, Date.now()))

    await expect(beginEnrollment(fixture.userId)).rejects.toThrow(/already switched on/)
  })
})

describe('the challenge between the two sign-in steps', () => {
  it('is not readable when tampered with', () => {
    const passwordHash = 'scrypt$fake$hash'
    const token = issueChallenge({ userId: 'a1b2', passwordHash })

    expect(readChallenge(token, { passwordHash })).toMatchObject({ userId: 'a1b2' })
    expect(readChallenge(`${token}x`, { passwordHash })).toBeNull()
    expect(readChallenge(token.replace('a1b2', 'c3d4'), { passwordHash })).toBeNull()
  })

  it('dies when the password changes', () => {
    const token = issueChallenge({ userId: 'a1b2', passwordHash: 'old-hash' })

    // Somebody who has just realised their password was stolen is trying to
    // invalidate exactly this.
    expect(readChallenge(token, { passwordHash: 'new-hash' })).toBeNull()
  })

  it('expires', () => {
    const passwordHash = 'scrypt$fake$hash'
    const now = new Date('2026-08-15T10:00:00Z')
    const token = issueChallenge({ userId: 'a1b2', passwordHash, now })

    expect(readChallenge(token, { passwordHash, now: new Date('2026-08-15T10:04:00Z') })).not.toBeNull()
    expect(readChallenge(token, { passwordHash, now: new Date('2026-08-15T10:06:00Z') })).toBeNull()
  })

  it('names its subject without validating anything', () => {
    const token = issueChallenge({ userId: 'a1b2', passwordHash: 'hash' })
    expect(challengeSubject(token)).toBe('a1b2')
    expect(challengeSubject(undefined)).toBeNull()
    expect(challengeSubject('nonsense')).toBeNull()
  })
})

describe('login history and lockout', () => {
  it('keeps the network, not the host', () => {
    // Enough to tell "the usual place" from "somewhere new" without keeping a
    // movement log for every person who uses the product.
    expect(truncateIp('203.0.113.47')).toBe('203.0.113.0/24')
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::/48')
    // `x-forwarded-for` is a list; the client is first.
    expect(truncateIp('203.0.113.47, 10.0.0.1')).toBe('203.0.113.0/24')
    expect(truncateIp(null)).toBeNull()
    expect(truncateIp('garbage')).toBeNull()
  })

  it('locks out after repeated failures, and a success clears the count', async () => {
    const email = `lockout-${Date.now()}@example.test`

    for (let attempt = 0; attempt < 9; attempt++) {
      await recordLoginAttempt({ email, outcome: 'wrong_password' })
    }
    expect((await lockoutState(email)).locked).toBe(false)

    await recordLoginAttempt({ email, outcome: 'wrong_password' })
    const locked = await lockoutState(email)
    expect(locked.locked).toBe(true)
    expect(locked.retryAfter).not.toBeNull()

    // Somebody who fat-fingers their password across a working day should not
    // accumulate a lockout they did nothing to earn.
    await recordLoginAttempt({ email, outcome: 'success' })
    expect((await lockoutState(email)).locked).toBe(false)
  })

  it('does not extend the lock every time somebody retries', async () => {
    const email = `retry-${Date.now()}@example.test`

    for (let attempt = 0; attempt < 10; attempt++) {
      await recordLoginAttempt({ email, outcome: 'wrong_password' })
    }
    const first = await lockoutState(email)

    // A `locked_out` row is the *result* of the lock, not a new failure.
    await recordLoginAttempt({ email, outcome: 'locked_out' })
    await recordLoginAttempt({ email, outcome: 'locked_out' })

    const second = await lockoutState(email)
    expect(second.failedCount).toBe(first.failedCount)
  })

  it('records which failure it was, not just that there was one', async () => {
    const fixture = await createCompanyFixture()
    const email = `outcomes-${Date.now()}@example.test`

    await recordLoginAttempt({ email, userId: fixture.userId, outcome: 'unknown_email' })
    await recordLoginAttempt({ email, userId: fixture.userId, outcome: 'wrong_mfa_code' })
    await recordLoginAttempt({ email, userId: fixture.userId, outcome: 'reused_mfa_code' })

    const history = await loginHistoryForUser(fixture.userId)
    const outcomes = history.map((row) => row.outcome)

    // A reused code means somebody else saw one — a different and worse event
    // than a wrong code, and a boolean would lose that.
    expect(outcomes).toContain('reused_mfa_code')
    expect(outcomes).toContain('wrong_mfa_code')
  })

  it('expires the window', async () => {
    const email = `window-${Date.now()}@example.test`
    for (let attempt = 0; attempt < 10; attempt++) {
      await recordLoginAttempt({ email, outcome: 'wrong_password' })
    }

    expect((await lockoutState(email)).locked).toBe(true)
    // Sixteen minutes later, with a fifteen-minute window.
    const later = new Date(Date.now() + 16 * 60_000)
    expect((await lockoutState(email, { now: later })).locked).toBe(false)
  })
})

describe('sessions and revocation', () => {
  it('signs out everywhere else and leaves this one alone', async () => {
    const fixture = await createCompanyFixture()

    const here = await registerDevice({
      userId: fixture.userId,
      companyId: fixture.companyId,
      userAgent: 'Here/1.0',
    })
    const elsewhere = await registerDevice({
      userId: fixture.userId,
      companyId: fixture.companyId,
      userAgent: 'Elsewhere/1.0',
    })

    const kept = await createSession(fixture.userId, fixture.companyId, here.id)
    const lost = await createSession(fixture.userId, fixture.companyId, elsewhere.id)

    const result = await revokeAllOtherDevices(fixture.ctx, here.id)
    expect(result.sessionsEnded).toBeGreaterThanOrEqual(1)

    expect(await resolveSession(kept.cookieValue)).not.toBeNull()
    expect(await resolveSession(lost.cookieValue)).toBeNull()
  })

  it('ends a session with no device, which a device sweep would miss', async () => {
    const fixture = await createCompanyFixture()

    const here = await registerDevice({
      userId: fixture.userId,
      companyId: fixture.companyId,
      userAgent: 'Here/1.0',
    })
    const kept = await createSession(fixture.userId, fixture.companyId, here.id)
    // No device — every session created before Phase 8 looks like this, and it
    // is exactly the one an attacker would rather keep.
    const orphan = await createSession(fixture.userId, fixture.companyId, null)

    await revokeAllOtherDevices(fixture.ctx, here.id)

    expect(await resolveSession(kept.cookieValue)).not.toBeNull()
    expect(await resolveSession(orphan.cookieValue)).toBeNull()
  })

  it('changing a password signs out everywhere else', async () => {
    const fixture = await createCompanyFixture()

    const stolen = await createSession(fixture.userId, fixture.companyId, null)
    const mine = await createSession(fixture.userId, fixture.companyId, null)

    const result = await changePassword(fixture.ctx, {
      currentPassword: 'correct-horse-battery',
      newPassword: 'a-brand-new-password',
      currentSessionId: mine.session.id,
    })

    expect(result.ok).toBe(true)

    // The whole point. A new password on its own leaves the attacker signed in
    // while the victim congratulates themselves.
    expect(await resolveSession(stolen.cookieValue)).toBeNull()
    expect(await resolveSession(mine.cookieValue)).not.toBeNull()
  })

  it('refuses a password change without the current password', async () => {
    const fixture = await createCompanyFixture()

    const result = await changePassword(fixture.ctx, {
      currentPassword: 'wrong',
      newPassword: 'a-brand-new-password',
    })

    // Same sentence as every other guarded act refuses with (Phase 99).
    expect(result).toEqual({ ok: false, error: WRONG_PASSWORD })
  })

  it('honours the company session length', async () => {
    const fixture = await createCompanyFixture()

    await db
      .insert(securityPolicies)
      .values({ companyId: fixture.companyId, sessionTtlDays: 1 })

    const { session } = await createSession(fixture.userId, fixture.companyId, null)
    const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000

    expect(days).toBeLessThan(1.1)
    expect(days).toBeGreaterThan(0.9)
  })

  it('rejects a forged session cookie', async () => {
    const fixture = await createCompanyFixture()
    const { session, cookieValue } = await createSession(fixture.userId, fixture.companyId, null)

    expect(await resolveSession(cookieValue)).not.toBeNull()
    // Right id, wrong signature.
    expect(await resolveSession(`${session.id}.not-a-real-signature`)).toBeNull()
    // Right signature over a different id.
    expect(await resolveSession(signSessionId('00000000-0000-0000-0000-000000000000'))).toBeNull()
  })
})

describe('exporting a company’s data', () => {
  it('quotes fields that would otherwise shift every column', () => {
    const csv = toCsv(
      [
        { name: 'Smith, Jones & Co', memo: 'Line one\nline two', note: 'He said "no"' },
        { name: 'Plain', memo: null, note: undefined },
      ],
      ['name', 'memo', 'note'],
    )

    expect(csv).toContain('"Smith, Jones & Co"')
    expect(csv).toContain('"Line one\nline two"')
    expect(csv).toContain('"He said ""no"""')
    // Nulls are empty, not the string "null".
    expect(csv).toContain('Plain,,\r\n')
  })

  it('produces something an accountant could rebuild the books from', async () => {
    const fixture = await createCompanyFixture()
    const revenue = await fixture.account('4100')
    const customer = await createCustomer(fixture.ctx, { name: 'Harborview, LLC' })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          chartAccountId: revenue.id,
          description: 'Consulting',
          quantityMilli: 1000,
          unitPriceCents: 108_000,
        },
      ],
    })

    const result = await exportCompanyData(fixture.ctx)
    const journal = result.files.find((file) => file.name === 'journal.csv')!

    // Account number and name, not an id: an export whose keys point at rows
    // in another file is a database dump, not something a person can read.
    expect(journal.content).toContain('4100')
    expect(journal.content).toContain('Service Revenue')
    // Money in units. A file showing 108000 for $1,080.00 is not an export.
    expect(journal.content).toContain('1080.00')
    expect(journal.content).not.toContain('108000')

    const customers = result.files.find((file) => file.name === 'customers.csv')!
    expect(customers.content).toContain('"Harborview, LLC"')

    expect(result.rowCount).toBeGreaterThan(0)
  })

  it('is recorded, because it is the broadest read anybody can perform', async () => {
    const fixture = await createCompanyFixture()
    await exportCompanyData(fixture.ctx, { datasets: ['chart_of_accounts'] })

    const { dataExports, auditEvents } = await import('@/db/schema')

    const exports = await db
      .select()
      .from(dataExports)
      .where(eq(dataExports.companyId, fixture.companyId))
    expect(exports).toHaveLength(1)
    expect(exports[0].datasets).toBe('chart_of_accounts')

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.companyId, fixture.companyId))
    expect(audit.some((row) => row.action === 'data.export')).toBe(true)
  })

  it('refuses a role that cannot see the ledger in the first place', async () => {
    const fixture = await createCompanyFixture()
    // Marketing has no ledger access; being able to take it home in a file
    // would make the permission decorative.
    const marketing = await addUserWithRole(fixture, 'marketing')

    await expect(exportCompanyData(marketing)).rejects.toThrow()
  })

  it('exports only this company', async () => {
    const one = await createCompanyFixture({ name: 'One Co' })
    const two = await createCompanyFixture({ name: 'Two Co' })

    await createCustomer(one.ctx, { name: 'Only In One' })
    await createCustomer(two.ctx, { name: 'Only In Two' })

    const result = await exportCompanyData(one.ctx, { datasets: ['customers'] })
    const customers = result.files[0].content

    expect(customers).toContain('Only In One')
    expect(customers).not.toContain('Only In Two')
  })
})

describe('the require-MFA policy', () => {
  it('is off by default and stored when set', async () => {
    const fixture = await createCompanyFixture()
    const { securityPolicy } = await import('@/modules/auth/login-history')

    expect((await securityPolicy(fixture.companyId)).requireMfa).toBe(false)

    await db
      .insert(securityPolicies)
      .values({ companyId: fixture.companyId, requireMfa: true })

    expect((await securityPolicy(fixture.companyId)).requireMfa).toBe(true)
  })

  it('refuses settings that would lock everybody out', async () => {
    const fixture = await createCompanyFixture()

    // Zero attempts locks everybody out immediately; a zero-day session signs
    // them out on arrival. Both are typos with no legitimate use, and the
    // database is what refuses rather than a check somebody could route around.
    await expect(
      db
        .insert(securityPolicies)
        .values({ companyId: fixture.companyId, maxFailedAttempts: 0 }),
    ).rejects.toThrow()
  })
})

describe('the sign-in record itself', () => {
  it('stores an attempt for an address that matches nothing', async () => {
    const email = `nobody-${Date.now()}@example.test`
    await recordLoginAttempt({ email, outcome: 'unknown_email', ip: '198.51.100.9' })

    const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email))

    // "Somebody is trying addresses that are not ours" is the signal that a
    // list is being worked through, and it is invisible if only known users
    // are recorded.
    expect(row.userId).toBeNull()
    expect(row.ipPrefix).toBe('198.51.100.0/24')
  })

  it('never records a password', async () => {
    const fixture = await createCompanyFixture()
    const [user] = await db.select().from(users).where(eq(users.id, fixture.userId))

    await recordLoginAttempt({
      email: user.email,
      userId: user.id,
      outcome: 'wrong_password',
      userAgent: 'Mozilla/5.0',
    })

    const rows = await db.select().from(loginAttempts).where(eq(loginAttempts.userId, user.id))
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain('correct-horse-battery')
    }
  })
})
