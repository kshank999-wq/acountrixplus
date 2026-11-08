import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, memberships, users } from '@/db/schema'
import {
  ROLE_NAMES,
  effectivePermissions,
  parseOverrides,
  type Role,
} from '@/modules/permissions'
import {
  administratorsAfter,
  membershipStandings,
  updateMembership,
  type MembershipStanding,
} from '@/modules/tenancy/memberships'
import { createSession, resolveSession } from '@/modules/auth/session'
import { whoHasAccess } from '@/modules/practice/service'
import { createOrganization, updateOrganization } from '@/modules/crm/opportunities'
import { segmentSummary } from '@/modules/marketing/audience'
import { createContact } from '@/modules/crm/opportunities'
import {
  COLUMN_WRITERS,
  columnWriterFor,
  insertOnlyColumns,
  writerCandidates,
} from '@/modules/source/column-writers'
import { RegistryError } from '@/modules/errors/registry'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * The switch painted on (Phase 202, spec §14).
 *
 * ## What the nomination asked for, and what measuring it found
 *
 * ADR 0201 nominated the editor for `memberships.permissionOverrides` — §14's
 * granular grants, read into the actor, parsed, and *applied* by
 * `effectivePermissions`, with nothing anywhere able to write one.
 *
 * Measuring the table found the nomination was **one of four**, because
 * `memberships` was **insert-only**. Nothing anywhere updated a membership
 * row. The three `delete(memberships)` statements are all in
 * `practice/service.ts` keyed by `practiceEngagementId`, so they remove only
 * rows an engagement created.
 *
 * | | |
 * | --- | --- |
 * | **no revocation** | `resolveSession` re-reads the membership on every request filtered by `isActive`, under a comment saying *"a lock that waits for a session to expire is not a lock"*. §14 asks for revocation. Nothing could set it false. |
 * | **no promotion** | `role` is read in eight places and chosen once, at invitation. The access board printed it as text. |
 * | **no overrides** | ADR 0201's finding. |
 * | **no audit** | `'membership.update'` has been in `AuditAction` since Phase 3 and nothing had ever written it — `'organization.update'`'s shape, unwritten until Phase 78. |
 *
 * ## Why Phase 201's scan could not see three of the four
 *
 * Two different blind spots, and naming them is half this phase:
 *
 * - `isActive` carries `.default(true)`, and Phase 201 excluded **any**
 *   defaulted column on the argument that the database supplies it. Too wide:
 *   a `defaultRandom()` key is the whole answer, a `.default(true)` boolean is
 *   a *starting value for a state*, and a state nothing can change is a switch
 *   painted on. Narrowed, the census went 27 → 35.
 * - `role` is written at insert and never updated, so the scan counts it as
 *   written. That class is 770 columns and is **not** a register, because
 *   almost all of it is correctly immutable — it is a declared number instead.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Blackwater Joinery' })
})

/** A second person on the books, since the fixture's owner cannot edit itself. */
async function colleague(role: Role = 'bookkeeper') {
  const [user] = await db
    .insert(users)
    .values({ name: 'Sam Reed', email: `sam-${Date.now()}@example.test`, passwordHash: 'x' })
    .returning()

  await db.insert(memberships).values({
    companyId: fixture.companyId,
    userId: user.id,
    role,
  })

  return user
}

describe('what the census could not see', () => {
  it('counts a defaulted state as needing a writer, and a generated key as not', () => {
    /**
     * The exclusion, narrowed. Asserted on the two directions that matter
     * rather than on the total alone: a `defaultNow()` timestamp must stay out
     * (195 of the 206 defaulted columns are keys and timestamps, and a
     * register of those would be an excuse generator), and this phase's own
     * subject had to come in.
     *
     * `memberships.isActive` is not in the answer any more because
     * `updateMembership` writes it — which is the assertion that the editor
     * reaches the column, rather than a form field asserted to exist.
     */
    const candidates = writerCandidates().map((row) => `${row.table}.${row.column}`)

    /*
      35 when this phase measured it, 34 since Phase 203 closed
      `gift_cards.isActive` — the one of the six switches where the thing
      nobody could turn off was money. Corrected rather than relaxed.
    */
    expect(candidates).toHaveLength(32)

    // In, because nothing can turn them off — and these two are the ones that
    // need *two* changes rather than one, which is why they are last.
    expect(candidates).toContain('clauses.isActive')
    expect(candidates).toContain('bills_of_materials.isActive')

    // Out, because the database is their author.
    expect(candidates.filter((column) => column.endsWith('.createdAt'))).toEqual([])
    expect(candidates.filter((column) => column.endsWith('.id'))).toEqual([])

    // Out, because this phase closed them — and `gift_cards.isActive` because
    // Phase 203 did, which is what proves the editor reaches the column rather
    // than the entry having been reworded.
    expect(candidates).not.toContain('gift_cards.isActive')
    expect(candidates).not.toContain('cash_drawers.isActive')
    expect(candidates).not.toContain('practices.isActive')
    expect(candidates).not.toContain('memberships.isActive')
    expect(candidates).not.toContain('memberships.permissionOverrides')
    expect(candidates).not.toContain('organizations.tags')
  })

  it('declares the insert-only class as a number rather than a register', () => {
    /**
     * Phase 139's device. 770 columns are written at insert and never updated,
     * and the scan counts every one as written — which is how
     * `memberships.role` stayed unchangeable for 201 phases without the
     * census reporting anything. Most of the 770 are immutable **on purpose**
     * (ADR 0021's sent document, ADR 0042's live record), so a register of
     * them would say "correct" 760 times and hide the ten that are not.
     *
     * Measured rather than quoted, so the sentence in the audit cannot drift
     * from it (Phase 179), and declared so the limitation keeps its reason
     * (Phase 185).
     */
    /*
      770 when this phase measured it, 769 since Phase 203 gave
      `gift_cards.code` the update a reissued card needs — one of the few in
      the class that genuinely was not immutable, and the only way to tell is
      still to read.

      Back to 770 in Phase 204, and the reason is the class's own shape rather
      than a regression: `removePracticeMember` now returns
      `memberships.companyId` so it can file an audit event per client, which
      *names* a column that is written at insert and never updated. A column
      enters this number by being read for the first time.
    */
    expect(insertOnlyColumns()).toBe(770)
  })

  it('removed the entry for the column it closed, rather than rewording it', () => {
    // Both directions of the register's rule, from the other side: the
    // `memberships` entry is gone because the candidate is gone.
    expect(() => columnWriterFor('memberships', 'permissionOverrides')).toThrow(RegistryError)
    expect(COLUMN_WRITERS.map((entry) => entry.table)).not.toContain('memberships')
  })

  it('argues the switches nobody can turn off', () => {
    /*
      Six `isActive` columns nothing can turn off — and they are **not** one
      finding, which reading the readers is what established.

      Three were **enforced**: `redeemGiftCard` refuses an inactive card,
      `openShift` refuses an inactive till, and four queries filter an inactive
      practice out of the search a client picks a firm from. The refusal is
      already written and the state is unreachable.

      Two are **projections only**: the clause library and the bill of
      materials select the column to display it and nothing filters on it. A
      writer alone would give somebody a flag they could set with no effect —
      Phase 160's shape arrived at by closing half a gap — so each is two
      changes rather than one.

      An earlier draft of the register claimed the recipe choice was filtered
      on the column. It is not, and correcting that is why the entries say
      which kind each one is.

      **Phase 203 closed the gift card and Phase 204 the other two enforced
      ones**, so the two declared here are exactly the projection-only pair.
      The enforced ones went first precisely because they were enforced: the
      refusal existed and the whole gap was the writer, which is one change.
      These two need a filter as well as a writer, and shipping the writer
      alone would be Phase 160's shape reached by closing half a gap.
    */
    const switches = COLUMN_WRITERS.filter((entry) => entry.columns.includes('isActive'))

    expect(switches.map((entry) => entry.table).sort()).toEqual([
      'bills_of_materials',
      'clauses',
    ])

    for (const entry of switches) {
      expect(entry.verdict, entry.table).toBe('unwritable')
      expect(entry.because.length, entry.table).toBeGreaterThan(140)
    }

    // `memberships.isActive` was closed here, `gift_cards.isActive` in Phase
    // 203, and the till and the practice in Phase 204 — so the count above is
    // two rather than six, and every absence is the register's two-direction
    // rule working rather than an entry quietly reworded.
    expect(switches.map((entry) => entry.table)).not.toContain('memberships')
  })
})

describe('one list of roles', () => {
  it('matches the database enum and the screen that offers them', () => {
    /**
     * There were **three** lists of roles with no mechanical relationship: the
     * `Role` union, `roleEnum` in the schema, and a `MEMBER_ROLES` const in
     * the access board. Nothing could validate a role arriving from a form,
     * which is what this phase needed first, so `ROLE_NAMES` is now the one
     * list and `Role` is derived from it.
     *
     * Held to the other two here rather than replacing them: a drizzle enum
     * has to be a literal array in the schema, and the board's order is
     * deliberate — least to most access, which is not the order a service
     * wants. What must not drift is the *set*.
     */
    const schema = readFileSync('src/db/schema/tenancy.ts', 'utf8')
    const enumBlock = schema.slice(
      schema.indexOf("export const roleEnum = pgEnum('role', ["),
      schema.indexOf(']', schema.indexOf("export const roleEnum")),
    )
    const inSchema = [...enumBlock.matchAll(/'(\w+)'/g)].map((m) => m[1]).filter((n) => n !== 'role')

    expect(inSchema.sort()).toEqual([...ROLE_NAMES].sort())

    const board = readFileSync('src/app/settings/access/board.tsx', 'utf8')
    const memberBlock = board.slice(
      board.indexOf('const MEMBER_ROLES = ['),
      board.indexOf(']', board.indexOf('const MEMBER_ROLES = [')),
    )
    const offered = [...memberBlock.matchAll(/'(\w+)'/g)].map((m) => m[1])

    expect(offered.sort()).toEqual([...ROLE_NAMES].sort())
  })
})

describe('changing somebody’s standing', () => {
  it('promotes, and the audit says what moved', async () => {
    const sam = await colleague('bookkeeper')

    const row = await updateMembership(fixture.ctx, sam.id, { role: 'accountant' })
    expect(row.role).toBe('accountant')

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.companyId, fixture.companyId), eq(auditEvents.action, 'membership.update')),
      )

    // The action has been in the union since Phase 3 with nothing writing it.
    expect(event).toBeDefined()
    expect(event.before).toMatchObject({ role: 'bookkeeper' })
    expect(event.after).toMatchObject({ role: 'accountant' })
  })

  it('grants and revokes on top of the role, and the actor feels it', async () => {
    /**
     * The assertion ADR 0201's finding was about. Not that the column is
     * written — that the **session** resolves the grant, because
     * `effectivePermissions` was already applying overrides and the question
     * was only ever whether anything could put one there.
     */
    const sam = await colleague('bookkeeper')

    await updateMembership(fixture.ctx, sam.id, {
      grant: ['accounting:journal'],
      revoke: ['bookkeeping:categorize'],
    })

    const [standing] = (await membershipStandings(fixture.ctx)).filter(
      (row) => row.userId === sam.id,
    )

    const permissions = effectivePermissions(standing.role, standing.overrides)
    expect(permissions.has('accounting:journal')).toBe(true)
    expect(permissions.has('bookkeeping:categorize')).toBe(false)
    // And the role still decides everything nobody touched.
    expect(permissions.has('bookkeeping:view')).toBe(true)
  })

  it('stores one representation of “no overrides”', async () => {
    // `{ grant: [], revoke: [] }` and null mean the same to
    // `effectivePermissions`, so an override cleared back to nothing is null
    // rather than an empty pair that reads as a decision somebody made.
    const sam = await colleague('bookkeeper')

    await updateMembership(fixture.ctx, sam.id, { grant: ['ai:use'] })
    await updateMembership(fixture.ctx, sam.id, { grant: [], revoke: [] })

    const [row] = await db
      .select({ overrides: memberships.permissionOverrides })
      .from(memberships)
      .where(eq(memberships.userId, sam.id))

    expect(row.overrides).toBeNull()
    expect(parseOverrides(row.overrides)).toBeNull()
  })

  it('revokes access, and the next request is refused', async () => {
    /**
     * §14's *revocation*, which had a mechanism and no handle.
     * `resolveSession` filters the membership on `isActive` on **every**
     * request, so this asserts what a revoked person's next page load does
     * rather than what the column says.
     */
    const sam = await colleague('bookkeeper')
    const { cookieValue } = await createSession(sam.id, fixture.companyId)

    expect(await resolveSession(cookieValue)).not.toBeNull()

    await updateMembership(fixture.ctx, sam.id, { isActive: false })

    expect(await resolveSession(cookieValue)).toBeNull()

    // And restoring puts them back, because a revocation somebody cannot undo
    // is a deletion wearing one.
    await updateMembership(fixture.ctx, sam.id, { isActive: true })
    expect(await resolveSession(cookieValue)).not.toBeNull()
  })

  it('shows the standing the access board had been dropping', async () => {
    // `whoHasAccess` has selected and returned `isActive` since Phase 25 and
    // the page's own map threw it away — the second link, moot while nothing
    // could revoke and wrong the moment something could.
    const sam = await colleague('bookkeeper')
    await updateMembership(fixture.ctx, sam.id, {
      isActive: false,
      grant: ['accounting:journal'],
    })

    const holder = (await whoHasAccess(fixture.ctx)).find((row) => row.userId === sam.id)

    expect(holder?.isActive).toBe(false)
    expect(holder?.overrides?.grant).toEqual(['accounting:journal'])

    const page = readFileSync('src/app/settings/access/page.tsx', 'utf8')
    expect(page).toContain('isActive: holder.isActive')
  })
})

describe('the four refusals', () => {
  it('refuses your own membership', async () => {
    await expect(
      updateMembership(fixture.ctx, fixture.ctx.userId, { role: 'readonly' }),
    ).rejects.toThrow(/cannot change your own access/)
  })

  it('refuses to leave nobody able to manage the company', async () => {
    /**
     * The invariant, and the one worth having as a property of the *set*: the
     * three ways to break it — demote the last administrator, revoke their
     * access, revoke the permission itself — all come through
     * `administratorsAfter` rather than through three guards that could drift.
     *
     * Driven here on the owner's own row from a second administrator, because
     * the self-refusal above would otherwise be the thing that caught it and
     * the test would pass without this rule existing (Phase 121).
     */
    /*
      Sam holds `users:manage` as a **granted override** on a bookkeeper rather
      than as an owner, which is the only way to reach this rule at all: a
      second owner would satisfy the invariant, and the first draft of this
      test made Sam one and passed while the rule did nothing (Phase 121).
      The seam §14 asks for is what makes the test possible.
    */
    const sam = await colleague('bookkeeper')
    await updateMembership(fixture.ctx, sam.id, { grant: ['users:manage'] })

    const samCtx = {
      ...fixture.ctx,
      userId: sam.id,
      role: 'bookkeeper' as Role,
      overrides: JSON.stringify({ grant: ['users:manage'], revoke: [] }),
    }

    // Demotion.
    await expect(
      updateMembership(samCtx, fixture.ctx.userId, { role: 'readonly' }),
    ).rejects.toThrow(/Somebody has to be able to manage this company/)

    // Revocation of access.
    await expect(
      updateMembership(samCtx, fixture.ctx.userId, { isActive: false }),
    ).rejects.toThrow(/Somebody has to be able to manage this company/)

    // Revocation of the permission itself, which a role check would miss.
    await expect(
      updateMembership(samCtx, fixture.ctx.userId, { revoke: ['company:manage'] }),
    ).rejects.toThrow(/Somebody has to be able to manage this company/)
  })

  it('allows the same change once somebody else can administer', async () => {
    // The other half of Phase 121: the refusal above has to be about the
    // invariant rather than about owners being special. A second owner, and
    // the first can be demoted.
    const sam = await colleague('bookkeeper')
    await updateMembership(fixture.ctx, sam.id, { grant: ['users:manage'] })
    const second = await colleague('owner')

    const samCtx = {
      ...fixture.ctx,
      userId: sam.id,
      role: 'bookkeeper' as Role,
      overrides: JSON.stringify({ grant: ['users:manage'], revoke: [] }),
    }

    expect(second.id).not.toBe(sam.id)

    const row = await updateMembership(samCtx, fixture.ctx.userId, { role: 'readonly' })
    expect(row.role).toBe('readonly')
  })

  it('counts a granted company:manage as administration, not just the owner role', () => {
    /**
     * Asserted on the predicate directly, because it is the case the
     * invariant exists for and the hardest to reach through the service: a
     * bookkeeper **granted** `company:manage` is an administrator, so
     * demoting the only owner is then allowed.
     *
     * A rule written as "is there another owner" would get this wrong in the
     * direction that locks a company out of its own books — the grant is
     * exactly the seam §14 asks for.
     */
    const owner: MembershipStanding = {
      userId: 'a',
      role: 'owner',
      overrides: null,
      isActive: true,
      practiceEngagementId: null,
    }
    const granted: MembershipStanding = {
      userId: 'b',
      role: 'bookkeeper',
      overrides: { grant: ['company:manage'], revoke: [] },
      isActive: true,
      practiceEngagementId: null,
    }

    expect(
      administratorsAfter([owner, granted], { ...owner, role: 'readonly' }).map((r) => r.userId),
    ).toEqual(['b'])

    // And an inactive one does not count, which is the whole reason the
    // predicate reads `isActive` as well as the permissions.
    expect(
      administratorsAfter([owner, { ...granted, isActive: false }], {
        ...owner,
        role: 'readonly',
      }),
    ).toEqual([])
  })

  it('refuses a membership that belongs to a practice engagement', async () => {
    const sam = await colleague('bookkeeper')
    await db
      .update(memberships)
      .set({ practiceEngagementId: '11111111-1111-1111-1111-111111111111' })
      .where(eq(memberships.userId, sam.id))

    await expect(updateMembership(fixture.ctx, sam.id, { role: 'readonly' })).rejects.toThrow(
      /practice engagement/,
    )
  })

  it('refuses a permission granted and revoked at once', async () => {
    const sam = await colleague('bookkeeper')

    await expect(
      updateMembership(fixture.ctx, sam.id, {
        grant: ['accounting:close'],
        revoke: ['accounting:close'],
      }),
    ).rejects.toThrow(/cannot be both granted and revoked/)
  })

  it('refuses a permission that does not exist', async () => {
    const sam = await colleague('bookkeeper')

    await expect(
      updateMembership(fixture.ctx, sam.id, { grant: ['books:everything' as never] }),
    ).rejects.toThrow(/no permission called/)
  })

  it('refuses somebody who is not on these books', async () => {
    const other = await createCompanyFixture({ name: 'Elsewhere Ltd' })

    await expect(
      updateMembership(fixture.ctx, other.ctx.userId, { role: 'readonly' }),
    ).rejects.toThrow(/does not have access to these books/)
  })
})

describe('one answer to who administers people', () => {
  it('puts invitations and standing on the same permission', () => {
    /**
     * `inviteToCompany` gated on `company:manage` and `updateMembership`
     * needed a gate — two answers to "who may change an individual's standing
     * on this company" would be the defect this project keeps finding, so both
     * are on `users:manage`, the permission named for exactly this and read
     * until now only by `timebilling`.
     *
     * Only `owner` holds either today, so no role's behaviour changed. The
     * seam did: a company can grant `users:manage` alone and get somebody who
     * invites, promotes and revokes without the Studio, the module switches or
     * the billing.
     *
     * `company:manage` keeps the company's own arrangements, the engagement
     * with a practice included — a contract with a firm is a different
     * question from a person's role, and the practice side can end one too.
     */
    const invitations = readFileSync('src/modules/notify/invitations.ts', 'utf8')
    const module = readFileSync('src/modules/tenancy/memberships.ts', 'utf8')

    expect(module).toContain("requirePermission(ctx, 'users:manage')")

    /*
      The two that *change* something, by name. A blanket match over the file
      also caught `companyInvitations`, which reads the pending list on
      `accounting:view` and is right to — the claim is about who may act, not
      about who may look.
    */
    for (const fn of ['inviteToCompany', 'withdrawCompanyInvitation']) {
      const at = invitations.indexOf(`export async function ${fn}(`)
      expect(at, fn).toBeGreaterThan(-1)
      const body = invitations.slice(at, at + 600)
      expect(/requirePermission\(ctx, '([\w:]+)'\)/.exec(body)?.[1], fn).toBe('users:manage')
    }
  })

  it('refuses somebody whose role does not include it', async () => {
    const sam = await colleague('bookkeeper')
    const samCtx = { ...fixture.ctx, userId: sam.id, role: 'bookkeeper' as Role }

    await expect(updateMembership(samCtx, fixture.ctx.userId, { role: 'readonly' })).rejects.toThrow(
      /users:manage/,
    )
  })
})

describe('the second segment filter with no writer', () => {
  /**
   * `organizations.tags` is one of §10's named dimensions, with `in` and
   * `contains` operators of its own and a label on the segment workspace —
   * and nothing set it, exactly as `sizeBand` had not one phase earlier. It
   * was invisible to Phase 201's scan because the column carries
   * `.default([])`, which is the exclusion this phase narrowed.
   */
  it('is set on the way in, and survives a partial save', async () => {
    const club = await createOrganization(fixture.ctx, {
      name: 'Maldon Sailing Club',
      tags: ['commercial', 'repeat'],
    })

    expect(club.tags).toEqual(['commercial', 'repeat'])

    // A form submitting six of fourteen fields must not blank the rest —
    // the rule `diffParty` takes a partial input for.
    const moved = await updateOrganization(fixture.ctx, club.id, { city: 'Maldon' })
    expect(moved.tags).toEqual(['commercial', 'repeat'])

    const retagged = await updateOrganization(fixture.ctx, club.id, { tags: ['residential'] })
    expect(retagged.tags).toEqual(['residential'])
  })

  it('makes the audience the filter promised', async () => {
    const club = await createOrganization(fixture.ctx, {
      name: 'Maldon Sailing Club',
      tags: ['commercial'],
    })
    const yard = await createOrganization(fixture.ctx, {
      name: 'Tollesbury Boatyard',
      tags: ['residential'],
    })

    await createContact(fixture.ctx, {
      organizationId: club.id,
      firstName: 'Ada',
      email: 'ada@maldon.test',
      emailConsent: 'subscribed',
    })
    await createContact(fixture.ctx, {
      organizationId: yard.id,
      firstName: 'Bram',
      email: 'bram@tollesbury.test',
      emailConsent: 'subscribed',
    })

    expect(
      await segmentSummary(fixture.ctx, {
        matchType: 'all',
        rules: [{ field: 'tags', operator: 'in', value: ['commercial'] }],
        lostOpportunityNurture: false,
      }),
    ).toMatchObject({ total: 1, contactable: 1 })

    // And a tag nobody carries still matches nobody, so the above is not
    // passing on a matcher that ignores the rule.
    expect(
      await segmentSummary(fixture.ctx, {
        matchType: 'all',
        rules: [{ field: 'tags', operator: 'in', value: ['industrial'] }],
        lostOpportunityNurture: false,
      }),
    ).toMatchObject({ total: 0 })
  })
})
