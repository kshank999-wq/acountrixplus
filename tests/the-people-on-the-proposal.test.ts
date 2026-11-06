import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { teamMembers } from '@/db/schema'
import { createCompanyFixture, addUserWithRole, type Fixture } from './helpers'
import { DomainError } from '@/modules/errors'
import { PermissionError } from '@/modules/permissions'
import { uploadAsset } from '@/modules/studio/assets'
import { SHOWN, BLOCK_DEFINITIONS, parseBlocks, type Block } from '@/modules/design/blocks'
import { BLOCK_SURFACES, coverageMarker } from '@/modules/design/surfaces'
import { BUILT_IN_TEMPLATES } from '@/modules/design/templates'
import { resolveBlocks, unresolvedInBlocks } from '@/modules/design/merge-fields'
import { renderEmailHtml, renderEmailText } from '@/modules/marketing/render-email'
import {
  MAX_TEAM_MEMBERS,
  addTeamMember,
  listTeamMembers,
  reorderTeamMembers,
  restoreTeamMember,
  retireTeamMember,
  selectTeam,
  teamForDocument,
  teamIdsInBlocks,
  updateTeamMember,
  type RenderedTeamMember,
} from '@/modules/studio/team'

/**
 * The people on the proposal (Phase 183, spec §15).
 *
 * The last of ADR 0173's eight measured gaps that is not §7's design engine.
 * §15's second bullet lists *"team bios"* between the service catalog and the
 * company's certifications, and the measurement held: `company_profiles.
 * credentials` covers licences, certifications, insurance and memberships, and
 * a bio had no column anywhere.
 *
 * ## What these tests are mostly about
 *
 * Three things, and the second is the one Phase 182 taught:
 *
 * **It is a table, not a `jsonb` array.** `credentials` is the adjacent shape
 * and the wrong one: a document has to *point at* one person, a reference into
 * a `jsonb` array has no key, and a headshot is a foreign key to `assets`. So
 * the constraints are asserted against the database rather than the service —
 * the tests that matter are the ones that would still pass with
 * `src/modules/studio/team.ts` deleted.
 *
 * **Retiring is not deleting, and a *sent* document proves it.** A proposal
 * that named somebody keeps naming them after they leave. That is the entire
 * reason this is a table with an `is_active` flag instead of a delete, and it
 * is asserted by rendering a block that names a retired person.
 *
 * **Every surface, because Phase 181 counted them.** A new block type reaches
 * eight places, seven of which handle an unknown type silently. The scan below
 * is the same one `a-table-that-is-not-a-price.test.ts` runs, and it is here
 * too because a phase that adds a block type is exactly when it fires.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

/** The driver puts the constraint name on `cause`, never in the message. */
async function constraintBrokenBy(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write
    return undefined
  } catch (error) {
    return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name
  }
}

function teamBlock(patch: Partial<Extract<Block, { type: 'team' }>> = {}): Block {
  return {
    ...SHOWN,
    id: 'team-1',
    type: 'team',
    title: 'Who you will be working with',
    memberIds: [],
    showPhotos: true,
    photoShape: 'square',
    showQualifications: true,
    layout: 'list',
    ...patch,
  }
}

async function aTeam(fixture: Fixture) {
  const dana = await addTeamMember(fixture.ctx, {
    name: 'Dana Whitlock',
    title: 'Principal',
    qualifications: 'PE, LEED AP',
    bio: 'Twenty years on civic work.\n\nLed the river crossing.',
  })
  const ravi = await addTeamMember(fixture.ctx, {
    name: 'Ravi Okonjo',
    title: 'Lead estimator',
    bio: 'Prices the work.',
  })
  return { dana: dana.id, ravi: ravi.id }
}

// ---------------------------------------------------------------------------

describe('the table the bio needed', () => {
  it('refuses a name of spaces in the database, not only in the function', async () => {
    const fixture = await createCompanyFixture()

    /*
      The CHECK, reached around the service. `addTeamMember` trims and refuses
      first so a person gets a sentence rather than a constraint name — but a
      refusal in a function is a refusal somebody can forget to call, and
      Phase 116's rule is that a constraint beats a check.
    */
    const constraint = await constraintBrokenBy(
      db.insert(teamMembers).values({ companyId: fixture.companyId, name: '   ' }),
    )

    expect(constraint).toBe('team_members_name_present_check')
  })

  it('refuses a headshot belonging to another company', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    const theirAsset = await uploadAsset(theirs.ctx, {
      filename: 'headshot.png',
      contentType: 'image/png',
      data: PNG,
      kind: 'image',
    })

    /*
      The composite tenant key (Phase 170/180). A plain `REFERENCES assets (id)`
      would have accepted this and put another company's photograph beside my
      principal's name — and `MATCH SIMPLE` means the two-column key is not
      checked at all when either column is null, which is why `company_id` is
      `NOT NULL` on this table.
    */
    const constraint = await constraintBrokenBy(
      db.insert(teamMembers).values({
        companyId: mine.companyId,
        name: 'Dana Whitlock',
        headshotAssetId: theirAsset.id,
      }),
    )

    expect(constraint).toBe('team_members_headshot_fkey')
  })

  it('keeps the person when the headshot is deleted', async () => {
    const fixture = await createCompanyFixture()

    const asset = await uploadAsset(fixture.ctx, {
      filename: 'headshot.png',
      contentType: 'image/png',
      data: PNG,
      kind: 'image',
    })

    const member = await addTeamMember(fixture.ctx, {
      name: 'Dana Whitlock',
      headshotAssetId: asset.id,
    })

    // `ON DELETE SET NULL (headshot_asset_id)` — the column-list form, which is
    // required because `company_id` is in the key and cannot be nulled with it.
    // Deleting a photograph must not delete the person.
    const { deleteAsset } = await import('@/modules/studio/assets')
    await deleteAsset(fixture.ctx, asset.id)

    const [row] = await db.select().from(teamMembers).where(eq(teamMembers.id, member.id))
    expect(row.name).toBe('Dana Whitlock')
    expect(row.headshotAssetId).toBeNull()
  })

  it('does not leak one company\'s directory into another\'s', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    await addTeamMember(mine.ctx, { name: 'Dana Whitlock' })
    await addTeamMember(theirs.ctx, { name: 'Somebody Else' })

    expect((await listTeamMembers(mine.ctx)).map((m) => m.name)).toEqual(['Dana Whitlock'])
    expect((await listTeamMembers(theirs.ctx)).map((m) => m.name)).toEqual(['Somebody Else'])
  })
})

describe('retired, not deleted', () => {
  it('takes somebody out of the directory and leaves the row', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    await retireTeamMember(fixture.ctx, dana)

    expect((await listTeamMembers(fixture.ctx)).map((m) => m.id)).toEqual([ravi])
    expect((await listTeamMembers(fixture.ctx, { includeRetired: true })).map((m) => m.id)).toEqual(
      [dana, ravi],
    )
  })

  it('still renders a retired person a sent document named', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    // The document as it was sent: two people, named by id.
    const blocks = [teamBlock({ memberIds: [dana, ravi] })]

    await retireTeamMember(fixture.ctx, dana)

    const pool = await teamForDocument(fixture.companyId, blocks)
    const shown = selectTeam(pool, [dana, ravi])

    /*
      The whole argument for a table. Deleting the row would have left this
      document either broken or quietly one name short — and what a client was
      shown last year must not change because somebody left this year.
    */
    expect(shown.map((member) => member.name)).toEqual(['Dana Whitlock', 'Ravi Okonjo'])
  })

  it('does not put a retired person back by default', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    // A *different* document, naming the retired principal.
    const blocks = [teamBlock({ id: 'a', memberIds: [dana] }), teamBlock({ id: 'b' })]
    await retireTeamMember(fixture.ctx, dana)

    const pool = await teamForDocument(fixture.companyId, blocks)

    // The pool carries her, because block `a` names her.
    expect(pool.map((m) => m.id).sort()).toEqual([dana, ravi].sort())

    /*
      And block `b`, which names nobody, must not show her. This is why
      `RenderedTeamMember` carries `isActive`: without it the pool and the
      default selection are the same list, and a document saying "our team"
      would silently include the person who left.
    */
    expect(selectTeam(pool, []).map((m) => m.id)).toEqual([ravi])
    expect(selectTeam(pool, [dana]).map((m) => m.id)).toEqual([dana])
  })

  it('refuses to retire somebody who already is, in a sentence', async () => {
    const fixture = await createCompanyFixture()
    const { dana } = await aTeam(fixture)

    await retireTeamMember(fixture.ctx, dana)

    await expect(retireTeamMember(fixture.ctx, dana)).rejects.toThrow(DomainError)
    await expect(retireTeamMember(fixture.ctx, dana)).rejects.toThrow(/already retired/)
  })

  it('restores', async () => {
    const fixture = await createCompanyFixture()
    const { dana } = await aTeam(fixture)

    await retireTeamMember(fixture.ctx, dana)
    await restoreTeamMember(fixture.ctx, dana)

    expect((await listTeamMembers(fixture.ctx)).map((m) => m.id)).toContain(dana)
  })
})

describe('the order somebody chose', () => {
  it('appends a new person rather than inserting them', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)
    const third = await addTeamMember(fixture.ctx, { name: 'Alice Ahmed' })

    /*
      Alphabetically Alice is first, and she is last. `sortOrder` defaults to
      the current count, because somebody decides the order and the default for
      a new person is "last" rather than "wherever the name happens to sort".
    */
    expect((await listTeamMembers(fixture.ctx)).map((m) => m.id)).toEqual([dana, ravi, third.id])
  })

  it('reorders the whole list in one call', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    await reorderTeamMembers(fixture.ctx, [ravi, dana])

    expect((await listTeamMembers(fixture.ctx)).map((m) => m.id)).toEqual([ravi, dana])
  })

  it('changes nothing when the order names somebody else\'s person', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await createCompanyFixture({ name: 'Theirs' })

    const { dana, ravi } = await aTeam(mine)
    const intruder = await addTeamMember(theirs.ctx, { name: 'Somebody Else' })

    await expect(
      reorderTeamMembers(mine.ctx, [ravi, dana, intruder.id]),
    ).rejects.toThrow(/not on this company's team/)

    // All or nothing: the first two were valid and must not have moved.
    expect((await listTeamMembers(mine.ctx)).map((m) => m.id)).toEqual([dana, ravi])
  })

  it('renders a named selection in the block\'s order, not the firm\'s', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    const pool = await teamForDocument(fixture.companyId, [teamBlock({ memberIds: [ravi, dana] })])

    /*
      The directory says Dana then Ravi. The block says Ravi then Dana, because
      an author listing two people has said who leads this pitch — and the
      firm's standing order is a different fact.
    */
    expect(selectTeam(pool, [ravi, dana]).map((m) => m.name)).toEqual([
      'Ravi Okonjo',
      'Dana Whitlock',
    ])
    expect(pool.map((m) => m.name)).toEqual(['Dana Whitlock', 'Ravi Okonjo'])
  })

  it('drops a member whose row is gone rather than shifting the rest', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    const pool: RenderedTeamMember[] = await teamForDocument(fixture.companyId, [])

    expect(
      selectTeam(pool, [dana, '00000000-0000-0000-0000-000000000000', ravi]).map((m) => m.name),
    ).toEqual(['Dana Whitlock', 'Ravi Okonjo'])
  })
})

describe('one read for the document', () => {
  it('collects the ids every team block names, deduplicated', () => {
    const blocks = [
      teamBlock({ id: 'a', memberIds: ['x', 'y'] }),
      teamBlock({ id: 'b', memberIds: ['y', 'z'] }),
      { id: 'h', type: 'heading', text: 'Hello', level: 2, align: 'left' } as Block,
    ]

    expect(teamIdsInBlocks(blocks).sort()).toEqual(['x', 'y', 'z'])
  })

  it('reads the active directory for a document with no team block', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    expect((await teamForDocument(fixture.companyId, [])).map((m) => m.id)).toEqual([dana, ravi])
  })

  it('serves two team blocks from one pool, differently', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    const blocks = [teamBlock({ id: 'a', memberIds: [dana] }), teamBlock({ id: 'b', memberIds: [ravi] })]
    const pool = await teamForDocument(fixture.companyId, blocks)

    /*
      The reason the pool and the selection are separate functions. One query
      per document, and each block picks out of it — a `teamForDocument(ids)`
      that returned one block's answer would have been served to both, which is
      how a document with two team sections shows the same two people twice.
    */
    expect(selectTeam(pool, [dana]).map((m) => m.name)).toEqual(['Dana Whitlock'])
    expect(selectTeam(pool, [ravi]).map((m) => m.name)).toEqual(['Ravi Okonjo'])
  })
})

describe('who may touch the directory', () => {
  it('needs company:manage to write and crm:view to read', async () => {
    const fixture = await createCompanyFixture()
    const { dana, ravi } = await aTeam(fixture)

    /*
      `sales`, not `readonly`. Phase 180 made this mistake with `readonly`,
      which holds neither permission and therefore proved nothing about the
      asymmetry — the same mistake Phase 167 made about `bookkeeper`.
    */
    const sales = await addUserWithRole(fixture, 'sales')

    // A bio is the company talking about itself, so anybody who can see a
    // client record can see who is on the team.
    expect((await listTeamMembers(sales)).map((m) => m.id)).toEqual([dana, ravi])

    // Writing it is `company:manage`, like the rest of the Design Center.
    await expect(addTeamMember(sales, { name: 'Nope' })).rejects.toThrow(PermissionError)
    await expect(retireTeamMember(sales, dana)).rejects.toThrow(PermissionError)
    await expect(reorderTeamMembers(sales, [dana])).rejects.toThrow(PermissionError)
  })
})

describe('the limits', () => {
  it('refuses the hundred-and-first with a refusal that names the remedy', async () => {
    const fixture = await createCompanyFixture()

    await db.insert(teamMembers).values(
      Array.from({ length: MAX_TEAM_MEMBERS }, (_, index) => ({
        companyId: fixture.companyId,
        name: `Person ${index}`,
        sortOrder: index,
      })),
    )

    // Phase 119: a refusal a person can act on. "Retire somebody" is the
    // remedy, and it is the operation this module actually offers.
    await expect(addTeamMember(fixture.ctx, { name: 'One Too Many' })).rejects.toThrow(/Retire/)
  })

  it('refuses a name of spaces with a sentence', async () => {
    const fixture = await createCompanyFixture()

    await expect(addTeamMember(fixture.ctx, { name: '   ' })).rejects.toThrow(/needs a name/)

    const { dana } = await aTeam(fixture)
    await expect(updateTeamMember(fixture.ctx, dana, { name: ' ' })).rejects.toThrow(/needs a name/)
  })

  it('leaves a field alone when it is not in the patch', async () => {
    const fixture = await createCompanyFixture()
    const { dana } = await aTeam(fixture)

    await updateTeamMember(fixture.ctx, dana, { title: 'Managing principal' })

    const [row] = await db.select().from(teamMembers).where(eq(teamMembers.id, dana))
    expect(row.title).toBe('Managing principal')
    // Not cleared by an update that did not mention it.
    expect(row.qualifications).toBe('PE, LEED AP')
    expect(row.bio).toMatch(/Twenty years/)
  })
})

describe('the eight surfaces', () => {
  /**
   * Phase 181's scan, run again by the phase that adds a block type.
   *
   * The register holds the **pattern**, never a list of types, so this catches
   * an eighteenth type without anybody adding it here. It is asserted in two
   * test files on purpose: this one fails when `team` is missed, and the other
   * fails when the next type is.
   */
  it('handles every block type, team included', () => {
    const gaps: string[] = []

    for (const surface of BLOCK_SURFACES) {
      const text = readFileSync(surface.file, 'utf8')
      for (const definition of BLOCK_DEFINITIONS) {
        if (!text.includes(coverageMarker(surface, definition.type))) {
          gaps.push(`${definition.type} is not handled at ${surface.key} (${surface.file})`)
        }
      }
    }

    expect(gaps).toEqual([])
  })

  it('offers the block in both kinds, which is why the email has to mean it', () => {
    const definition = BLOCK_DEFINITIONS.find((entry) => entry.type === 'team')

    // §15 ends "brand assets feed both the Proposal Designer and Marketing
    // Creative Studio". A palette entry that said `proposal` only would have
    // made the email surface unreachable and the coverage test a formality.
    expect(definition?.kinds).toEqual(expect.arrayContaining(['proposal', 'marketing']))
  })

  it('renders the people in the email HTML and its plain-text alternative', () => {
    const pool: RenderedTeamMember[] = [
      {
        id: 'a',
        name: 'Dana Whitlock',
        title: 'Principal',
        bio: 'Twenty years on civic work.',
        qualifications: 'PE, LEED AP',
        headshotAssetId: null,
        isActive: true,
      },
    ]

    const email = { unsubscribeUrl: 'https://x.test/u/tok', team: pool }

    const html = renderEmailHtml({ blocks: [teamBlock()], ...email })
    expect(html).toContain('Dana Whitlock')
    expect(html).toContain('PE, LEED AP')
    expect(html).toContain('Principal')
    expect(html).toContain('Twenty years on civic work.')

    const text = renderEmailText({ blocks: [teamBlock()], ...email })
    expect(text).toContain('Dana Whitlock, PE, LEED AP — Principal')
    expect(text).toContain('Twenty years on civic work.')
  })

  it('honours showQualifications on both email surfaces', () => {
    const pool: RenderedTeamMember[] = [
      {
        id: 'a',
        name: 'Dana Whitlock',
        title: null,
        bio: null,
        qualifications: 'PE, LEED AP',
        headshotAssetId: null,
        isActive: true,
      },
    ]

    const blocks = [teamBlock({ showQualifications: false })]
    const email = { unsubscribeUrl: 'https://x.test/u', team: pool }

    expect(renderEmailHtml({ blocks, ...email })).not.toContain('LEED')
    expect(renderEmailText({ blocks, ...email })).not.toContain('LEED')
  })

  it('renders nothing rather than an empty heading when nobody is selected', () => {
    const email = { unsubscribeUrl: 'https://x.test/u', team: [] }

    // A "Who you will be working with" section with no people under it reads
    // as a rendering fault, which is worse than the section being absent.
    expect(renderEmailHtml({ blocks: [teamBlock()], ...email })).not.toContain(
      'Who you will be working with',
    )
    expect(renderEmailText({ blocks: [teamBlock()], ...email })).not.toContain(
      'Who you will be working with',
    )
  })

  it('escapes a name, because a bio is author-entered text', () => {
    const pool: RenderedTeamMember[] = [
      {
        id: 'a',
        name: '<script>alert(1)</script>',
        title: null,
        bio: null,
        qualifications: null,
        headshotAssetId: null,
        isActive: true,
      },
    ]

    const html = renderEmailHtml({
      blocks: [teamBlock()],
      unsubscribeUrl: 'https://x.test/u',
      team: pool,
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('carries no merge fields of its own and reports none', () => {
    /*
      The two `merge-fields.ts` surfaces are both satisfied by a case that fills
      only `title`, and that is the honest answer: `memberIds` are ids, and a
      bio comes from `team_members` rather than from a merge context. Asserted
      so the no-op is a decision rather than an omission — `default:` would have
      left `{{client.name}}` in a block title, in front of the client.
    */
    const blocks = [teamBlock({ title: 'Your team at {{company.name}}' })]
    const context = { 'company.name': 'Bridgeworks' }

    const [resolved] = resolveBlocks(blocks, context) as Array<Extract<Block, { type: 'team' }>>
    expect(resolved.title).toBe('Your team at Bridgeworks')

    expect(unresolvedInBlocks(blocks, {})).toEqual(['company.name'])
  })
})

describe('the template whose description already promised this', () => {
  it('gives professional-engagement the team section it names', () => {
    const template = BUILT_IN_TEMPLATES.find((entry) => entry.key === 'professional-engagement')

    /*
      Its description reads "Approach, deliverables, team, fees, and terms" and
      it had no team section of any kind — ADR 0182's shape one level up: not a
      column with no reader but a sentence with nothing behind it.
    */
    expect(template?.description).toMatch(/team/)
    expect(template?.blocks.some((block) => block.type === 'team')).toBe(true)
  })

  it('names nobody in the template, because ids belong to one company', () => {
    const template = BUILT_IN_TEMPLATES.find((entry) => entry.key === 'professional-engagement')
    const block = template?.blocks.find((entry) => entry.type === 'team')

    // A template is shared across companies, so a hard-coded id would point at
    // another tenant's person — which the composite foreign key would refuse
    // and nothing would explain. The empty default is the only correct value.
    expect(block && 'memberIds' in block ? block.memberIds : null).toEqual([])
  })

  it('survives the round trip through parseBlocks', () => {
    const template = BUILT_IN_TEMPLATES.find((entry) => entry.key === 'professional-engagement')
    const parsed = parseBlocks(JSON.parse(JSON.stringify(template?.blocks ?? [])))

    expect(parsed.some((block) => block.type === 'team')).toBe(true)
  })
})
