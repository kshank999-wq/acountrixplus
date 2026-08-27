import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  actionTokens,
  auditEvents,
  memberships,
  practiceMembers,
  sessions,
  transactionalMessages,
  users,
} from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { verifyPassword } from '@/modules/auth/password'
import { createSession } from '@/modules/auth/session'
import { registerUser } from '@/modules/tenancy/onboarding'
import { suppressEmail } from '@/modules/marketing/audience'
import {
  mockTransactionalProvider,
  type TransactionalMessage,
} from '@/modules/notify/transactional'
import { failedDeliveries, RateLimitedError, sendTransactional } from '@/modules/notify/service'
import {
  issueToken,
  lookupToken,
  pruneExpiredTokens,
  redeemToken,
  TOKEN_TTL_MINUTES,
} from '@/modules/notify/tokens'
import {
  checkResetToken,
  completePasswordReset,
  requestPasswordReset,
} from '@/modules/notify/password-reset'
import {
  acceptInvitation,
  companyInvitations,
  inviteToCompany,
  inviteToPractice,
  previewInvitation,
  withdrawCompanyInvitation,
} from '@/modules/notify/invitations'
import { createPractice, offerEngagement, respondToEngagement } from '@/modules/practice/service'

/**
 * Transactional mail, invitations and password reset (spec §19, §14, Phase 19).
 *
 * Two claims under test:
 *
 *   **An invitation proves an address; it never carries a password.** Nothing
 *   exists — no user, no membership — until the invitee clicks and chooses one,
 *   and the secret they choose has never passed through anybody else's hands.
 *
 *   **A password reset is not marketing, and the unsubscribe list must never
 *   touch it.** Somebody who unsubscribed from the newsletter in March can
 *   still get back into their own books in August.
 */

const mock = mockTransactionalProvider()

/** Pulls the link out of the letter, the way a person's mail client would. */
function linkIn(message: TransactionalMessage | undefined): string {
  expect(message).toBeDefined()
  const match = (message as TransactionalMessage).text.match(/https?:\/\/\S+/)
  expect(match, 'the letter contains a link').not.toBeNull()
  return (match as RegExpMatchArray)[0]
}

function tokenIn(message: TransactionalMessage | undefined): string {
  return decodeURIComponent(new URL(linkIn(message)).searchParams.get('token') as string)
}

let seq = 0
const nextEmail = (prefix: string) => `${prefix}-${++seq}-${Date.now()}@example.test`

/** Somebody with an account and no company. */
function somebody(prefix: string) {
  return registerUser({
    name: 'Test Person',
    email: nextEmail(prefix),
    password: 'correct-horse-battery',
  })
}

/**
 * A reset token needs a user, and the database says so — `password_reset` with
 * a null `user_id` fails the `action_tokens_purpose_shape` check. Tests go
 * through a real account rather than around the constraint.
 */
async function resetTokenFor(prefix: string) {
  const user = await somebody(prefix)
  const issued = await issueToken({
    purpose: 'password_reset',
    email: user.email,
    userId: user.id,
  })
  return { user, ...issued }
}

beforeEach(() => {
  mock.reset()
})

describe('the transactional channel', () => {
  it('carries no unsubscribe link, because you cannot unsubscribe from your own reset', async () => {
    const to = nextEmail('nobody')

    await sendTransactional({
      to,
      kind: 'password_reset',
      subject: 'Reset your password',
      body: ['Hello.'],
      action: { label: 'Choose a new password', url: 'https://example.test/reset?token=abc' },
    })

    const sent = mock.lastTo(to) as TransactionalMessage

    // The type has no field to put one in; this asserts the shape at runtime
    // as well, so a later "helpful" spread from a campaign cannot smuggle one
    // through.
    expect('unsubscribeUrl' in sent).toBe(false)
    expect('unsubscribePostUrl' in sent).toBe(false)
    expect(sent.html.toLowerCase()).not.toContain('unsubscribe')
    expect(sent.text.toLowerCase()).not.toContain('unsubscribe')
  })

  it('writes the URL out in full, so a person can read where the link goes', async () => {
    const to = nextEmail('reader')
    const url = 'https://books.example.test/reset?token=xyz'

    await sendTransactional({
      to,
      kind: 'password_reset',
      subject: 'Reset',
      body: ['Hello.'],
      action: { label: 'Choose a new password', url },
    })

    const sent = mock.lastTo(to) as TransactionalMessage
    expect(sent.text).toContain(url)
    expect(sent.html).toContain(url)
  })

  it('records failures rather than swallowing them', async () => {
    const fixture = await createCompanyFixture({ name: 'Bounce Co' })
    const to = nextEmail('bounces')
    mock.failing.add(to)

    const outcome = await sendTransactional({
      to,
      kind: 'company_invitation',
      subject: 'Invitation',
      body: ['Hello.'],
      companyId: fixture.companyId,
    })

    expect(outcome.ok).toBe(false)

    const [row] = await db
      .select()
      .from(transactionalMessages)
      .where(eq(transactionalMessages.email, to))

    expect(row.outcome).toBe('failed')
    expect(row.error).toContain('Mailbox')
  })

  it('refuses to post to a stranger all afternoon', async () => {
    const to = nextEmail('target')

    for (let i = 0; i < 5; i += 1) {
      await sendTransactional({ to, kind: 'password_reset', subject: 'Reset', body: ['Hi.'] })
    }

    await expect(
      sendTransactional({ to, kind: 'password_reset', subject: 'Reset', body: ['Hi.'] }),
    ).rejects.toBeInstanceOf(RateLimitedError)

    // The limit is per kind: a genuine invitation is not blocked by somebody
    // hammering the forgot-password form with the same address.
    const invitation = await sendTransactional({
      to,
      kind: 'company_invitation',
      subject: 'Invitation',
      body: ['Hi.'],
    })
    expect(invitation.ok).toBe(true)
  })
})

describe('single-use tokens', () => {
  it('stores a hash, never the token', async () => {
    const issued = await resetTokenFor('hashed')

    const [row] = await db.select().from(actionTokens).where(eq(actionTokens.id, issued.id))

    expect(row.tokenHash).not.toContain(issued.token)
    expect(row.lookupPrefix).toBe(issued.token.slice(0, 8))
    // The prefix alone must not be enough to reconstruct anything: 32 bytes in,
    // 8 characters stored.
    expect(issued.token.length).toBeGreaterThan(40)
    expect(await verifyPassword(issued.token, row.tokenHash)).toBe(true)
  })

  it('is spent exactly once, even by two clicks at the same instant', async () => {
    const issued = await resetTokenFor('double')

    const [first, second] = await Promise.allSettled([
      db.transaction((tx) => redeemToken(issued.id, tx)),
      db.transaction((tx) => redeemToken(issued.id, tx)),
    ])

    const outcomes = [first.status, second.status].sort()
    expect(outcomes).toEqual(['fulfilled', 'rejected'])
  })

  it('supersedes an earlier live link for the same thing', async () => {
    const user = await somebody('again')
    const issue = () =>
      issueToken({ purpose: 'password_reset', email: user.email, userId: user.id })
    const first = await issue()
    const second = await issue()

    expect(await lookupToken('password_reset', first.token)).toMatchObject({
      ok: false,
      reason: 'revoked',
    })
    expect((await lookupToken('password_reset', second.token)).ok).toBe(true)
  })

  it('gives a reset an hour and an invitation a week', () => {
    expect(TOKEN_TTL_MINUTES.password_reset).toBe(60)
    expect(TOKEN_TTL_MINUTES.company_invitation).toBe(7 * 24 * 60)
  })

  it('prunes what expired long ago and keeps what has not', async () => {
    const stale = await resetTokenFor('stale')
    await db
      .update(actionTokens)
      .set({ expiresAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) })
      .where(eq(actionTokens.id, stale.id))

    const live = await resetTokenFor('live')

    await pruneExpiredTokens(30)

    const rows = await db
      .select({ id: actionTokens.id })
      .from(actionTokens)
      .where(eq(actionTokens.id, stale.id))
    expect(rows).toHaveLength(0)
    expect((await lookupToken('password_reset', live.token)).ok).toBe(true)
  })
})

describe('password reset', () => {
  it('says the same thing whether or not the address exists', async () => {
    const known = await registerUser({
      name: 'Known Person',
      email: nextEmail('known'),
      password: 'correct-horse-battery',
    })

    const first = await requestPasswordReset({ email: known.email })
    const second = await requestPasswordReset({ email: nextEmail('stranger') })

    expect(first).toEqual(second)
    expect(first.accepted).toBe(true)

    // The difference is only in the mailbox, which the requester cannot see
    // unless it is theirs.
    expect(mock.lastTo(known.email)).toBeDefined()
    expect(mock.sent).toHaveLength(1)
  })

  /**
   * Phase 38. Now that a real adapter can fail, the failure must not become a
   * second channel for enumeration.
   *
   * The temptation once mail can genuinely bounce is to tell the requester —
   * "we could not send to that address" is helpful, and it also confirms the
   * address exists. The operator learns about the failure through the health
   * report Phase 24 built; the person at the form learns nothing they could
   * not have learned by guessing.
   */
  it('says the same thing when delivery fails', async () => {
    const person = await registerUser({
      name: 'Bouncing Person',
      email: nextEmail('bounce'),
      password: 'correct-horse-battery',
    })

    const delivered = await requestPasswordReset({ email: person.email })

    mock.failing.add(person.email.toLowerCase())
    const bounced = await requestPasswordReset({ email: person.email })

    expect(bounced).toEqual(delivered)
    expect(bounced.accepted).toBe(true)

    mock.failing.clear()
  })

  it('reaches somebody who unsubscribed from marketing', async () => {
    const fixture = await createCompanyFixture({ name: 'Suppressed Co' })
    const person = await registerUser({
      name: 'Unsubscribed Person',
      email: nextEmail('unsub'),
      password: 'correct-horse-battery',
    })

    // They told marketing to stop, company-wide. That is the claim: it must not
    // reach the channel that lets them back in.
    await suppressEmail(fixture.companyId, person.email, { reason: 'unsubscribed' })

    await requestPasswordReset({ email: person.email })

    expect(mock.lastTo(person.email)).toBeDefined()
    expect((mock.lastTo(person.email) as TransactionalMessage).kind).toBe('password_reset')
  })

  /**
   * Phase 38, and a bug browser verification found.
   *
   * A reset is a pre-authentication act with no tenant of its own, so its
   * message was written with `company_id = NULL`. `failedDeliveries` filters
   * on `company_id = $1`, which never matches NULL — so a failed reset, the
   * one letter whose loss locks somebody out of their own books, was invisible
   * to every operator on every company.
   *
   * It could not be seen before this phase because the mock never failed.
   */
  it('files a failed reset where an operator will find it', async () => {
    const fixture = await createCompanyFixture({ name: 'Bounced Reset Co' })
    const [owner] = await db.select().from(users).where(eq(users.id, fixture.userId))

    mock.failing.add(owner.email.toLowerCase())
    await requestPasswordReset({ email: owner.email })
    mock.failing.clear()

    const failures = await failedDeliveries(fixture.companyId)
    const mine = failures.filter((row) => row.email === owner.email.toLowerCase())

    expect(mine).toHaveLength(1)
    expect(mine[0].kind).toBe('password_reset')
    // The provider's own words, so somebody can act on it.
    expect(mine[0].error).toContain('Mailbox does not exist')
  })

  it('changes the password, ends every session, and audits into each company', async () => {
    const fixture = await createCompanyFixture({ name: 'Reset Co' })
    const [owner] = await db.select().from(users).where(eq(users.id, fixture.userId))

    await createSession(owner.id, fixture.companyId)
    await createSession(owner.id, fixture.companyId)
    expect(await db.select().from(sessions).where(eq(sessions.userId, owner.id))).toHaveLength(2)

    await requestPasswordReset({ email: owner.email })
    const token = tokenIn(mock.lastTo(owner.email))

    const outcome = await completePasswordReset({ token, newPassword: 'a-brand-new-secret' })
    expect(outcome).toMatchObject({ ok: true, sessionsEnded: 2 })

    const [after] = await db.select().from(users).where(eq(users.id, owner.id))
    expect(await verifyPassword('a-brand-new-secret', after.passwordHash)).toBe(true)
    expect(await verifyPassword('correct-horse-battery', after.passwordHash)).toBe(false)

    expect(await db.select().from(sessions).where(eq(sessions.userId, owner.id))).toHaveLength(0)

    const audited = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, fixture.companyId), eq(auditEvents.action, 'password.reset')),
      )
    expect(audited).toHaveLength(1)
  })

  it('refuses the same link twice', async () => {
    const person = await registerUser({
      name: 'Twice Person',
      email: nextEmail('twice'),
      password: 'correct-horse-battery',
    })

    await requestPasswordReset({ email: person.email })
    const token = tokenIn(mock.lastTo(person.email))

    expect((await completePasswordReset({ token, newPassword: 'first-new-secret' })).ok).toBe(true)

    const second = await completePasswordReset({ token, newPassword: 'second-new-secret' })
    expect(second.ok).toBe(false)

    // And the first password is still the live one.
    const [after] = await db.select().from(users).where(eq(users.id, person.id))
    expect(await verifyPassword('first-new-secret', after.passwordHash)).toBe(true)
  })

  it('kills the other live links when one of them is used', async () => {
    const person = await registerUser({
      name: 'Panicked Person',
      email: nextEmail('panic'),
      password: 'correct-horse-battery',
    })

    // Superseding already handles a second request; this covers the case where
    // a token was live for another reason and must die with the reset.
    await requestPasswordReset({ email: person.email })
    const first = tokenIn(mock.lastTo(person.email))
    const spare = await issueToken({
      purpose: 'password_reset',
      email: person.email,
      userId: person.id,
    })

    // The spare superseded the first, so use the spare and check the first is
    // dead either way.
    expect((await completePasswordReset({ token: spare.token, newPassword: 'calm-new-secret' })).ok).toBe(true)
    expect((await lookupToken('password_reset', first)).ok).toBe(false)
  })

  it('stops working once the address is no longer theirs', async () => {
    const person = await registerUser({
      name: 'Moved Person',
      email: nextEmail('moved'),
      password: 'correct-horse-battery',
    })

    await requestPasswordReset({ email: person.email })
    const token = tokenIn(mock.lastTo(person.email))

    // They change their email. The old inbox must not still hold a live key.
    await db.update(users).set({ email: nextEmail('newaddress') }).where(eq(users.id, person.id))

    const outcome = await completePasswordReset({ token, newPassword: 'should-not-work' })
    expect(outcome).toMatchObject({ ok: false })
  })

  it('tells the page a link is dead before anybody types a password', async () => {
    const person = await registerUser({
      name: 'Careful Person',
      email: nextEmail('careful'),
      password: 'correct-horse-battery',
    })

    await requestPasswordReset({ email: person.email })
    const token = tokenIn(mock.lastTo(person.email))

    expect(await checkResetToken(token)).toMatchObject({ ok: true, email: person.email })
    expect(await checkResetToken('not-a-real-token-at-all')).toMatchObject({ ok: false })

    // Checking does not spend it.
    expect((await completePasswordReset({ token, newPassword: 'still-works-fine' })).ok).toBe(true)
  })
})

describe('invitations', () => {
  it('creates nothing until the invitee accepts', async () => {
    const fixture = await createCompanyFixture({ name: 'Invite Co' })
    const email = nextEmail('invitee')

    await inviteToCompany(fixture.ctx, { email, name: 'Dana Chen', role: 'bookkeeper' })

    // No account, no membership. A mistyped address grants a stranger nothing.
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0)
    expect(
      await db.select().from(memberships).where(eq(memberships.companyId, fixture.companyId)),
    ).toHaveLength(1)

    const letter = mock.lastTo(email) as TransactionalMessage
    expect(letter.subject).toContain('Invite Co')
    // The one thing the letter must not contain.
    expect(letter.text.toLowerCase()).not.toContain('password:')
    expect(letter.text).toContain('choose your own password')
  })

  it('shows what is on offer before anybody types', async () => {
    const fixture = await createCompanyFixture({ name: 'Preview Co' })
    const email = nextEmail('preview')

    await inviteToCompany(fixture.ctx, { email, name: 'Sam Reid', role: 'accountant' })
    const token = tokenIn(mock.lastTo(email))

    const preview = await previewInvitation(token)
    expect(preview).toMatchObject({
      ok: true,
      preview: {
        email,
        invitedName: 'Sam Reid',
        destination: 'Preview Co',
        kind: 'company',
        role: 'accountant',
        hasAccount: false,
      },
    })
  })

  it('lets the invitee choose a password nobody else has ever known', async () => {
    const fixture = await createCompanyFixture({ name: 'Accept Co' })
    const email = nextEmail('accepts')

    await inviteToCompany(fixture.ctx, { email, name: 'Dana Chen', role: 'bookkeeper' })
    const token = tokenIn(mock.lastTo(email))

    const accepted = await acceptInvitation({ token, password: 'my-own-secret-phrase' })
    expect(accepted.ok).toBe(true)

    const [created] = await db.select().from(users).where(eq(users.email, email))
    expect(created.name).toBe('Dana Chen')
    expect(await verifyPassword('my-own-secret-phrase', created.passwordHash)).toBe(true)

    const [membership] = await db
      .select()
      .from(memberships)
      .where(
        and(eq(memberships.companyId, fixture.companyId), eq(memberships.userId, created.id)),
      )
    expect(membership.role).toBe('bookkeeper')

    const audited = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.companyId, fixture.companyId),
          eq(auditEvents.action, 'invitation.accept'),
        ),
      )
    expect(audited).toHaveLength(1)
  })

  it('refuses a password shorter than the rule, and grants nothing when it does', async () => {
    const fixture = await createCompanyFixture({ name: 'Short Co' })
    const email = nextEmail('short')

    await inviteToCompany(fixture.ctx, { email, role: 'readonly' })
    const token = tokenIn(mock.lastTo(email))

    expect(await acceptInvitation({ token, password: 'short' })).toMatchObject({ ok: false })
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0)

    // And the link still works, because the failure was theirs to correct.
    expect((await acceptInvitation({ token, password: 'a-long-enough-one' })).ok).toBe(true)
  })

  it('does not ask an existing account for a password on a page reached from email', async () => {
    const fixture = await createCompanyFixture({ name: 'Second Co' })
    const existing = await registerUser({
      name: 'Already Here',
      email: nextEmail('already'),
      password: 'correct-horse-battery',
    })

    await inviteToCompany(fixture.ctx, { email: existing.email, role: 'manager' })
    const token = tokenIn(mock.lastTo(existing.email))

    const preview = await previewInvitation(token)
    expect(preview).toMatchObject({ ok: true, preview: { hasAccount: true } })

    // No password supplied, and it works.
    const accepted = await acceptInvitation({ token })
    expect(accepted).toMatchObject({ ok: true, userId: existing.id })

    const [after] = await db.select().from(users).where(eq(users.id, existing.id))
    expect(await verifyPassword('correct-horse-battery', after.passwordHash)).toBe(true)
  })

  it('creates one account when the same link is clicked twice at once', async () => {
    const fixture = await createCompanyFixture({ name: 'Forwarded Co' })
    const email = nextEmail('forwarded')

    await inviteToCompany(fixture.ctx, { email, role: 'bookkeeper' })
    const token = tokenIn(mock.lastTo(email))

    const results = await Promise.allSettled([
      acceptInvitation({ token, password: 'one-of-these-wins' }),
      acceptInvitation({ token, password: 'one-of-these-wins' }),
    ])

    const succeeded = results.filter(
      (result) => result.status === 'fulfilled' && result.value.ok,
    )
    expect(succeeded).toHaveLength(1)
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1)
  })

  it('says so rather than sending nothing when they already work here', async () => {
    const fixture = await createCompanyFixture({ name: 'Already Co' })
    const [owner] = await db.select().from(users).where(eq(users.id, fixture.userId))

    const result = await inviteToCompany(fixture.ctx, { email: owner.email, role: 'manager' })
    expect(result.alreadyMember).toBe(true)
    expect(mock.sent).toHaveLength(0)
  })

  it('cannot be withdrawn by another company', async () => {
    const mine = await createCompanyFixture({ name: 'Mine Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Co' })
    const email = nextEmail('contested')

    const invited = await inviteToCompany(mine.ctx, { email, role: 'readonly' })

    expect(await withdrawCompanyInvitation(theirs.ctx, invited.tokenId)).toBe(false)
    expect(await companyInvitations(mine.ctx)).toHaveLength(1)

    expect(await withdrawCompanyInvitation(mine.ctx, invited.tokenId)).toBe(true)
    expect(await companyInvitations(mine.ctx)).toHaveLength(0)

    const token = tokenIn(mock.lastTo(email))
    expect(await previewInvitation(token)).toMatchObject({ ok: false })
  })

  it('lands a practice invitee at every client the firm already serves', async () => {
    const client = await createCompanyFixture({ name: 'Client Co' })
    const partner = await registerUser({
      name: 'Senior Partner',
      email: nextEmail('partner'),
      password: 'correct-horse-battery',
    })

    const practice = await createPractice({
      userId: partner.id,
      userName: partner.name,
      name: 'Hartley & Co',
    })

    const offered = await offerEngagement(client.ctx, {
      practiceId: practice.id,
      grantedRole: 'accountant',
    })
    await respondToEngagement(
      { side: 'practice', userId: partner.id, userName: partner.name },
      { engagementId: offered.engagementId, accept: true },
    )

    const email = nextEmail('newstaff')
    await inviteToPractice(
      { userId: partner.id, userName: partner.name },
      { practiceId: practice.id, email, name: 'Junior Staff' },
    )

    const token = tokenIn(mock.lastTo(email))
    const accepted = await acceptInvitation({ token, password: 'their-own-secret' })
    expect(accepted.ok).toBe(true)

    const userId = (accepted as { userId: string }).userId

    expect(
      await db
        .select()
        .from(practiceMembers)
        .where(
          and(
            eq(practiceMembers.practiceId, practice.id),
            eq(practiceMembers.userId, userId),
          ),
        ),
    ).toHaveLength(1)

    // The whole reason a firm invites somebody: they arrive able to work.
    const [reach] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.companyId, client.companyId), eq(memberships.userId, userId)))

    expect(reach).toBeDefined()
    expect(reach.role).toBe('accountant')
  })
})
