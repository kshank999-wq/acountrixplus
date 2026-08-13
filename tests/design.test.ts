import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits, companyProfiles, designDocuments } from '@/db/schema'
import { addUserWithRole, createCompanyFixture } from './helpers'
import {
  BLOCK_DEFINITIONS,
  definitionsForKind,
  moveBlock,
  parseBlocks,
  validateBlocks,
  type Block,
} from '@/modules/design/blocks'
import {
  buildMergeContext,
  findUnresolvedFields,
  resolveBlock,
  resolveMergeFields,
  unresolvedInBlocks,
} from '@/modules/design/merge-fields'
import { BUILT_IN_TEMPLATES, templatesForIndustry } from '@/modules/design/templates'
import {
  applyTemplate,
  createDocumentForProposal,
  documentForProposal,
  listTemplates,
  proposalRenderContext,
  saveAsTemplate,
  saveDocument,
  withFreshIds,
} from '@/modules/design/documents'
import {
  createBrandKit,
  createClause,
  isHexColor,
  listClauses,
  reviseClause,
  saveProfile,
} from '@/modules/studio/service'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal } from '@/modules/crm/proposals'
import { PermissionError } from '@/modules/permissions'

/** The block model (spec §7). */
describe('blocks', () => {
  it('parses a valid block list', () => {
    const blocks = parseBlocks([
      { id: 'a', type: 'heading', text: 'Scope', level: 2, align: 'left' },
      { id: 'b', type: 'divider' },
    ])
    expect(blocks).toHaveLength(2)
  })

  it('drops malformed blocks on the read path rather than failing', () => {
    // A client-facing page missing one block beats one that will not render.
    const blocks = parseBlocks([
      { id: 'a', type: 'heading', text: 'Scope', level: 2, align: 'left' },
      { id: 'b', type: 'not-a-real-type' },
      { type: 'divider' },
    ])
    expect(blocks).toHaveLength(1)
  })

  it('reports errors on the save path instead of dropping work', () => {
    const result = validateBlocks([
      { id: 'a', type: 'heading', text: 'Scope', level: 2, align: 'left' },
      { id: 'b', type: 'nonsense' },
    ])
    expect(result.errors).toHaveLength(1)
  })

  it('applies defaults when creating a block', () => {
    const definition = BLOCK_DEFINITIONS.find((d) => d.type === 'pricingTable')!
    const block = definition.create('x') as Extract<Block, { type: 'pricingTable' }>

    expect(block.showTotals).toBe(true)
    expect(block.allowOptionalSelection).toBe(true)
  })

  it('offers proposal-only blocks to proposals only', () => {
    // The engine is shared with marketing (spec §8), so a flyer never gets a
    // fee table or a signature line.
    const marketing = definitionsForKind('marketing').map((d) => d.type)
    const proposal = definitionsForKind('proposal').map((d) => d.type)

    expect(proposal).toContain('pricingTable')
    expect(proposal).toContain('signature')
    expect(marketing).not.toContain('pricingTable')
    expect(marketing).not.toContain('signature')
    expect(marketing).toContain('text')
  })

  it('moves a block within the list', () => {
    const blocks = parseBlocks([
      { id: 'a', type: 'divider' },
      { id: 'b', type: 'divider' },
      { id: 'c', type: 'divider' },
    ])

    expect(moveBlock(blocks, 0, 2).map((b) => b.id)).toEqual(['b', 'c', 'a'])
    expect(moveBlock(blocks, 2, 0).map((b) => b.id)).toEqual(['c', 'a', 'b'])
    // Out-of-range targets clamp rather than losing the block.
    expect(moveBlock(blocks, 0, 99).map((b) => b.id)).toEqual(['b', 'c', 'a'])
    expect(moveBlock(blocks, 1, 1).map((b) => b.id)).toEqual(['a', 'b', 'c'])
  })

  it('gives copied blocks fresh ids', () => {
    const blocks = parseBlocks([{ id: 'a', type: 'divider' }])
    const copied = withFreshIds(blocks)

    expect(copied[0].id).not.toBe('a')
    expect(copied[0].type).toBe('divider')
  })
})

/** Merge fields (spec §7). */
describe('merge fields', () => {
  const context = { 'company.name': 'Ridgeline', 'client.name': 'Harborview' }

  it('substitutes known fields', () => {
    expect(resolveMergeFields('Prepared by {{company.name}}', context)).toBe(
      'Prepared by Ridgeline',
    )
  })

  it('tolerates whitespace inside the braces', () => {
    expect(resolveMergeFields('{{ company.name }}', context)).toBe('Ridgeline')
  })

  it('renders an unknown field as nothing, not as its own syntax', () => {
    // A client must never see `{{project.code}}` on a page.
    expect(resolveMergeFields('Job {{project.code}}.', context)).toBe('Job .')
  })

  it('reports unresolved fields separately so the author is warned', () => {
    expect(findUnresolvedFields('{{company.name}} and {{project.code}}', context)).toEqual([
      'project.code',
    ])
  })

  it('substitutes across every text field of a block', () => {
    const block = parseBlocks([
      {
        id: 'a',
        type: 'keyValue',
        title: 'For {{client.name}}',
        rows: [{ label: 'From', value: '{{company.name}}' }],
      },
    ])[0]

    const resolved = resolveBlock(block, context) as Extract<Block, { type: 'keyValue' }>
    expect(resolved.title).toBe('For Harborview')
    expect(resolved.rows[0].value).toBe('Ridgeline')
  })

  it('finds unresolved fields across a whole document', () => {
    const blocks = parseBlocks([
      { id: 'a', type: 'text', text: '{{company.name}}', align: 'left' },
      { id: 'b', type: 'text', text: '{{project.code}} {{proposal.total}}', align: 'left' },
    ])

    expect(unresolvedInBlocks(blocks, context)).toEqual(['project.code', 'proposal.total'])
  })

  it('formats money fields through the money helper', () => {
    const built = buildMergeContext({ proposal: { totalCents: 250_000 } })
    expect(built['proposal.total']).toBe('$2,500.00')
  })

  it('omits absent values rather than writing empty strings', () => {
    const built = buildMergeContext({ company: { name: 'Ridgeline' } })
    expect(built['company.name']).toBe('Ridgeline')
    expect(built['client.name']).toBeUndefined()
  })

  it('falls back to the company name when no legal name is set', () => {
    const built = buildMergeContext({ company: { name: 'Ridgeline', legalName: null } })
    expect(built['company.legalName']).toBe('Ridgeline')
  })
})

/** Templates (spec §7). */
describe('templates', () => {
  it('ships templates that every block parses cleanly', () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const result = validateBlocks(template.blocks)
      expect(result.errors, `${template.key}: ${result.errors.join(', ')}`).toHaveLength(0)
      expect(result.blocks.length).toBeGreaterThan(0)
    }
  })

  it('puts an industry-matching template first', () => {
    const ordered = templatesForIndustry('construction')
    expect(ordered[0].industry).toBe('construction')
  })

  it('ranks general templates above other industries', () => {
    const ordered = templatesForIndustry('retail')
    // No retail template exists, so a general one leads.
    expect(ordered[0].industry).toBeNull()
  })

  it('uses merge fields rather than placeholder prose', () => {
    const standard = BUILT_IN_TEMPLATES.find((t) => t.key === 'standard-services')!
    const text = JSON.stringify(standard.blocks)
    expect(text).toContain('{{client.name}}')
    expect(text).toContain('{{proposal.number}}')
  })
})

async function proposalFixture() {
  const fixture = await createCompanyFixture({ industry: 'construction' })
  const organization = await createOrganization(fixture.ctx, { name: 'Harborview Development' })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Foundation package',
    expectedValueCents: 2_500_000,
  })
  const revenue = await fixture.account('4000')

  const proposal = await createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Foundation proposal',
    items: [
      { description: 'Excavation', unitPriceCents: 1_800_000, chartAccountId: revenue.id },
      {
        description: 'Drainage',
        unitPriceCents: 400_000,
        isOptional: true,
        isSelected: false,
        chartAccountId: revenue.id,
      },
    ],
  })

  return { fixture, organization, opportunity, proposal }
}

/** Document lifecycle (spec §7). */
describe('proposal documents', () => {
  it('creates a document from a template on first access', async () => {
    const { fixture, proposal } = await proposalFixture()

    const document = await documentForProposal(fixture.ctx, proposal.id)
    expect(parseBlocks(document.blocks).length).toBeGreaterThan(0)
    expect(document.proposalId).toBe(proposal.id)
  })

  it('returns the same document on repeat access', async () => {
    const { fixture, proposal } = await proposalFixture()

    const first = await documentForProposal(fixture.ctx, proposal.id)
    const second = await documentForProposal(fixture.ctx, proposal.id)

    expect(second.id).toBe(first.id)
  })

  it('attaches the company default brand kit', async () => {
    const { fixture, proposal } = await proposalFixture()

    // Onboarding installs a default kit (spec §15).
    const [kit] = await db
      .select()
      .from(brandKits)
      .where(eq(brandKits.companyId, fixture.companyId))

    const document = await documentForProposal(fixture.ctx, proposal.id)
    expect(document.brandKitId).toBe(kit.id)
  })

  it('falls back to the standard template for an unknown key', async () => {
    const { fixture, proposal } = await proposalFixture()

    const document = await createDocumentForProposal(fixture.ctx, proposal.id, 'no-such-template')
    // An unknown key must not produce an empty proposal.
    expect(parseBlocks(document.blocks).length).toBeGreaterThan(0)
  })

  it('rejects a malformed block list on save', async () => {
    const { fixture, proposal } = await proposalFixture()
    const document = await documentForProposal(fixture.ctx, proposal.id)

    await expect(
      saveDocument(fixture.ctx, document.id, { blocks: [{ id: 'x', type: 'nonsense' }] }),
    ).rejects.toThrow(/could not save/i)
  })

  it('saves a valid block list', async () => {
    const { fixture, proposal } = await proposalFixture()
    const document = await documentForProposal(fixture.ctx, proposal.id)

    await saveDocument(fixture.ctx, document.id, {
      blocks: [{ id: 'a', type: 'heading', text: 'Scope', level: 2, align: 'left' }],
    })

    const [updated] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(parseBlocks(updated.blocks)).toHaveLength(1)
  })

  it('replaces content when a template is applied', async () => {
    const { fixture, proposal } = await proposalFixture()
    const document = await documentForProposal(fixture.ctx, proposal.id)

    await saveDocument(fixture.ctx, document.id, {
      blocks: [{ id: 'a', type: 'heading', text: 'Mine', level: 2, align: 'left' }],
    })
    await applyTemplate(fixture.ctx, document.id, 'simple-estimate')

    const [updated] = await db
      .select()
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    const blocks = parseBlocks(updated.blocks)
    expect(blocks.length).toBeGreaterThan(1)
    expect(JSON.stringify(blocks)).not.toContain('Mine')
  })

  it('saves a document as a reusable company template', async () => {
    const { fixture, proposal } = await proposalFixture()
    const document = await documentForProposal(fixture.ctx, proposal.id)

    await saveAsTemplate(fixture.ctx, document.id, { key: 'our-standard', name: 'Our standard' })

    const templates = await listTemplates(fixture.ctx)
    const saved = templates.find((template) => template.key === 'our-standard')

    expect(saved?.source).toBe('company')
    // A company's own templates lead the gallery.
    expect(templates[0].source).toBe('company')
  })

  it('builds a render context from the real records', async () => {
    const { fixture, proposal } = await proposalFixture()
    await saveProfile(fixture.ctx, {
      legalName: 'Ridgeline Construction LLC',
      email: 'hello@ridgeline.test',
    })

    const render = await proposalRenderContext(fixture.companyId, proposal.id)

    expect(render?.context['company.name']).toBe('Ridgeline Construction LLC')
    expect(render?.context['client.name']).toBe('Harborview Development')
    expect(render?.context['proposal.number']).toBe('PROP-1001')
    // Only the selected item counts toward the total.
    expect(render?.context['proposal.total']).toBe('$18,000.00')
    expect(render?.items).toHaveLength(2)
  })

  it('returns nothing for a proposal in another company', async () => {
    const { proposal } = await proposalFixture()
    const other = await createCompanyFixture({ name: 'Other' })

    expect(await proposalRenderContext(other.companyId, proposal.id)).toBeNull()
  })
})

/** Company Studio (spec §15). */
describe('company studio', () => {
  it('installs a profile and default brand kit during onboarding', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline' })

    const [profile] = await db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, fixture.companyId))
    const [kit] = await db
      .select()
      .from(brandKits)
      .where(eq(brandKits.companyId, fixture.companyId))

    expect(profile.legalName).toBe('Ridgeline')
    expect(kit.isDefault).toBe(true)
  })

  it('validates hex colours', () => {
    expect(isHexColor('#0d6e60')).toBe(true)
    expect(isHexColor('#abc')).toBe(true)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor('#0d6e6')).toBe(false)
  })

  it('refuses a colour that is not plain hex', async () => {
    const fixture = await createCompanyFixture()

    // Colours land in a style attribute on public pages.
    await expect(
      createBrandKit(fixture.ctx, {
        name: 'Injected',
        primaryColor: 'red; background: url(javascript:alert(1))',
      }),
    ).rejects.toThrow(/hex colour/i)
  })

  it('keeps only one default brand kit', async () => {
    const fixture = await createCompanyFixture()
    await createBrandKit(fixture.ctx, { name: 'Second', isDefault: true })

    const kits = await db
      .select()
      .from(brandKits)
      .where(eq(brandKits.companyId, fixture.companyId))

    expect(kits.filter((kit) => kit.isDefault)).toHaveLength(1)
  })

  it('requires company:manage to change the brand', async () => {
    const fixture = await createCompanyFixture()
    const sales = await addUserWithRole(fixture, 'sales')

    await expect(createBrandKit(sales, { name: 'Nope' })).rejects.toThrow(PermissionError)
  })

  it('versions a clause rather than overwriting it', async () => {
    const fixture = await createCompanyFixture()
    const { clause } = await createClause(fixture.ctx, {
      title: 'Payment terms',
      body: 'Net 30.',
      approve: true,
    })

    const revised = await reviseClause(fixture.ctx, clause.id, {
      body: 'Net 15.',
      approve: true,
    })

    expect(revised.versionNumber).toBe(2)

    const listed = await listClauses(fixture.ctx)
    // The library offers the current wording…
    expect(listed[0].body).toBe('Net 15.')
    // …but version 1 still exists for documents that referenced it.
    const { clauseVersion } = await import('@/modules/studio/service')
    expect(await clauseVersion(fixture.ctx, revised.id)).not.toBeNull()
  })

  it('scopes studio records to the acting company', async () => {
    const alpha = await createCompanyFixture({ name: 'Alpha' })
    const beta = await createCompanyFixture({ name: 'Beta' })

    await createClause(alpha.ctx, { title: 'Alpha terms', body: 'Alpha only.' })

    expect(await listClauses(alpha.ctx)).toHaveLength(1)
    expect(await listClauses(beta.ctx)).toHaveLength(0)
  })
})
