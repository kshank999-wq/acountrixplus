import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { actionTokens, auditEvents, transactionalMessages, users } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { completeAddressChange, requestAddressChange } from '@/modules/notify/email-change'
import { lookupToken } from '@/modules/notify/tokens'
import { mockTransactionalProvider } from '@/modules/notify/transactional'

/**
 * Claiming a new sign-in address, end to end (Phase 98).
 *
 * The letters are read out of the mock provider — what was **sent** — rather
 * than out of `transactional_messages`. The first draft of this file asserted
 * on the stored body and passed for the wrong reason: Phase 91's `keptBodyFor`
 * strips the link from *every* stored letter, so "the notice has no link" was
 * true there of the confirmation too. The claim worth making is about what
 * left the building.
 */

const mock = mockTransactionalProvider()

let fixture: Fixture
const COMPANY = 'Hartley & Co'

/** The token, taken the way a person takes it: out of the letter. */
function tokenSentTo(address: string): string {
  const message = mock.lastTo(address)
  expect(message, `a letter reached ${address}`).toBeDefined()
  const match = /https?:\/\/\S+/.exec((message as { text: string }).text)
  expect(match, 'the confirmation carries a link').not.toBeNull()
  return decodeURIComponent(
    new URL((match as RegExpMatchArray)[0]).searchParams.get('token') as string,
  )
}

const storedLetters = () =>
  db
    .select({
      kind: transactionalMessages.kind,
      email: transactionalMessages.email,
      subject: transactionalMessages.subject,
    })
    .from(transactionalMessages)
    .orderBy(transactionalMessages.createdAt)

beforeEach(async () => {
  mock.reset()
  fixture = await createCompanyFixture({ name: 'Address Co' })
})

const currentEmail = async () => {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, fixture.ctx.userId))
  return row.email
}

describe('asking for a new address', () => {
  it('sends two letters, and the link is only on the one to the new address', async () => {
    const before = await currentEmail()

    const result = await requestAddressChange(fixture.ctx, {
      requested: 'Robin.New@hartleyco.test',
      companyName: COMPANY,
    })

    expect(result).toEqual({ accepted: true })

    const letters = await storedLetters()
    expect(letters.map((one) => one.kind).sort()).toEqual(['email_change', 'security_alert'])
    expect(letters.find((one) => one.kind === 'email_change')!.email).toBe(
      'robin.new@hartleyco.test',
    )

    // The property the whole phase turns on, asserted on what was sent.
    expect(tokenSentTo('robin.new@hartleyco.test')).toBeTruthy()

    const notice = mock.lastTo(before) as { text: string }
    expect(notice).toBeDefined()
    expect(notice.text).not.toMatch(/https?:\/\//)
    expect(notice.text).not.toContain('token=')
  })

  it('changes nothing until the link is opened', async () => {
    const before = await currentEmail()
    await requestAddressChange(fixture.ctx, {
      requested: 'later@hartleyco.test',
      companyName: COMPANY,
    })

    // A half-finished change must not lock anybody out — the person most
    // likely to abandon one is the person who mistyped.
    expect(await currentEmail()).toBe(before)
  })

  it('refuses the address already in use by this account', async () => {
    const before = await currentEmail()
    const result = await requestAddressChange(fixture.ctx, {
      requested: before.toUpperCase(),
      companyName: COMPANY,
    })

    expect(result).toEqual({
      accepted: false,
      error: 'That is already the address you sign in with.',
    })
    expect(await storedLetters()).toHaveLength(0)
  })

  it('accepts an address somebody else holds, and quietly sends nothing', async () => {
    // The same stance requestPasswordReset takes. A different answer here
    // would make this the one screen that confirms an account exists.
    const other = await createCompanyFixture({ name: 'Somebody Else' })
    const [theirs] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, other.ctx.userId))

    const result = await requestAddressChange(fixture.ctx, {
      requested: theirs.email,
      companyName: COMPANY,
    })

    expect(result).toEqual({ accepted: true })
    expect(await storedLetters()).toHaveLength(0)
  })

  it('leaves only one live claim when somebody changes their mind', async () => {
    await requestAddressChange(fixture.ctx, {
      requested: 'first@hartleyco.test',
      companyName: COMPANY,
    })
    await requestAddressChange(fixture.ctx, {
      requested: 'second@hartleyco.test',
      companyName: COMPANY,
    })

    const all = await db
      .select({ email: actionTokens.email, revokedAt: actionTokens.revokedAt })
      .from(actionTokens)
      .where(
        and(eq(actionTokens.purpose, 'email_change'), eq(actionTokens.userId, fixture.ctx.userId)),
      )

    expect(all).toHaveLength(2)

    // Exactly one still live, and it is the one they asked for second. A link
    // on an address they abandoned must not move their account a month later.
    const live = all.filter((one) => one.revokedAt === null)
    expect(live.map((one) => one.email)).toEqual(['second@hartleyco.test'])
  })

  it('records the claim on the audit trail', async () => {
    await requestAddressChange(fixture.ctx, {
      requested: 'audited@hartleyco.test',
      companyName: COMPANY,
    })

    const [event] = await db
      .select({ after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.action, 'user.address_claim'))

    expect((event.after as { requested: string }).requested).toBe('audited@hartleyco.test')
  })
})

describe('finishing the claim', () => {
  it('writes the new address and spends the link', async () => {
    const before = await currentEmail()
    await requestAddressChange(fixture.ctx, {
      requested: 'moved@hartleyco.test',
      companyName: COMPANY,
    })

    const token = tokenSentTo('moved@hartleyco.test')
    const result = await completeAddressChange({ token, companyName: COMPANY })

    expect(result).toEqual({ ok: true, email: 'moved@hartleyco.test', previous: before })
    expect(await currentEmail()).toBe('moved@hartleyco.test')

    // Once, and only once.
    expect(await completeAddressChange({ token, companyName: COMPANY })).toEqual({
      ok: false,
      error: 'That link has already been used.',
    })
  })

  it('tells the address that lost the account, a second time and without a link', async () => {
    const before = await currentEmail()
    await requestAddressChange(fixture.ctx, {
      requested: 'moved@hartleyco.test',
      companyName: COMPANY,
    })
    await completeAddressChange({
      token: tokenSentTo('moved@hartleyco.test'),
      companyName: COMPANY,
    })

    const alerts = (await storedLetters()).filter(
      (one) => one.kind === 'security_alert' && one.email === before,
    )

    expect(alerts).toHaveLength(2)
    expect(alerts[alerts.length - 1].subject).toContain('has changed')

    // Still no link, on the letter that matters most to somebody who was not
    // watching their inbox an hour ago.
    expect((mock.lastTo(before) as { text: string }).text).not.toMatch(/https?:\/\//)
  })

  it('refuses once somebody else has registered the address', async () => {
    await requestAddressChange(fixture.ctx, {
      requested: 'contested@hartleyco.test',
      companyName: COMPANY,
    })
    const token = tokenSentTo('contested@hartleyco.test')

    // The world moves between the letter and the click.
    const other = await createCompanyFixture({ name: 'Faster' })
    await db
      .update(users)
      .set({ email: 'contested@hartleyco.test' })
      .where(eq(users.id, other.ctx.userId))

    const result = await completeAddressChange({ token, companyName: COMPANY })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('belongs to another account')
  })

  it('refuses a link that was superseded by a later claim', async () => {
    await requestAddressChange(fixture.ctx, {
      requested: 'abandoned@hartleyco.test',
      companyName: COMPANY,
    })
    const abandoned = tokenSentTo('abandoned@hartleyco.test')

    await requestAddressChange(fixture.ctx, {
      requested: 'wanted@hartleyco.test',
      companyName: COMPANY,
    })

    expect(await completeAddressChange({ token: abandoned, companyName: COMPANY })).toMatchObject({
      ok: false,
    })
    expect(await lookupToken('email_change', abandoned)).toMatchObject({ ok: false })
  })

  it('says so plainly for a link that never existed', async () => {
    const result = await completeAddressChange({
      token: 'not-a-real-token-at-all',
      companyName: COMPANY,
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('no longer valid')
  })
})
