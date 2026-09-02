import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  auditEvents,
  backgroundJobs,
  customers,
  integrityRuns,
  memberships,
  practiceEngagements,
  sendingSnapshots,
  transactionalMessages,
} from '@/db/schema'
import { mockTransactionalProvider } from '@/modules/notify/transactional'
import { setPreferenceFor } from '@/modules/mobile/notifications'
import { createCompanyFixture, type Fixture } from './helpers'
import {
  addPracticeMember,
  assignToEngagement,
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
  setEngagementStaffing,
  staffingChangePreview,
  staffingFor,
  unassignFromEngagement,
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
import { getHandler } from '@/modules/worker/registry'
import '@/modules/worker/handlers'

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

  /**
   * Phase 87. Until now this queue asked one question of every client — the
   * categorization backlog — which is the least urgent thing the application
   * knows about a set of books. Everything else had been built one client at
   * a time and was reachable only by opening that client's operations page.
   */
  describe('asking the other questions', () => {
    const NOW = new Date('2026-09-01T09:00:00.000Z')

    /** `days` before NOW, as `YYYY-MM-DD`. */
    function ago(days: number): string {
      return new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    }

    async function checked(company: Fixture, faults: number, errors = 0) {
      await db.insert(integrityRuns).values({
        companyId: company.companyId,
        asOf: ago(0),
        checksRun: 10,
        checksSkipped: 0,
        faults,
        errors,
      })
    }

    it('puts the client whose books disagree at the top', async () => {
      const broken = await createCompanyFixture({ name: 'Zebra Ltd' })
      const fine = await createCompanyFixture({ name: 'Alpha Ltd' })
      const shop = await firm('Hartley & Co')
      await engaged(broken, shop)
      await engaged(fine, shop)
      await checked(broken, 2)
      await checked(fine, 0)

      const queue = await practiceWorkQueue(shop.ownerId, shop.practiceId, NOW)

      // Alphabetically Alpha comes first; by urgency it does not.
      expect(queue.map((row) => row.companyName)).toEqual(['Zebra Ltd', 'Alpha Ltd'])
      expect(queue[0].triage.rung).toBe('wrong')
      expect(queue[0].triage.headline).toBe('2 checks disagree with the ledger')
      expect(queue[1].triage.rung).toBe('clear')
    })

    it('sees a dead job in a client’s books without entering them', async () => {
      const client = await createCompanyFixture({ name: 'Stuck Ltd' })
      const shop = await firm('Hartley & Co')
      await engaged(client, shop)
      await checked(client, 0)

      await db.insert(backgroundJobs).values({
        companyId: client.companyId,
        kind: 'bank.sync_all',
        payload: {},
        status: 'dead',
        attempts: 5,
        maxAttempts: 5,
        lastError: 'The provider refused the token.',
        runAt: NOW,
        updatedAt: NOW,
        finishedAt: NOW,
      })

      const queue = await practiceWorkQueue(shop.ownerId, shop.practiceId, NOW)

      expect(queue[0].triage.rung).toBe('stuck')
      expect(queue[0].triage.headline).toBe('1 job gave up')
    })

    /**
     * The reason this is affordable at all: Phase 86 writes one snapshot row
     * per company per day, so a forty-client roster reads the sending
     * reputation with one indexed row each rather than the four-query
     * `health()` the operations page runs.
     */
    it('reads the sending reputation from the daily snapshot', async () => {
      const client = await createCompanyFixture({ name: 'Bouncy Ltd' })
      const shop = await firm('Hartley & Co')
      await engaged(client, shop)
      await checked(client, 0)

      await db.insert(sendingSnapshots).values([
        {
          companyId: client.companyId,
          takenOn: ago(9),
          windowDays: 7,
          accepted: 400,
          bounced: 4,
          complained: 0,
        },
        {
          companyId: client.companyId,
          takenOn: ago(0),
          windowDays: 7,
          accepted: 400,
          bounced: 24,
          complained: 0,
        },
      ])

      const queue = await practiceWorkQueue(shop.ownerId, shop.practiceId, NOW)

      expect(queue[0].triage.rung).toBe('spending')
      expect(queue[0].triage.headline).toBe(
        'Marketing email is bouncing past the level providers act on',
      )
    })

    /**
     * A roster showing a green tick for a company nobody has ever examined
     * would be lying quietly, at scale — the rule Phase 84 drew with `null`
     * rather than `ok`.
     */
    it('does not call a client nobody has checked clear', async () => {
      const client = await createCompanyFixture({ name: 'Unknown Ltd' })
      const shop = await firm('Hartley & Co')
      await engaged(client, shop)

      const queue = await practiceWorkQueue(shop.ownerId, shop.practiceId, NOW)

      expect(queue[0].triage.rung).toBe('unchecked')
      expect(queue[0].triage.headline).toBe('The books have never been checked')
    })

    /**
     * Phase 88. Phase 24's digest reaches the memberships holding
     * `company:manage`, and that permission belongs to `owner` alone — an
     * engagement grants `accountant` and is capped by the client. So the firm
     * engaged to keep the books is told nothing, and the person who *is* told
     * is the one least equipped to act.
     */
    describe('the morning brief', () => {
      const mail = mockTransactionalProvider()

      async function fire(asOf: Date) {
        const handler = getHandler('practice.morning_brief')!
        return (await handler.handler({
          actor: undefined as never,
          companyId: null as never,
          payload: { asOf: asOf.toISOString() },
          attempt: 1,
          jobId: 'test',
        })) as Record<string, number | string>
      }

      it('writes to the firm, once, about the client that got worse', async () => {
        const broken = await createCompanyFixture({ name: 'Zebra Ltd' })
        const fine = await createCompanyFixture({ name: 'Alpha Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(broken, shop)
        await engaged(fine, shop)
        await checked(broken, 2)
        await checked(fine, 0)

        mail.reset()
        const result = await fire(NOW)

        expect(result.briefed).toBe(1)
        // One letter per person at the firm, not one per client.
        expect(mail.sent).toHaveLength(1)
        expect(mail.sent[0].subject).toBe('Zebra Ltd needs a look')
        expect(mail.sent[0].text).toContain('2 checks disagree with the ledger')
        // Alpha is fine, so it is not in the letter at all.
        expect(mail.sent[0].text).not.toContain('Alpha Ltd')
      })

      /**
       * A daily message that never changes is a daily message nobody reads —
       * the same failure ADR 0024 named, by a slower route.
       */
      it('says nothing the second morning about the same trouble', async () => {
        const broken = await createCompanyFixture({ name: 'Zebra Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(broken, shop)
        await checked(broken, 2)

        mail.reset()
        await fire(NOW)
        expect(mail.sent).toHaveLength(1)

        mail.reset()
        const second = await fire(new Date(NOW.getTime() + 86_400_000))

        expect(second.briefed).toBe(0)
        expect(mail.sent).toHaveLength(0)
      })

      it('speaks again when the same client slides another rung', async () => {
        const client = await createCompanyFixture({ name: 'Slide Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(client, shop)
        // Night one: nobody has ever checked these books.
        mail.reset()
        await fire(NOW)
        expect(mail.sent).toHaveLength(1)

        // Night two: they have been checked, and they disagree.
        await checked(client, 3)
        mail.reset()
        const second = await fire(new Date(NOW.getTime() + 86_400_000))

        expect(second.briefed).toBe(1)
        expect(mail.sent[0].text).toContain('3 checks disagree with the ledger')
      })

      /** The memory must hold a recovery, or the relapse cannot be told from a standing problem. */
      it('goes quiet on a recovery and speaks again on the relapse', async () => {
        const client = await createCompanyFixture({ name: 'Wobble Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(client, shop)
        await checked(client, 2)

        mail.reset()
        await fire(NOW)
        expect(mail.sent).toHaveLength(1)

        // Fixed. Nothing is said about getting better.
        await db.delete(integrityRuns).where(eq(integrityRuns.companyId, client.companyId))
        await checked(client, 0)
        mail.reset()
        await fire(new Date(NOW.getTime() + 86_400_000))
        expect(mail.sent).toHaveLength(0)

        // Broken again. That is news, because the memory recorded the recovery.
        await db.delete(integrityRuns).where(eq(integrityRuns.companyId, client.companyId))
        await checked(client, 1)
        mail.reset()
        await fire(new Date(NOW.getTime() + 2 * 86_400_000))
        expect(mail.sent).toHaveLength(1)
      })

      it('writes to everybody at the firm', async () => {
        const client = await createCompanyFixture({ name: 'Zebra Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(client, shop)
        await checked(client, 2)

        const hire = await accountant('Second Pair Of Hands')
        await addPracticeMember(
          { userId: shop.ownerId, userName: shop.ownerName },
          { practiceId: shop.practiceId, userId: hire.id },
        )

        mail.reset()
        await fire(NOW)

        expect(mail.sent).toHaveLength(2)
      })

      /**
       * Phase 89. The brief arrived in Phase 88 with no way to switch it off,
       * in an application that has given every other topic a per-person switch
       * since Phase 8 — because a channel nobody can quiet gets filtered to a
       * folder, and the one message that mattered is filtered with it.
       */
      it('does not write to somebody who switched it off', async () => {
        const client = await createCompanyFixture({ name: 'Zebra Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(client, shop)
        await checked(client, 2)

        const hire = await accountant('Prefers Silence')
        await addPracticeMember(
          { userId: shop.ownerId, userName: shop.ownerName },
          { practiceId: shop.practiceId, userId: hire.id },
        )

        await setPreferenceFor(
          { kind: 'practice', practiceId: shop.practiceId },
          hire.id,
          'practice_brief',
          false,
        )

        mail.reset()
        const result = await fire(NOW)

        // One member wanting out is not the firm wanting out.
        expect(result.briefed).toBe(1)
        expect(result.quieted).toBe(1)
        expect(mail.sent).toHaveLength(1)
        expect(mail.sent[0].to).not.toBe(hire.email)
      })

      /** A preference for one firm must not silence another firm's brief. */
      it('silences one firm without silencing the other', async () => {
        const mine = await createCompanyFixture({ name: 'My Client' })
        const theirs = await createCompanyFixture({ name: 'Their Client' })
        const ours = await firm('Hartley & Co')
        const rival = await firm('Rival Books')
        await engaged(mine, ours)
        await engaged(theirs, rival)
        await checked(mine, 2)
        await checked(theirs, 2)

        // The same person works at both firms, and wants out of one.
        await addPracticeMember(
          { userId: rival.ownerId, userName: rival.ownerName },
          { practiceId: rival.practiceId, userId: ours.ownerId },
        )
        await setPreferenceFor(
          { kind: 'practice', practiceId: ours.practiceId },
          ours.ownerId,
          'practice_brief',
          false,
        )

        mail.reset()
        await fire(NOW)

        const theirLetters = mail.sent.filter((message) => message.text.includes('Their Client'))
        const ourLetters = mail.sent.filter((message) => message.text.includes('My Client'))

        // Still hears from the firm they did not silence.
        expect(theirLetters.length).toBeGreaterThan(0)
        // And not from the one they did — the rival's owner still gets theirs.
        expect(ourLetters.every((message) => message.to !== ours.ownerId)).toBe(true)
      })

      it('keeps one firm’s trouble out of another firm’s post', async () => {
        const mine = await createCompanyFixture({ name: 'My Client' })
        const theirs = await createCompanyFixture({ name: 'Their Client' })
        const ours = await firm('Hartley & Co')
        const rival = await firm('Rival Books')
        await engaged(mine, ours)
        await engaged(theirs, rival)
        await checked(mine, 0)
        await checked(theirs, 4)

        mail.reset()
        await fire(NOW)

        // Only the rival hears about their own broken client.
        const toUs = mail.sent.filter((message) => message.text.includes('My Client'))
        expect(toUs).toHaveLength(0)
        expect(mail.sent.every((message) => !message.to.includes('hartley'))).toBe(true)
      })

      /** A firm-wide letter is about no single company, so it is on no client's record. */
      it('files the letter against no company at all', async () => {
        const client = await createCompanyFixture({ name: 'Zebra Ltd' })
        const shop = await firm('Hartley & Co')
        await engaged(client, shop)
        await checked(client, 2)

        mail.reset()
        await fire(NOW)

        const rows = await db
          .select({ companyId: transactionalMessages.companyId, kind: transactionalMessages.kind })
          .from(transactionalMessages)
          .where(eq(transactionalMessages.kind, 'practice_brief'))

        expect(rows).toHaveLength(1)
        expect(rows[0].companyId).toBeNull()
      })
    })

    it('still keeps one firm’s clients out of another’s triage', async () => {
      const mine = await createCompanyFixture({ name: 'My Client' })
      const theirs = await createCompanyFixture({ name: 'Their Client' })
      const ours = await firm('Hartley & Co')
      const rival = await firm('Rival Books')
      await engaged(mine, ours)
      await engaged(theirs, rival)
      // Their client is the broken one. It must not appear on our roster.
      await checked(theirs, 5)
      await checked(mine, 0)

      const queue = await practiceWorkQueue(ours.ownerId, ours.practiceId, NOW)

      expect(queue).toHaveLength(1)
      expect(queue[0].companyName).toBe('My Client')
      expect(queue[0].triage.rung).toBe('clear')
    })
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

describe('who at the firm is on which client (Phase 25)', () => {
  it('lets everybody in until the firm says otherwise', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'bookkeeper',
    })

    // Phase 18's behaviour, and the default for every engagement written
    // before Phase 25 existed. A permissions feature that revoked access on
    // its own migration would be the worst possible way to ship one.
    const [engagement] = await db
      .select()
      .from(practiceEngagements)
      .where(eq(practiceEngagements.id, shop.engagementId))
    expect(engagement.staffing).toBe('whole_firm')

    const holders = await whoHasAccess(client.ctx)
    expect(holders.map((row) => row.userId)).toContain(junior.id)
  })

  it('lets in only the assigned once the firm says so', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'bookkeeper',
    })

    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: shop.ownerId,
    })

    const result = await setEngagementStaffing(shop.ownerId, {
      engagementId: shop.engagementId,
      staffing: 'assigned_only',
    })

    // The junior loses the client they were never actually working on.
    expect(result.revoked).toBe(1)

    const holders = await whoHasAccess(client.ctx)
    expect(holders.map((row) => row.userId)).not.toContain(junior.id)
    expect(holders.map((row) => row.userId)).toContain(shop.ownerId)
  })

  it('stops a new hire reaching a client nobody put them on', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: shop.ownerId,
    })
    await setEngagementStaffing(shop.ownerId, {
      engagementId: shop.engagementId,
      staffing: 'assigned_only',
    })

    // Phase 18: "a new hire reaches every client immediately". That is the
    // convenience this phase exists to make optional.
    const junior = await accountant('Late Hire')
    const { grantedAtClients } = await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'accountant',
    })

    expect(grantedAtClients).toBe(0)
    expect((await whoHasAccess(client.ctx)).map((row) => row.userId)).not.toContain(junior.id)
  })

  it('grants on assignment and revokes on the next request when unassigned', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'accountant',
    })

    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: shop.ownerId,
    })
    await setEngagementStaffing(shop.ownerId, {
      engagementId: shop.engagementId,
      staffing: 'assigned_only',
    })

    const added = await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: junior.id,
    })
    expect(added.granted).toBe(1)

    // Signed in and looking at the books.
    const { session } = await createSession(junior.id, client.companyId)
    expect(await resolveSession(signSessionId(session.id))).not.toBeNull()

    const removed = await unassignFromEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: junior.id,
    })
    expect(removed.revoked).toBe(1)

    // `resolveSession` re-reads the membership every request (Phase 13), so
    // access stops on the next click rather than when a session expires.
    expect(await resolveSession(signSessionId(session.id))).toBeNull()
  })

  it('narrows a role for one client without touching the others', async () => {
    const one = await createCompanyFixture({ name: 'First Client' })
    const two = await createCompanyFixture({ name: 'Second Client' })
    const shop = await engaged(one)
    await engaged(two, shop)

    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'accountant',
    })

    const engagements = await engagementsForPractice(shop.practiceId, shop.ownerId)
    const first = engagements.find((row) => row.companyId === one.companyId)!

    await assignToEngagement(shop.ownerId, {
      engagementId: first.id,
      userId: junior.id,
      role: 'readonly',
    })

    const atOne = (await whoHasAccess(one.ctx)).find((row) => row.userId === junior.id)
    const atTwo = (await whoHasAccess(two.ctx)).find((row) => row.userId === junior.id)

    // The point of a per-client override: the same person, two roles.
    expect(atOne?.role).toBe('readonly')
    expect(atTwo?.role).toBe('accountant')
  })

  it('cannot use an assignment to exceed what the client agreed to', async () => {
    const client = await createCompanyFixture({ name: 'Careful Co' })
    const shop = await firm()

    // The client caps the firm at bookkeeper.
    const { engagementId } = await offerEngagement(client.ctx, {
      practiceId: shop.practiceId,
      grantedRole: 'bookkeeper',
    })
    await respondToEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId, accept: true },
    )

    await assignToEngagement(shop.ownerId, {
      engagementId,
      userId: shop.ownerId,
      role: 'owner',
    })

    // An assignment narrows. It has never been able to widen, and the cap is
    // the client's decision rather than the firm's.
    const holder = (await whoHasAccess(client.ctx)).find((row) => row.userId === shop.ownerId)
    expect(holder?.role).toBe('bookkeeper')
  })

  it('refuses to leave a live client with nobody at the firm', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    // Nobody is assigned yet, so switching would revoke everybody — including
    // the owner doing the switching.
    await expect(
      setEngagementStaffing(shop.ownerId, {
        engagementId: shop.engagementId,
        staffing: 'assigned_only',
      }),
    ).rejects.toThrow(/Assign somebody/i)

    expect((await whoHasAccess(client.ctx)).map((row) => row.userId)).toContain(shop.ownerId)
  })

  it('says what a switch would do before it does it', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'bookkeeper',
    })
    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: shop.ownerId,
    })

    const preview = await staffingChangePreview(
      shop.engagementId,
      shop.ownerId,
      'assigned_only',
    )

    // A permissions change nobody could see coming is one somebody reverses
    // in a panic.
    expect(preview).toMatchObject({ wouldGrant: 0, wouldRevoke: 1, assigned: 1 })

    // And it really was a preview.
    expect((await whoHasAccess(client.ctx)).map((row) => row.userId)).toContain(junior.id)
  })

  it('records an assignment before the client has accepted, and applies it after', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await firm()

    const { engagementId } = await requestEngagement(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, companyId: client.companyId },
    )

    await assignToEngagement(shop.ownerId, { engagementId, userId: shop.ownerId })
    const switched = await setEngagementStaffing(shop.ownerId, {
      engagementId,
      staffing: 'assigned_only',
    })

    // Nothing to grant or revoke yet — there are no memberships until the
    // client says yes.
    expect(switched).toMatchObject({ granted: 0, revoked: 0 })

    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'bookkeeper',
    })

    await respondToEngagement(
      { side: 'client', ctx: client.ctx },
      { engagementId, accept: true },
    )

    // Accepting grants the assigned and only the assigned, which is how a firm
    // decides who is on a client's books before the client agrees.
    const holders = (await whoHasAccess(client.ctx)).map((row) => row.userId)
    expect(holders).toContain(shop.ownerId)
    expect(holders).not.toContain(junior.id)
  })

  it('shows the client whether the whole firm is on their books', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    const before = (await whoHasAccess(client.ctx)).find((row) => row.viaPracticeName !== null)
    expect(before?.viaStaffing).toBe('whole_firm')

    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: shop.ownerId,
    })
    await setEngagementStaffing(shop.ownerId, {
      engagementId: shop.engagementId,
      staffing: 'assigned_only',
    })

    // "Everybody at Hartley & Co can read your ledger" and "these two people
    // can" are different facts, and a list of names cannot tell them apart.
    const after = (await whoHasAccess(client.ctx)).find((row) => row.viaPracticeName !== null)
    expect(after?.viaStaffing).toBe('assigned_only')
  })

  it('lets only a practice owner change who is on a client', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'accountant',
    })

    await expect(
      assignToEngagement(junior.id, {
        engagementId: shop.engagementId,
        userId: junior.id,
      }),
    ).rejects.toThrow(/practice owner/i)

    // And nobody from another firm at all.
    const rival = await firm('Rival & Co')
    await expect(
      assignToEngagement(rival.ownerId, {
        engagementId: shop.engagementId,
        userId: rival.ownerId,
      }),
    ).rejects.toThrow(/do not work at that practice/i)
  })

  it('refuses to assign somebody who does not work at the firm', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const stranger = await accountant('Not Employed Here')

    await expect(
      assignToEngagement(shop.ownerId, {
        engagementId: shop.engagementId,
        userId: stranger.id,
      }),
    ).rejects.toThrow(/does not work at this firm/i)
  })

  it('leaves a directly hired bookkeeper alone when the firm tightens', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)

    // Somebody the client hired themselves, who also happens to work at the
    // firm. Their own grant is not the engagement's to take away.
    const both = await accountant('Wears Two Hats')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: both.id,
      defaultRole: 'accountant',
    })
    await db
      .update(memberships)
      .set({ practiceEngagementId: null })
      .where(and(eq(memberships.companyId, client.companyId), eq(memberships.userId, both.id)))

    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: shop.ownerId,
    })
    await setEngagementStaffing(shop.ownerId, {
      engagementId: shop.engagementId,
      staffing: 'assigned_only',
    })

    expect((await whoHasAccess(client.ctx)).map((row) => row.userId)).toContain(both.id)
  })

  it('lists the whole firm against one client, assigned or not', async () => {
    const client = await createCompanyFixture({ name: 'Ridgeline' })
    const shop = await engaged(client)
    const junior = await accountant('Junior Ito')
    await addPracticeMember({ userId: shop.ownerId, userName: shop.ownerName }, {
      practiceId: shop.practiceId,
      userId: junior.id,
      defaultRole: 'bookkeeper',
    })

    await assignToEngagement(shop.ownerId, {
      engagementId: shop.engagementId,
      userId: junior.id,
      role: 'readonly',
      note: 'Bank reconciliation only',
    })

    const { staff } = await staffingFor(shop.engagementId, shop.ownerId)

    // The screen this feeds is for changing the answer, so it has to show the
    // people who are not on it yet.
    expect(staff).toHaveLength(2)

    const row = staff.find((entry) => entry.userId === junior.id)!
    expect(row).toMatchObject({
      isAssigned: true,
      assignedRole: 'readonly',
      effectiveRole: 'readonly',
      note: 'Bank reconciliation only',
    })

    const owner = staff.find((entry) => entry.userId === shop.ownerId)!
    expect(owner.isAssigned).toBe(false)
    // Still entitled, because the engagement is whole-firm.
    expect(owner.effectiveRole).toBe('accountant')
  })
})
