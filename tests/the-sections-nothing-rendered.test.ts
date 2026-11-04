import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { proposalVersions, proposals } from '@/db/schema'
import { createCompanyFixture, type Fixture } from './helpers'
import { RegistryError } from '@/modules/errors/registry'
import {
  PROPOSAL_COMPONENTS,
  narrativeComponents,
  proposalComponentFor,
  proposalComponentStands,
} from '@/modules/crm/proposal-components'
import { KNOWN_MERGE_FIELDS, buildMergeContext, resolveBlocks } from '@/modules/design/merge-fields'
import { BUILT_IN_TEMPLATES } from '@/modules/design/templates'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, sendProposal } from '@/modules/crm/proposals'
import { proposalRenderContext } from '@/modules/design/documents'
import { parseBlocks } from '@/modules/design/blocks'

/**
 * The sections nothing rendered (Phase 182, spec §7).
 *
 * §7 names twelve proposal components. ADR 0173 measured ten of them as having
 * a dedicated block or column, with `deliverables` and `assumptions` having
 * neither — and that measurement was correct and generous, because *"has a
 * column"* and *"reaches the client"* are different claims and the audit
 * checked the first.
 *
 * `proposals` carried `executive_summary`, `scope`, `exclusions` and `terms`.
 * All four were written by `createProposal`, written by the AI draft since Phase
 * 6, and snapshotted into `proposal_versions` so a sent proposal's wording
 * freezes with its figures. **None of the four reached any document**: no
 * renderer read them, and the `Proposal` merge-field group held only number,
 * title, total, subtotal, date and expiry.
 *
 * The templates made it look handled — a `heading` and a `text` block with the
 * ids `scope` and `exclusions`, filled with prose telling the author to describe
 * their scope. So the author typed it into the form, opened the designer, found
 * a block asking for it, and typed it again. The column kept the first copy and
 * the client read the second.
 *
 * Phase 49's rule at scale: a column with no reader is a field that does not
 * exist. Four of them, in the section of the specification with the most
 * components — so the fix was not two more columns of the same kind.
 */

async function aProposal(fixture: Fixture, sections: Record<string, string> = {}) {
  const organization = await createOrganization(fixture.ctx, { name: 'Harborview Marine' })
  const opportunity = await createOpportunity(fixture.ctx, {
    organizationId: organization.id,
    title: 'Refit, spring',
  })
  const revenue = await fixture.account('4000')

  return createProposal(fixture.ctx, {
    opportunityId: opportunity.id,
    title: 'Spring refit',
    items: [{ description: 'Hull coating', unitPriceCents: 400_000, chartAccountId: revenue.id }],
    ...sections,
  })
}

// ---------------------------------------------------------------------------

describe('§7’s twelve, as a register', () => {
  it('argues every component by why its content lives where it does', () => {
    /**
     * Phase 101's device, with the floor set on that question for a reason:
     * four of these had a column and no reader for the life of the project, and
     * *"it has a column"* was exactly what made that look finished.
     */
    expect(PROPOSAL_COMPONENTS.flatMap((c) => proposalComponentStands(c))).toEqual([])
  })

  it('declares twelve, in §7’s own words and §7’s own order', () => {
    /**
     * Measured, not bounded (Phase 126) — and matched against the bullet rather
     * than against a reading of it, because the audit's "10 of 12" was a count
     * nobody could check without re-reading the specification.
     */
    expect(PROPOSAL_COMPONENTS).toHaveLength(12)
    expect(PROPOSAL_COMPONENTS.map((c) => c.key)).toEqual([
      'cover',
      'executive summary',
      'scope',
      'deliverables',
      'schedule',
      'exclusions',
      'assumptions',
      'fee table',
      'optional items',
      'terms',
      'legal clauses',
      'signature/acceptance',
    ])
  })

  it('matches the specification bullet word for word', () => {
    /**
     * The register's keys are §7's words, so the mapping can be checked against
     * the document rather than against my reading of it. If somebody rewords
     * the bullet, this fails and names the difference.
     */
    const spec = readFileSync('docs/SPEC.md', 'utf8')
    const bullet = spec
      .slice(spec.indexOf('- Proposal components:'))
      .split('\n- ')[0]
      .replace('- Proposal components:', '')
      .replace(/\s+/g, ' ')

    for (const component of PROPOSAL_COMPONENTS) {
      expect(bullet, component.key).toContain(component.key)
    }
    // Twelve commas' worth of components and nothing else in the bullet.
    expect(bullet.split(',').map((part) => part.trim().replace(/\.$/, ''))).toHaveLength(12)
  })

  it('throws on a component nobody declared', () => {
    expect(() => proposalComponentFor('appendix')).toThrow(RegistryError)
    try {
      proposalComponentFor('appendix')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('PROPOSAL_COMPONENTS')
      expect((error as RegistryError).message).toContain('executive summary')
    }
  })

  it('names a merge field for every component stored in a column', () => {
    /**
     * **The check that would have caught the four orphans.** A narrative column
     * reaches the page through a merge field and through nothing else, so an
     * entry claiming a column with no field named is a column nobody can
     * render.
     *
     * `proposalComponentStands` enforces it per entry; this asserts the whole
     * set, and that each named field is one the resolver actually knows.
     */
    const narrative = narrativeComponents()

    expect(narrative.map((c) => c.key)).toEqual([
      'executive summary',
      'scope',
      'deliverables',
      'exclusions',
      'assumptions',
      'terms',
    ])

    for (const component of narrative) {
      expect(component.storedIn, component.key).toMatch(/^proposals\./)
      expect(KNOWN_MERGE_FIELDS, component.key).toContain(component.mergeField)
    }
  })

  it('refuses an entry that claims a column and names no field', () => {
    // Phase 121: a rule only ever seen to agree is not a rule. So here is the
    // state the four orphans were in, refused.
    const orphan = { ...proposalComponentFor('scope'), mergeField: null }

    expect(proposalComponentStands(orphan)).toEqual([
      expect.stringContaining('names no merge field'),
    ])
  })

  it('refuses an entry with two ways onto the page', () => {
    const doubled = { ...proposalComponentFor('fee table'), mergeField: 'proposal.total' }

    expect(proposalComponentStands(doubled)).toEqual([
      expect.stringContaining('two mechanisms for one component'),
    ])
  })
})

describe('the six narrative sections', () => {
  it('resolves all six into a document', () => {
    const context = buildMergeContext({
      proposal: {
        executiveSummary: 'A full repaint and anode replacement.',
        scope: 'Haul out, strip, coat, antifoul.',
        deliverables: 'A coated hull and a written condition report.',
        exclusions: 'Engine work. Shaft alignment.',
        assumptions: 'The vessel is out of the water by 1 April.',
        terms: '40% on acceptance, balance on completion.',
      },
    })

    const [block] = resolveBlocks(
      [
        {
          id: 'x',
          type: 'text',
          align: 'left',
          emphasis: false,
          text: '{{proposal.scope}} | {{proposal.deliverables}} | {{proposal.assumptions}}',
        },
      ],
      context,
    )
    if (block.type !== 'text') expect.unreachable()

    expect(block.text).toBe(
      'Haul out, strip, coat, antifoul. | A coated hull and a written condition report. | ' +
        'The vessel is out of the water by 1 April.',
    )
  })

  it('distinguishes a blank section from a field that does not exist', () => {
    /**
     * `buildMergeContext`'s `set` skips an empty value, which is what lets
     * `findUnresolvedFields` tell *"no such field"* from *"the author left this
     * blank"*. Both render as nothing and only the first is worth warning
     * about — which is how a template can carry all six sections without
     * nagging about the ones a particular proposal does not use.
     */
    const context = buildMergeContext({ proposal: { scope: 'Something' } })

    expect(context['proposal.scope']).toBe('Something')
    expect(context['proposal.assumptions']).toBeUndefined()
    // And the key exists in the register either way, so it is offered in the
    // insert menu whether or not this proposal filled it.
    expect(KNOWN_MERGE_FIELDS).toContain('proposal.assumptions')
  })

  it('is offered in its own group in the insert menu', async () => {
    /**
     * Their own group rather than six more entries under "Proposal", because the
     * insert menu is the one place an author discovers these exist, and six
     * paragraphs listed among six figures reads as six more figures.
     */
    const { MERGE_FIELD_GROUPS } = await import('@/modules/design/merge-fields')
    const group = MERGE_FIELD_GROUPS.find((entry) => entry.group === 'Proposal sections')

    expect(group).toBeDefined()
    expect(group!.fields.map((field) => field.key)).toEqual([
      'proposal.executiveSummary',
      'proposal.scope',
      'proposal.deliverables',
      'proposal.exclusions',
      'proposal.assumptions',
      'proposal.terms',
    ])
  })
})

describe('what the templates used to tell the author', () => {
  it('puts the proposal’s own sections on the page instead of placeholders', () => {
    /**
     * The defect, asserted where it lived. The standard template placed a block
     * reading *"Describe what is included, in the order the work will happen"* —
     * an instruction addressed to the author and sent to the client if they
     * skipped it — while `proposals.scope` held what they had already written.
     */
    const standard = BUILT_IN_TEMPLATES.find((t) => t.key === 'standard-services')!
    const blocks = parseBlocks(standard.blocks)
    const text = blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')

    expect(text).toContain('{{proposal.executiveSummary}}')
    expect(text).toContain('{{proposal.scope}}')
    expect(text).toContain('{{proposal.deliverables}}')
    expect(text).toContain('{{proposal.exclusions}}')
    expect(text).toContain('{{proposal.assumptions}}')
    expect(text).toContain('{{proposal.terms}}')

    // The instruction to the author is gone.
    expect(text).not.toContain('Describe what is included')
    // And so is the paragraph about proposals in general.
    expect(text).not.toContain('This proposal sets out what we recommend')
  })

  it('gives the two new sections a heading of their own', () => {
    // A merge field with no heading is a paragraph the client cannot place.
    const standard = BUILT_IN_TEMPLATES.find((t) => t.key === 'standard-services')!
    const headings = parseBlocks(standard.blocks).flatMap((block) =>
      block.type === 'heading' ? [block.text] : [],
    )

    expect(headings).toContain('Deliverables')
    expect(headings).toContain('Assumptions')
  })

  it('no longer renders every proposal’s terms identically', () => {
    /**
     * Both templates carried `{{company.paymentInstructions}}` under a "Terms"
     * heading and nothing else, which is the orphaning of `proposals.terms`
     * stated as a consequence: two proposals with different terms rendered the
     * same page.
     */
    for (const template of BUILT_IN_TEMPLATES) {
      const terms = parseBlocks(template.blocks).find((block) => block.id === 'terms')
      if (!terms || terms.type !== 'text') continue

      expect(terms.text, template.key).toContain('{{proposal.terms}}')
      // The company's standing instructions still follow it — both are wanted,
      // and only one of them is this proposal's.
      expect(terms.text, template.key).toContain('{{company.paymentInstructions}}')
    }
  })
})

describe('end to end', () => {
  it('carries all six from the form to the rendered context', async () => {
    /**
     * The whole path, and the part that was two lines long: the entire
     * `proposals` row was already selected in `proposalRenderContext` and four
     * of its columns were never passed to `buildMergeContext`. Not a missing
     * query — a missing pair of lines.
     */
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, {
      executiveSummary: 'A full repaint.',
      scope: 'Haul out, strip, coat.',
      deliverables: 'A coated hull and a report.',
      exclusions: 'Engine work.',
      assumptions: 'Out of the water by 1 April.',
      terms: '40% on acceptance.',
    })

    const rendered = await proposalRenderContext(fixture.companyId, proposal.id)
    expect(rendered).not.toBeNull()

    expect(rendered!.context['proposal.executiveSummary']).toBe('A full repaint.')
    expect(rendered!.context['proposal.scope']).toBe('Haul out, strip, coat.')
    expect(rendered!.context['proposal.deliverables']).toBe('A coated hull and a report.')
    expect(rendered!.context['proposal.exclusions']).toBe('Engine work.')
    expect(rendered!.context['proposal.assumptions']).toBe('Out of the water by 1 April.')
    expect(rendered!.context['proposal.terms']).toBe('40% on acceptance.')
  })

  it('stores the two new sections where the other four live', async () => {
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, {
      deliverables: 'A coated hull.',
      assumptions: 'Out by April.',
    })

    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposal.id))

    expect(row.deliverables).toBe('A coated hull.')
    expect(row.assumptions).toBe('Out by April.')
    // Nullable with no default, like the four before them — a section nobody
    // wrote is absent rather than an empty string somebody has to tell apart.
    expect(row.scope).toBeNull()
  })

  it('freezes all six in the version, not four of them', async () => {
    /**
     * A version exists so a sent proposal's wording cannot change under the
     * client. Two sections left out of the snapshot would be two sections that
     * could — and the snapshot already carried the other four, so the omission
     * would have been invisible until somebody compared a version against a
     * proposal that had been edited.
     */
    const fixture = await createCompanyFixture()
    const proposal = await aProposal(fixture, {
      scope: 'Original scope.',
      deliverables: 'Original deliverables.',
      assumptions: 'Original assumptions.',
    })

    await sendProposal(fixture.ctx, proposal.id)

    const [version] = await db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposal.id))

    const snapshot = version.snapshot as Record<string, unknown>
    expect(snapshot.scope).toBe('Original scope.')
    expect(snapshot.deliverables).toBe('Original deliverables.')
    expect(snapshot.assumptions).toBe('Original assumptions.')

    // Every narrative section the register declares is in the snapshot, so
    // adding a seventh cannot quietly miss it.
    for (const component of narrativeComponents()) {
      const key = component.storedIn.replace('proposals.', '')
      const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
      expect(snapshot, component.key).toHaveProperty(camel)
    }
  })
})
