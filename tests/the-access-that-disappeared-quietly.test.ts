import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, cashDrawers, drawerShifts, memberships, practices } from '@/db/schema'
import { registerUser } from '@/modules/tenancy/onboarding'
import {
  addPracticeMember,
  createPractice,
  endEngagement,
  offerEngagement,
  practicesFor,
  removePracticeMember,
  respondToEngagement,
  setPracticeActive,
  whoHasAccess,
} from '@/modules/practice/service'
import { addDrawer, listDrawers, openShift, setDrawerActive } from '@/modules/drawer/service'
import { setModuleEnabled } from '@/modules/industry/modules'
import { COLUMN_WRITERS, columnWriterFor, writerCandidates } from '@/modules/source/column-writers'
import { RegistryError } from '@/modules/errors/registry'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * The access that disappeared quietly (Phase 204, spec §14).
 *
 * ## What ADR 0203 nominated, and what measuring added
 *
 * It nominated the two remaining **enforced** switches — the ones where a
 * refusal is already written and the whole gap is the writer:
 * `cash_drawers.isActive`, which `openShift` refuses on, and
 * `practices.isActive`, which four queries filter on.
 *
 * Measuring them found something neither census could see, because both
 * censuses are about columns. **Three practice-side actions remove a client's
 * access to their own books, and the client's audit log said nothing about any
 * of them:**
 *
 * | | |
 * | --- | --- |
 * | `endEngagement` | wrote its event **only** `if (party.side === 'client')`. When the accountant walked away, nothing was recorded. |
 * | `removePracticeMember` | deletes the memberships that person held at *every* client of the firm, and audited nothing on either side. |
 * | closing a practice | would have been a third. It refuses while engagements are live instead. |
 *
 * §14 asks for an *"Audit log for … changes to … permissions"*, and losing
 * your accountant's access is a permission change on your books.
 *
 * The asymmetry was never a decision: `recordAudit` needs a company and the
 * practice side has none of its own. But all three of the things it needs are
 * on the engagement, and `ActorContext.viaPractice` exists for exactly this —
 * its own comment says a client *"should not have to cross-reference a user
 * list to find out that the person who reopened December works for their
 * accountants"*. The field was built to produce this line and never fired on
 * the two actions where it matters most.
 *
 * ## The asymmetry the till settles
 *
 * ADR 0203 predicted retiring a drawer would need Phase 203's shape — a
 * decision about where the float went, the way stopping a gift card needs one
 * about its balance. **It does not**, and the reason is the finding: a gift
 * card's balance is a liability on account 2590, so making the card
 * unspendable without moving that figure leaves money nobody can settle. A
 * drawer's float is cash in a drawer, and `closeShift` already accounts for it
 * — the Z-reading, the expected figure, the over-or-short posting. So the
 * refusal is only that the shift has to be closed first, and nothing posts.
 */

let client: Fixture

beforeEach(async () => {
  client = await createCompanyFixture({ name: 'Ridgeline Construction' })
})

async function accountant(name = 'Dana Chen') {
  return registerUser({
    name,
    email: `acct-${Math.floor(performance.now() * 1000)}-${name.replace(/\W/g, '')}@example.test`,
    password: 'correct-horse-battery',
  })
}

async function firm(name = 'Hartley & Co') {
  const owner = await accountant()
  const practice = await createPractice({
    userId: owner.id,
    userName: owner.name,
    name,
    contactEmail: 'hello@hartley.test',
  })
  return { practiceId: practice.id, ownerId: owner.id, ownerName: owner.name }
}

async function engaged(house?: Awaited<ReturnType<typeof firm>>) {
  const shop = house ?? (await firm())
  const { engagementId } = await offerEngagement(client.ctx, { practiceId: shop.practiceId })
  await respondToEngagement(
    { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
    { engagementId, accept: true },
  )
  return { ...shop, engagementId }
}

/** Audit events on the client's own books, by action. */
async function clientEvents(action: string) {
  return db
    .select({ actorName: auditEvents.actorName, after: auditEvents.after })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.companyId, client.companyId), eq(auditEvents.action, action)),
    )
}

describe('the accountant walking away', () => {
  it('is in the client’s audit log, named with the firm', async () => {
    /**
     * The event the client most needs and the one that was never written.
     * `viaPractice` makes the line read *"Dana Chen (Hartley & Co)"*, which is
     * what `recordAudit`'s own comment describes and what nothing had ever
     * produced for this action.
     */
    const shop = await engaged()

    const result = await endEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId: shop.engagementId, reason: 'Retiring' },
    )

    expect(result.membershipsRemoved).toBeGreaterThan(0)

    const [event] = await clientEvents('engagement.end')

    expect(event).toBeDefined()
    expect(event.actorName).toBe('Dana Chen (Hartley & Co)')
    expect(event.after).toMatchObject({ endedBy: 'practice', reason: 'Retiring' })
  })

  it('says which side ended it, because the actor’s name does not', async () => {
    /*
      "We took our books back" and "they resigned" are different facts about
      the same row, and an audit trail that records only who clicked cannot
      distinguish them — the client's owner ending it and the firm's owner
      ending it are two different names either way.
    */
    const shop = await engaged()

    await endEngagement(
      { side: 'client', ctx: client.ctx },
      { engagementId: shop.engagementId },
    )

    const [event] = await clientEvents('engagement.end')
    expect(event.after).toMatchObject({ endedBy: 'client' })
    // And the client's own name, with no firm on it.
    expect(event.actorName).not.toContain('(')
  })

  it('removes the access it says it removed', async () => {
    // The assertion that keeps the audit honest: the event claims a count, and
    // the memberships really are gone.
    const shop = await engaged()

    const before = await whoHasAccess(client.ctx)
    expect(before.filter((row) => row.viaPracticeName).length).toBeGreaterThan(0)

    await endEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId: shop.engagementId },
    )

    const after = await whoHasAccess(client.ctx)
    expect(after.filter((row) => row.viaPracticeName)).toEqual([])
  })
})

describe('somebody leaving the firm', () => {
  it('is recorded on every client whose books it touched', async () => {
    /**
     * `removePracticeMember` deletes the memberships that person held at every
     * client of the firm and audited **nothing, anywhere**. Per company rather
     * than once, because a client's audit trail is theirs: an event filed
     * against one of twelve companies is eleven companies with no record.
     *
     * Its own action rather than `engagement.end`, because the engagement is
     * still active — one person left the firm, and the firm still has the
     * books.
     */
    const shop = await engaged()
    const staff = await accountant('Ruth Okafor')

    await addPracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id, practiceRole: 'staff' },
    )

    const result = await removePracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id },
    )

    expect(result.revokedAtClients).toBe(1)

    const [event] = await clientEvents('engagement.member_removed')

    expect(event).toBeDefined()
    expect(event.actorName).toBe('Dana Chen (Hartley & Co)')
    expect(event.after).toMatchObject({ removed: 'Ruth Okafor', practice: 'Hartley & Co' })
  })

  it('leaves the engagement itself alone', async () => {
    // One person left; the firm still has the books. So no `engagement.end`,
    // and whoever else the firm staffs the client with keeps their access.
    const shop = await engaged()
    const staff = await accountant('Ruth Okafor')

    await addPracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id, practiceRole: 'staff' },
    )
    await removePracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id },
    )

    expect(await clientEvents('engagement.end')).toEqual([])

    // The owner is still on the books.
    const holders = await whoHasAccess(client.ctx)
    expect(holders.some((row) => row.userId === shop.ownerId)).toBe(true)
    expect(holders.some((row) => row.userId === staff.id)).toBe(false)
  })

  it('records nothing when the firm has no clients', async () => {
    /*
      Phase 121: the per-company loop has to be driven by what was actually
      removed rather than by the firm's engagement list, or a firm with no
      clients would write an event against nothing.
    */
    const shop = await firm()
    const staff = await accountant('Ruth Okafor')

    await addPracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id, practiceRole: 'staff' },
    )

    const result = await removePracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id },
    )

    expect(result.revokedAtClients).toBe(0)
    expect(await clientEvents('engagement.member_removed')).toEqual([])
  })
})

describe('closing the firm', () => {
  it('takes it out of its own members’ list, which is what closing means', async () => {
    /**
     * The strongest of the four readers and the one that makes this the right
     * way to close a firm rather than a flag about one: `practicesFor` filters
     * on `isActive`, so an inactive practice disappears from its **own
     * members'** list and none of them can switch into it again.
     */
    const shop = await firm()

    expect((await practicesFor(shop.ownerId)).map((row) => row.practiceId)).toEqual([
      shop.practiceId,
    ])

    await setPracticeActive({ userId: shop.ownerId }, {
      practiceId: shop.practiceId,
      isActive: false,
    })

    expect(await practicesFor(shop.ownerId)).toEqual([])

    // Reversible, because a firm closed by mistake is not a firm dissolved.
    await setPracticeActive({ userId: shop.ownerId }, {
      practiceId: shop.practiceId,
      isActive: true,
    })
    expect(await practicesFor(shop.ownerId)).toHaveLength(1)
  })

  it('refuses while a client’s books are still reachable, and says how many', async () => {
    /**
     * A closed practice with live engagements is an outside firm holding
     * somebody's ledger with no firm to answer for it — the client's access
     * board reads the firm's name through a join, and the firm would be gone
     * from every list that could answer.
     *
     * The same judgement Phase 203 made about a gift card's balance: the thing
     * that is owed gets dealt with before the switch moves.
     */
    const shop = await engaged()

    await expect(
      setPracticeActive({ userId: shop.ownerId }, {
        practiceId: shop.practiceId,
        isActive: false,
      }),
    ).rejects.toThrow(/1 engagement is still open/)

    // And it really is still open — a refused close is not a half-done one.
    const [row] = await db
      .select({ isActive: practices.isActive })
      .from(practices)
      .where(eq(practices.id, shop.practiceId))
    expect(row.isActive).toBe(true)

    // Ended, and then it closes.
    await endEngagement(
      { side: 'practice', userId: shop.ownerId, userName: shop.ownerName },
      { engagementId: shop.engagementId },
    )

    const closed = await setPracticeActive({ userId: shop.ownerId }, {
      practiceId: shop.practiceId,
      isActive: false,
    })
    expect(closed.isActive).toBe(false)
  })

  it('is refused to anybody who is not an owner of it', async () => {
    const shop = await firm()
    const staff = await accountant('Ruth Okafor')

    await addPracticeMember(
      { userId: shop.ownerId, userName: shop.ownerName },
      { practiceId: shop.practiceId, userId: staff.id, practiceRole: 'staff' },
    )

    await expect(
      setPracticeActive({ userId: staff.id }, {
        practiceId: shop.practiceId,
        isActive: false,
      }),
    ).rejects.toThrow(/Only a practice owner/)

    const outsider = await accountant('Nobody')
    await expect(
      setPracticeActive({ userId: outsider.id }, {
        practiceId: shop.practiceId,
        isActive: false,
      }),
    ).rejects.toThrow(/do not work at that practice/)
  })
})

describe('retiring a till', () => {
  beforeEach(async () => {
    await setModuleEnabled(client.ctx, 'cash_drawer', true)
  })

  it('is what openShift had been refusing on since Phase 33', async () => {
    /**
     * The point of the nomination, asserted through the reader rather than the
     * column: `openShift` has refused an inactive drawer since Phase 33 and
     * the state was unreachable. This is the first test that can reach it.
     */
    const drawer = await addDrawer(client.ctx, { name: 'Front counter' })

    await setDrawerActive(client.ctx, { drawerId: drawer.id, isActive: false })

    await expect(openShift(client.ctx, { drawerId: drawer.id })).rejects.toThrow(
      /Front counter is not in use/,
    )

    // And back, because a counter reopened in the spring is not a new counter.
    await setDrawerActive(client.ctx, { drawerId: drawer.id, isActive: true })
    const shift = await openShift(client.ctx, { drawerId: drawer.id })
    expect(shift).toBeDefined()
  })

  it('refuses while a shift is open, and posts nothing either way', async () => {
    /**
     * ADR 0203 expected this to need a decision about the float. It does not:
     * `closeShift` already does the Z-reading and posts the over-or-short, so
     * there is nothing here to decide and nothing for this to post. The
     * refusal is one sentence instead of three dispositions, and the reason is
     * the asymmetry with a gift card — a float is cash somebody counts, a card
     * balance is a liability on 2590.
     */
    const drawer = await addDrawer(client.ctx, { name: 'Front counter' })
    await openShift(client.ctx, { drawerId: drawer.id, floatCents: 10_000 })

    await expect(
      setDrawerActive(client.ctx, { drawerId: drawer.id, isActive: false }),
    ).rejects.toThrow(/has a shift open/)

    const [row] = await db
      .select({ isActive: cashDrawers.isActive })
      .from(cashDrawers)
      .where(eq(cashDrawers.id, drawer.id))
    expect(row.isActive).toBe(true)

    // The open shift is untouched by the refusal.
    const [shift] = await db
      .select({ status: drawerShifts.status })
      .from(drawerShifts)
      .where(eq(drawerShifts.drawerId, drawer.id))
    expect(shift.status).toBe('open')
  })

  it('stays on the list, retired, because its history is part of the books', async () => {
    const drawer = await addDrawer(client.ctx, { name: 'Front counter' })
    await setDrawerActive(client.ctx, { drawerId: drawer.id, isActive: false })

    const drawers = await listDrawers(client.ctx)
    expect(drawers).toHaveLength(1)
    expect(drawers[0]).toMatchObject({ name: 'Front counter', isActive: false })
  })

  it('records the retirement, and which way it went', async () => {
    const drawer = await addDrawer(client.ctx, { name: 'Front counter' })

    await setDrawerActive(client.ctx, { drawerId: drawer.id, isActive: false })
    await setDrawerActive(client.ctx, { drawerId: drawer.id, isActive: true })

    const actions = (
      await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.companyId, client.companyId))
    ).map((row) => row.action)

    expect(actions).toContain('drawer.retire')
    expect(actions).toContain('drawer.restore')
  })

  it('is scoped, so one company cannot retire another’s counter', async () => {
    const drawer = await addDrawer(client.ctx, { name: 'Front counter' })
    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })
    await setModuleEnabled(other.ctx, 'cash_drawer', true)

    await expect(
      setDrawerActive(other.ctx, { drawerId: drawer.id, isActive: false }),
    ).rejects.toThrow(/No such drawer/)
  })
})

describe('what the register says now', () => {
  it('declares neither switch, because both have writers', () => {
    /**
     * The two-direction rule for the third phase running: an entry outliving
     * its candidate is the excuse ADR 0134 names, so a closed column's entry
     * is **removed** rather than reworded.
     */
    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)

    expect(candidates).not.toContain('cash_drawers.isActive')
    expect(candidates).not.toContain('practices.isActive')
    expect(() => columnWriterFor('cash_drawers', 'isActive')).toThrow(RegistryError)
    expect(() => columnWriterFor('practices', 'isActive')).toThrow(RegistryError)
  })

  it('leaves none, now that the projection-only pair is closed too', () => {
    /**
     * Of the six switches Phase 202 found, three were **enforced** — a refusal
     * already written, so the whole gap was the writer — and two were
     * **projections only**, selected to be displayed with nothing filtering on
     * either, where a writer alone would hand somebody a control with no
     * effect. Phases 203 and 204 closed the enforced ones, and **Phase 205
     * closed the pair this assertion used to name**.
     *
     * That ordering is the finding rather than an accident of what was
     * convenient: reading each reader is what told the two kinds apart, and an
     * earlier draft of the register had one of them wrong.
     *
     * The assertion is corrected rather than deleted, and it is worth saying
     * why it had to be corrected **twice**. Phase 202's test file holds the
     * same claim about the same register, and Phase 205 moved that one and
     * missed this one — so the full run went red on a sentence two phases
     * behind the code. One register, asserted in two places, is one more place
     * than anybody remembers to look.
     */
    const switches = COLUMN_WRITERS.filter((entry) => entry.columns.includes('isActive'))

    expect(switches).toEqual([])
  })
})

describe('what neither census could see', () => {
  it('is an action with no row of its own, found by reading the table', () => {
    /**
     * Both censuses are about **columns**. The audit gap is about a *write
     * that never happened* — `recordAudit` not being called — and there is no
     * column whose presence or absence says so. Phases 201–203 measured
     * columns read and not written, columns written only at insert, and
     * declined the mirror; none of them could report a missing audit event.
     *
     * So this is asserted on the source, which is the only place the claim
     * lives: the branch that used to gate the audit on the client side is
     * gone, and the practice side has a context to file under.
     */
    const service = readFileSync('src/modules/practice/service.ts', 'utf8')

    expect(service).not.toContain("if (party.side === 'client') {\n      await recordAudit(")
    expect(service).toContain('practiceActorContext')
    // Written once per client the removal touched, which is the loop.
    expect(service).toContain('for (const row of removed)')
  })
})
