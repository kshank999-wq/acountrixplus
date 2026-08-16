import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, customers, memberships, practiceEngagements } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  addPracticeMember,
  createPractice,
  endEngagement,
  engagementsForCompany,
  engagementsForPractice,
  findPracticesByName,
  listPracticeMembers,
  narrowerOf,
  offerEngagement,
  PracticeError,
  practicesFor,
  removePracticeMember,
  requestEngagement,
  respondToEngagement,
  SelfAcceptanceError,
  whoHasAccess,
} from '@/modules/practice/service'
import {
  NoSuchCompanyError,
  practiceWorkQueue,
  reachableCompanies,
  switchCompany,
} from '@/modules/practice/switching'
import { trialBalance } from '@/modules/ledger/balances'
import { postManualEntry } from '@/modules/ledger/journal'
import { accountByNumber } from '@/modules/coa/service'
import type { ActorContext } from '@/modules/tenancy/context'
import { createSession, resolveSession, signSessionId } from '@/modules/auth/session'
import { registerUser } from '@/modules/tenancy/onboarding'

/**
 * Accountant practice mode (spec §14, Phase 18).
 *
 * Two claims under test:
 *
 *   **Access is granted, never claimed** — whichever side asks, the other side
 *   has to agree, and until it does the engagement grants nothing.
 *
 *   **One company at a time** — a practice member who can reach twenty
 *   companies sees exactly one, and the isolation tests are the ones that
 *   matter most in this file.
 */

/** One balanced entry of a distinct size, so a leak between books is loud. */
async function postAmount(company: Fixture, cents: number, as?: ActorContext) {
  const [bank, revenue] = await Promise.all([
    accountByNumber(company.companyId, '1000'),
    accountByNumber(company.companyId, '4000'),
  ])

  return postManualEntry(as ?? company.ctx, {
    entryDate: '2026-03-01',
    memo: 'Marker',
    lines: [
      { chartAccountId: bank!.id, debitCents: cents },
      { chartAccountId: revenue!.id, creditCents: cents },
    ],
  })
}

async function accountant(name = 'Dana Chen') {
  const user = await registerUser({
    name,
    email: `acct-${Math.floor(performance.now() * 1000)}-${name.replace(/\W/g, '')}@example.test`,
    password: 'correct-horse-battery',
  })
  return user
}

type Firm = {
  practiceId: string
  ownerId: string
  ownerName: string
}

async function firm(name = 'Hartley & Co'): Promise<Firm> {
  const owner = await accountant('Dana Chen')
  const practice = await createPractice({
    userId: owner.id,
    userName: owner.name,
    name,
    contactEmail: 'hello@hartley.test',
  })
  return { practiceId: practice.id, ownerId: owner.id, ownerName: owner.name }
}

/** A firm with an accepted engagement at a client. */
async function engaged(client: Fixture, house?: Firm): Promise<Firm & { engagementId: string }> {
  const shop = house ?? (await firm())

  const { engagementId } = await offerEngagement(client.ctx, { practiceId: shop.practiceId })
  await respondToEngagement(
    { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
    { engagementId, accept: true },
  )

  return { ...shop, engagementId }
}

describe('the firm', () => {
  it('creates a practice with its creator as owner', async () => {
    const owner = await accountant()
    const practice = await createPractice({
      userId: owner.id,
      userName: owner.name,
      name: 'Hartley & Co',
    })

    expect(await practicesFor(owner.id)).toEqual([
      {
        practiceId: practice.id,
        practiceName: 'Hartley & Co',
        practiceRole: 'owner',
        defaultRole: 'accountant',
      },
    ])
  })

  it('does not need a company membership to exist', async () => {
    // An accountant should not have to be somebody's employee before they can
    // be anybody's accountant.
    const owner = await accountant()
    await expect(
      createPractice({ userId: owner.id, userName: owner.name, name: 'Solo Books' }),
    ).resolves.toBeDefined()
  })

  it('lets only an owner add staff', async () => {
    const shop = await firm()
    const staff = await accountant('Sam Junior')
    const stranger = await accountant('Not Employed')

    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: staff.id,
    })

    await expect(
      addPracticeMember({ userId: staff.id, userName: staff.name }, {
        practiceId: shop.practiceId,
        userId: stranger.id,
      }),
    ).rejects.toThrow(/only a practice owner/i)
  })

  it('finds a practice by name so a client can offer them access', async () => {
    await firm('Kestrel Accountancy')
    expect((await findPracticesByName('kestrel')).map((p) => p.name)).toEqual([
      'Kestrel Accountancy',
    ])
    // Too short to be a search.
    expect(await findPracticesByName('k')).toEqual([])
  })
})

describe('access is granted, never claimed', () => {
  /**
   * The claim. An accountant cannot add themselves to a company's books.
   */
  it('refuses to let the practice accept its own request', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await firm()

    const { engagementId } = await requestEngagement(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, companyId: client.companyId },
    )

    await expect(
      respondToEngagement(
        { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
        { engagementId, accept: true },
      ),
    ).rejects.toThrow(SelfAcceptanceError)

    // And nothing was granted while it waited.
    expect(await whoHasAccess(client.ctx)).toHaveLength(1)
  })

  /** And the other direction: a company cannot conscript an accountant. */
  it('refuses to let the client accept its own offer', async () => {
    const client = await createCompanyFixture()
    const shop = await firm()

    const { engagementId } = await offerEngagement(client.ctx, { practiceId: shop.practiceId })

    await expect(
      respondToEngagement({ side: 'client', ctx: client.ctx }, { engagementId, accept: true }),
    ).rejects.toThrow(SelfAcceptanceError)
  })

  it('grants nothing at all while a request is pending', async () => {
    const client = await createCompanyFixture()
    const shop = await firm()

    await requestEngagement(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, companyId: client.companyId },
    )

    expect(await reachableCompanies(shop.ownerId, null)).toEqual([])
  })

  it('grants a membership to every practice member once accepted', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await firm()
    const staff = await accountant('Sam Junior')

    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: staff.id,
    })

    const { engagementId } = await offerEngagement(client.ctx, { practiceId: shop.practiceId })
    const result = await respondToEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId, accept: true },
    )

    expect(result.status).toBe('active')
    expect(result.membershipsGranted).toBe(2)

    const reachable = await reachableCompanies(staff.id, null)
    expect(reachable).toHaveLength(1)
    expect(reachable[0]).toMatchObject({ name: 'Ridgeline', viaPracticeName: 'Hartley & Co' })
  })

  it('declining settles it and grants nothing', async () => {
    const client = await createCompanyFixture()
    const shop = await firm()

    const { engagementId } = await offerEngagement(client.ctx, { practiceId: shop.practiceId })
    const result = await respondToEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId, accept: false },
    )

    expect(result.status).toBe('declined')
    expect(await reachableCompanies(shop.ownerId, null)).toEqual([])
    await expect(
      respondToEngagement(
        { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
        { engagementId, accept: true },
      ),
    ).rejects.toThrow(/already been settled/i)
  })

  it('refuses a second live engagement between the same two parties', async () => {
    const client = await createCompanyFixture()
    const shop = await firm()

    await offerEngagement(client.ctx, { practiceId: shop.practiceId })
    await expect(
      offerEngagement(client.ctx, { practiceId: shop.practiceId }),
    ).rejects.toThrow(/already a request waiting/i)
  })

  it('lets a company re-engage a firm it once let go', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)

    await endEngagement({ side: 'client', ctx: client.ctx }, { engagementId: shop.engagementId })

    // The partial unique index is what makes this possible: `ended` rows sit
    // outside the constraint.
    await expect(
      offerEngagement(client.ctx, { practiceId: shop.practiceId }),
    ).resolves.toBeDefined()
  })

  it('caps the role at what the client agreed to', async () => {
    const client = await createCompanyFixture()
    const shop = await firm()

    // The firm would like its people to be owners. The client says readonly.
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: shop.ownerId,
      practiceRole: 'owner',
      defaultRole: 'owner',
    })

    const { engagementId } = await offerEngagement(client.ctx, {
      practiceId: shop.practiceId,
      grantedRole: 'readonly',
    })
    await respondToEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId, accept: true },
    )

    const reachable = await reachableCompanies(shop.ownerId, null)
    expect(reachable[0].role).toBe('readonly')
  })

  it('takes the narrower of the two roles either way round', () => {
    expect(narrowerOf('owner', 'readonly')).toBe('readonly')
    expect(narrowerOf('readonly', 'owner')).toBe('readonly')
    expect(narrowerOf('bookkeeper', 'accountant')).toBe('bookkeeper')
    expect(narrowerOf('accountant', 'accountant')).toBe('accountant')
  })
})

describe('one company at a time', () => {
  /**
   * The isolation claim, and the reason the whole tenancy design has taken an
   * explicit context since Phase 1. A practice member who can reach two
   * companies must see exactly one.
   */
  it('shows a practice member one client’s books at a time', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha Ltd' })
    const beta = await createCompanyFixture({ name: 'Beta Ltd' })

    // Distinct amounts, so a leak would be unmistakable rather than plausible.
    await postAmount(alpha, 111_100)
    await postAmount(beta, 222_200)

    const shop = await firm()
    await engaged(alpha, shop)
    await engaged(beta, shop)

    const atAlpha = {
      userId: shop.ownerId,
      userName: shop.ownerName,
      companyId: alpha.companyId,
      role: 'accountant' as const,
    }

    expect((await trialBalance(atAlpha)).totalDebitCents).toBe(111_100)
    expect((await trialBalance({ ...atAlpha, companyId: beta.companyId })).totalDebitCents).toBe(
      222_200,
    )
  })

  it('lists every company reachable, and marks the current one', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha Ltd' })
    const beta = await createCompanyFixture({ name: 'Beta Ltd' })
    const shop = await firm()
    await engaged(alpha, shop)
    await engaged(beta, shop)

    const reachable = await reachableCompanies(shop.ownerId, beta.companyId)
    expect(reachable.map((row) => row.name)).toEqual(['Alpha Ltd', 'Beta Ltd'])
    expect(reachable.find((row) => row.name === 'Beta Ltd')?.isCurrent).toBe(true)
    expect(reachable.every((row) => row.viaPracticeName === 'Hartley & Co')).toBe(true)
  })

  it('refuses to switch into a company nobody granted', async () => {
    const mine = await createCompanyFixture()
    const theirs = await createCompanyFixture()
    const shop = await engaged(mine)

    const { session } = await createSession(shop.ownerId, mine.companyId)

    await expect(
      switchCompany(
        { userId: shop.ownerId, userName: shop.ownerName, sessionId: session.id },
        theirs.companyId,
      ),
    ).rejects.toThrow(NoSuchCompanyError)
  })

  it('switching points the session at exactly one company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha Ltd' })
    const beta = await createCompanyFixture({ name: 'Beta Ltd' })
    const shop = await firm()
    await engaged(alpha, shop)
    await engaged(beta, shop)

    const { session } = await createSession(shop.ownerId, alpha.companyId)
    const before = await resolveSession(signSessionId(session.id))
    expect(before?.companyId).toBe(alpha.companyId)

    await switchCompany(
      { userId: shop.ownerId, userName: shop.ownerName, sessionId: session.id },
      beta.companyId,
    )

    const after = await resolveSession(signSessionId(session.id))
    expect(after?.companyId).toBe(beta.companyId)
    expect(after?.companyName).toBe('Beta Ltd')
    // Still one company, not two.
    expect(Object.keys(after ?? {})).not.toContain('companyIds')
  })

  /**
   * Filed in the company being entered, because "who opened our books and
   * when" is the client's question. Putting it in the accountant's own company
   * would file it where the person it concerns cannot read it.
   */
  it('records the switch in the company being entered', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    const { session } = await createSession(shop.ownerId, client.companyId)
    await switchCompany(
      { userId: shop.ownerId, userName: shop.ownerName, sessionId: session.id },
      client.companyId,
    )

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, client.companyId), eq(auditEvents.action, 'company.switch')),
      )

    expect(event).toBeDefined()
    expect(event.actorName).toBe('Dana Chen (Hartley & Co)')
  })

  it('names the practice on everything an accountant does', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)

    await postAmount(client, 50_000, {
      userId: shop.ownerId,
      userName: shop.ownerName,
      companyId: client.companyId,
      role: 'accountant',
      viaPractice: 'Hartley & Co',
    })

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, client.companyId), eq(auditEvents.action, 'journal.post')),
      )

    expect(event.actorName).toBe('Dana Chen (Hartley & Co)')
  })
})

describe('ending it', () => {
  /**
   * A client must never need their accountant's permission to take their books
   * back — deliberately asymmetric with starting an engagement.
   */
  it('lets the client end it alone, and access stops on the next request', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)

    const { session } = await createSession(shop.ownerId, client.companyId)
    expect((await resolveSession(signSessionId(session.id)))?.companyId).toBe(client.companyId)

    const result = await endEngagement(
      { side: 'client', ctx: client.ctx },
      { engagementId: shop.engagementId, reason: 'Changed firms' },
    )
    expect(result.membershipsRemoved).toBe(1)

    // Not when the session expires. Now.
    expect(await resolveSession(signSessionId(session.id))).toBeNull()
    expect(await reachableCompanies(shop.ownerId, null)).toEqual([])
  })

  it('lets the practice end it alone too', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)

    await expect(
      endEngagement(
        { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
        { engagementId: shop.engagementId },
      ),
    ).resolves.toMatchObject({ membershipsRemoved: 1 })
  })

  it('removes only the memberships that engagement created', async () => {
    const client = await createCompanyFixture()
    const shop = await firm()

    // Somebody who both works at the firm and was hired directly by the
    // client. Two independent grants, and ending one must not touch the other.
    const dualHat = await accountant('Both Hats')
    await db.insert(memberships).values({
      companyId: client.companyId,
      userId: dualHat.id,
      role: 'bookkeeper',
    })
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: dualHat.id,
    })

    const { engagementId } = await offerEngagement(client.ctx, { practiceId: shop.practiceId })
    await respondToEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId, accept: true },
    )

    await endEngagement({ side: 'client', ctx: client.ctx }, { engagementId })

    // The firm is gone; the directly hired bookkeeper is not.
    const access = await whoHasAccess(client.ctx)
    expect(access.map((row) => row.name).sort()).toEqual(['Both Hats', 'Owner User'])
    expect(access.find((row) => row.name === 'Both Hats')?.role).toBe('bookkeeper')
  })

  it('refuses to end the same engagement twice', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)

    await endEngagement({ side: 'client', ctx: client.ctx }, { engagementId: shop.engagementId })
    await expect(
      endEngagement({ side: 'client', ctx: client.ctx }, { engagementId: shop.engagementId }),
    ).rejects.toThrow(/already ended/i)
  })

  it('refuses a company ending somebody else’s engagement', async () => {
    const mine = await createCompanyFixture()
    const theirs = await createCompanyFixture()
    const shop = await engaged(theirs)

    await expect(
      endEngagement({ side: 'client', ctx: mine.ctx }, { engagementId: shop.engagementId }),
    ).rejects.toThrow(/different company/i)
  })

  /**
   * One revocation, not forty. Somebody who leaves a firm on Friday should not
   * still be able to read a client's ledger on Monday because a company got
   * missed.
   */
  it('removing somebody from the firm ends their access everywhere at once', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha Ltd' })
    const beta = await createCompanyFixture({ name: 'Beta Ltd' })
    const shop = await firm()
    const staff = await accountant('Sam Junior')

    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: staff.id,
    })
    await engaged(alpha, shop)
    await engaged(beta, shop)

    expect(await reachableCompanies(staff.id, null)).toHaveLength(2)

    const result = await removePracticeMember(
      { userId: shop.ownerId },
      { practiceId: shop.practiceId, userId: staff.id },
    )

    expect(result.revokedAtClients).toBe(2)
    expect(await reachableCompanies(staff.id, null)).toEqual([])
    // The owner still has access — only one person left.
    expect(await reachableCompanies(shop.ownerId, null)).toHaveLength(2)
  })

  it('a new hire reaches every client the firm already serves', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha Ltd' })
    const beta = await createCompanyFixture({ name: 'Beta Ltd' })
    const shop = await firm()
    await engaged(alpha, shop)
    await engaged(beta, shop)

    const hire = await accountant('Monday Starter')
    const result = await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: hire.id,
    })

    expect(result.grantedAtClients).toBe(2)
    expect(await reachableCompanies(hire.id, null)).toHaveLength(2)
  })
})

describe('the work queue', () => {
  it('shows only clients of the practice being asked about', async () => {
    const mine = await createCompanyFixture({ name: 'My Client' })
    const theirs = await createCompanyFixture({ name: 'Their Client' })

    const ours = await firm('Hartley & Co')
    const rival = await firm('Rival Books')

    await engaged(mine, ours)
    await engaged(theirs, rival)

    const queue = await practiceWorkQueue(ours.ownerId, ours.practiceId)
    expect(queue.map((row) => row.companyName)).toEqual(['My Client'])
  })

  /**
   * The one query that crosses tenants, so this is the test that matters:
   * asking about a practice you do not work at returns nothing rather than
   * that firm's client roster.
   */
  it('returns nothing for a practice the caller does not work at', async () => {
    const client = await createCompanyFixture({ name: 'Someone Else’s Client' })
    const rival = await firm('Rival Books')
    await engaged(client, rival)

    const outsider = await accountant('Curious Person')
    expect(await practiceWorkQueue(outsider.id, rival.practiceId)).toEqual([])
  })

  it('drops a client the moment the engagement ends', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    expect(await practiceWorkQueue(shop.ownerId, shop.practiceId)).toHaveLength(1)

    await endEngagement({ side: 'client', ctx: client.ctx }, { engagementId: shop.engagementId })
    expect(await practiceWorkQueue(shop.ownerId, shop.practiceId)).toEqual([])
  })

  it('counts what is waiting rather than listing it', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    const [item] = await practiceWorkQueue(shop.ownerId, shop.practiceId)
    expect(item.companyName).toBe('Ridgeline')
    expect(typeof item.awaitingReview).toBe('number')
    // A count, not a page of somebody else's transactions.
    expect(Object.keys(item)).not.toContain('transactions')
  })
})

describe('what the client can see', () => {
  it('names everybody with access and which firm they came through', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)

    const access = await whoHasAccess(client.ctx)
    const accountantRow = access.find((row) => row.name === 'Dana Chen')

    expect(accountantRow).toMatchObject({
      viaPracticeName: 'Hartley & Co',
      role: 'accountant',
      viaEngagementId: shop.engagementId,
    })
    expect(access.find((row) => row.name === 'Owner User')?.viaPracticeName).toBeNull()
  })

  it('lists the company’s engagements including the ones that ended', async () => {
    const client = await createCompanyFixture()
    const shop = await engaged(client)
    await endEngagement({ side: 'client', ctx: client.ctx }, { engagementId: shop.engagementId })

    const engagements = await engagementsForCompany(client.ctx)
    expect(engagements).toHaveLength(1)
    expect(engagements[0]).toMatchObject({
      status: 'ended',
      practiceName: 'Hartley & Co',
      initiatedBy: 'client',
    })
  })

  it('keeps one company’s engagements invisible to another', async () => {
    const mine = await createCompanyFixture()
    const theirs = await createCompanyFixture()
    await engaged(theirs)

    expect(await engagementsForCompany(mine.ctx)).toEqual([])
  })

  it('refuses to show a firm’s book of business to an outsider', async () => {
    const shop = await firm()
    const outsider = await accountant('Curious Person')

    await expect(engagementsForPractice(shop.practiceId, outsider.id)).rejects.toThrow(
      PracticeError,
    )
    await expect(listPracticeMembers(shop.practiceId, outsider.id)).rejects.toThrow(PracticeError)
  })
})
