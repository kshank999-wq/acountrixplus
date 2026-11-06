import { z } from 'zod'
import { blockSchema, type Block } from './blocks'

/**
 * The built-in template gallery (spec §7).
 *
 * Templates are written with merge fields rather than placeholder prose, so a
 * new company's first proposal already carries its own name, its client, and
 * the real figures — the point of §7's dynamic fields.
 *
 * `industry` matches the keys used by the chart-of-accounts packs, so the
 * gallery filters to what a business actually does.
 */

export type TemplateDefinition = {
  key: string
  name: string
  description: string
  kind: 'proposal' | 'marketing'
  /** Null means the template suits any industry. */
  industry: string | null
  blocks: Block[]
}

/**
 * Stable ids: a template's blocks are copied, then given fresh ids on use.
 *
 * Parsed rather than merely typed, since Phase 191. The schema fills the
 * defaults every block now carries — `hidden` and `locked` — so sixty template
 * literals did not each have to repeat two false values, and the parse is free
 * besides: a built-in template that stopped matching the schema now fails at
 * import rather than rendering short on a client's page.
 */
function block(value: z.input<typeof blockSchema>): Block {
  return blockSchema.parse(value)
}

const STANDARD_COVER: Block = block({
  id: 'cover',
  type: 'cover',
  title: '{{proposal.title}}',
  subtitle: 'Prepared by {{company.name}}',
  preparedFor: 'Prepared for {{client.name}}',
  showLogo: true,
  useBrandBackground: true,
})

const SIGNATURE: Block = block({
  id: 'signature',
  type: 'signature',
  prompt: 'Accept this proposal',
  agreementText:
    'By signing below I accept this proposal, its scope, and its terms on behalf of {{client.name}}.',
})

export const BUILT_IN_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'standard-services',
    name: 'Standard services proposal',
    description: 'Summary, scope, fees, terms, and acceptance. Works for most businesses.',
    kind: 'proposal',
    industry: null,
    blocks: [
      STANDARD_COVER,
      block({
        id: 'summary-heading',
        type: 'heading',
        text: 'Executive summary',
        level: 2,
        align: 'left',
      }),
      block({
        id: 'summary',
        type: 'text',
        /*
          The proposal's own executive summary (Phase 182), not a sentence about
          proposals in general. This block held generic prose while
          `proposals.executive_summary` held what the author — or the AI draft —
          had actually written, and nothing rendered the column.

          An author who has not filled the form now sees an empty section in the
          designer preview, which looks worse and is better: the placeholder made
          the block look finished and sent the client a paragraph about
          proposals.
        */
        text: '{{proposal.executiveSummary}}',
        align: 'left',
        emphasis: true,
      }),
      block({
        id: 'details',
        type: 'keyValue',
        title: 'At a glance',
        rows: [
          { label: 'Prepared for', value: '{{client.name}}' },
          { label: 'Proposal', value: '{{proposal.number}}' },
          { label: 'Date', value: '{{proposal.date}}' },
          { label: 'Valid through', value: '{{proposal.expiresOn}}' },
        ],
      }),
      block({ id: 'scope-heading', type: 'heading', text: 'Scope of work', level: 2, align: 'left' }),
      block({
        id: 'scope',
        type: 'text',
        // The instruction this replaced — "describe what is included, in the
        // order the work will happen" — was addressed to the author and sent to
        // the client if they skipped it.
        text: '{{proposal.scope}}',
        align: 'left',
        emphasis: false,
      }),
      block({
        id: 'deliverables-heading',
        type: 'heading',
        text: 'Deliverables',
        level: 3,
        align: 'left',
      }),
      block({
        id: 'deliverables',
        type: 'text',
        text: '{{proposal.deliverables}}',
        align: 'left',
        emphasis: false,
      }),
      block({
        id: 'exclusions-heading',
        type: 'heading',
        text: 'What is not included',
        level: 3,
        align: 'left',
      }),
      block({
        id: 'exclusions',
        // `text` and not `list`: a merge field in a list item is one bullet
        // holding every exclusion, where a text block renders the author's
        // blank lines as paragraphs.
        type: 'text',
        text: '{{proposal.exclusions}}',
        align: 'left',
        emphasis: false,
      }),
      block({
        id: 'assumptions-heading',
        type: 'heading',
        text: 'Assumptions',
        level: 3,
        align: 'left',
      }),
      block({
        id: 'assumptions',
        type: 'text',
        text: '{{proposal.assumptions}}',
        align: 'left',
        emphasis: false,
      }),
      block({ id: 'pagebreak', type: 'pageBreak' }),
      block({
        id: 'pricing',
        type: 'pricingTable',
        title: 'Investment',
        showQuantity: true,
        showUnitPrice: true,
        allowOptionalSelection: true,
        showTotals: true,
      }),
      block({ id: 'terms-heading', type: 'heading', text: 'Terms', level: 2, align: 'left' }),
      block({
        id: 'terms',
        type: 'text',
        /*
          This proposal's terms, then the company's standing payment
          instructions. Both templates held only the second, which made §7's
          `terms` component a column nothing read — and meant two proposals with
          different terms rendered the same page.
        */
        text: '{{proposal.terms}}\n\n{{company.paymentInstructions}}',
        align: 'left',
        emphasis: false,
      }),
      SIGNATURE,
    ],
  },

  {
    key: 'construction-bid',
    name: 'Construction bid',
    description: 'Scope by phase, exclusions, allowances, schedule, and a fee table.',
    kind: 'proposal',
    industry: 'construction',
    blocks: [
      STANDARD_COVER,
      block({
        id: 'intro',
        type: 'text',
        text: '{{company.name}} is pleased to submit this bid to {{client.name}} for the work described below.',
        align: 'left',
        emphasis: true,
      }),
      block({
        id: 'details',
        type: 'keyValue',
        title: 'Project',
        rows: [
          { label: 'Client', value: '{{client.name}}' },
          { label: 'Bid number', value: '{{proposal.number}}' },
          { label: 'Bid date', value: '{{proposal.date}}' },
          { label: 'Bid valid through', value: '{{proposal.expiresOn}}' },
        ],
      }),
      block({ id: 'scope-heading', type: 'heading', text: 'Scope by phase', level: 2, align: 'left' }),
      block({
        id: 'phases',
        type: 'columns',
        columns: [
          { heading: 'Site and excavation', body: 'Clearing, excavation, and grading.' },
          { heading: 'Foundation', body: 'Footings, foundation walls, and waterproofing.' },
          { heading: 'Framing', body: 'Structural framing to lock-up.' },
        ],
      }),
      block({
        id: 'exclusions-heading',
        type: 'heading',
        text: 'Exclusions',
        level: 3,
        align: 'left',
      }),
      block({
        id: 'exclusions',
        type: 'list',
        items: [
          'Permits, plan review, and municipal fees',
          'Utility connections and impact fees',
          'Rock excavation or unsuitable soils',
          'Finish carpentry, paint, and flooring',
        ],
        ordered: false,
      }),
      block({
        id: 'assumptions-heading',
        type: 'heading',
        text: 'Assumptions',
        level: 3,
        align: 'left',
      }),
      block({
        id: 'assumptions',
        type: 'list',
        items: [
          'Site is accessible to standard equipment.',
          'Work proceeds in a continuous sequence without owner-caused delay.',
        ],
        ordered: false,
      }),
      block({ id: 'pagebreak', type: 'pageBreak' }),
      block({
        id: 'pricing',
        type: 'pricingTable',
        title: 'Bid amount',
        showQuantity: true,
        showUnitPrice: true,
        allowOptionalSelection: true,
        showTotals: true,
      }),
      block({
        id: 'schedule',
        type: 'keyValue',
        title: 'Schedule and payment',
        rows: [
          { label: 'Deposit', value: '25% on acceptance' },
          { label: 'Progress billing', value: 'Monthly, on work in place' },
          { label: 'Retainage', value: '10% until substantial completion' },
        ],
      }),
      SIGNATURE,
    ],
  },

  {
    key: 'professional-engagement',
    name: 'Professional services engagement',
    description: 'Approach, deliverables, team, fees, and terms — for advisory work.',
    kind: 'proposal',
    industry: 'professional_services',
    blocks: [
      STANDARD_COVER,
      block({
        id: 'understanding-heading',
        type: 'heading',
        text: 'Our understanding',
        level: 2,
        align: 'left',
      }),
      block({
        id: 'understanding',
        type: 'text',
        text: 'Set out what the client told you, in their words. Showing you listened is what wins the engagement.',
        align: 'left',
        emphasis: true,
      }),
      block({
        id: 'approach',
        type: 'columns',
        columns: [
          { heading: 'Discover', body: 'Review current state and agree the objective.' },
          { heading: 'Deliver', body: 'Do the work, with checkpoints along the way.' },
          { heading: 'Embed', body: 'Hand over so the result sticks.' },
        ],
      }),
      block({
        id: 'deliverables-heading',
        type: 'heading',
        text: 'Deliverables',
        level: 2,
        align: 'left',
      }),
      block({
        id: 'deliverables',
        type: 'list',
        items: ['A written findings report', 'A working session with your team'],
        ordered: false,
      }),
      block({
        /*
          The one template whose own description already promised this
          (Phase 183).

          It reads *"Approach, deliverables, team, fees, and terms"* and had no
          team section of any kind — the §7 shape ADR 0182 found, one level up:
          not a column with no reader but a **sentence** with nothing behind it.
          Advisory work is bought on who will do it, so this is the template the
          §15 block belongs in.

          `memberIds: []` on purpose. A template cannot name people, because the
          ids belong to one company and a template is shared across all of them
          — so the empty default (every active member, in the firm's own order)
          is both the only correct value and the useful one. An author narrows it
          in the designer.
        */
        id: 'team',
        type: 'team',
        title: 'Who you will be working with',
        memberIds: [],
        showPhotos: true,
        photoShape: 'square',
        showQualifications: true,
        layout: 'list',
      }),
      block({
        id: 'pricing',
        type: 'pricingTable',
        title: 'Fees',
        showQuantity: true,
        showUnitPrice: true,
        allowOptionalSelection: true,
        showTotals: true,
      }),
      block({
        id: 'terms',
        type: 'text',
        /*
          This proposal's terms, then the company's standing payment
          instructions. Both templates held only the second, which made §7's
          `terms` component a column nothing read — and meant two proposals with
          different terms rendered the same page.
        */
        text: '{{proposal.terms}}\n\n{{company.paymentInstructions}}',
        align: 'left',
        emphasis: false,
      }),
      SIGNATURE,
    ],
  },

  {
    key: 'simple-estimate',
    name: 'Simple estimate',
    description: 'One page: what it is, what it costs, and where to sign.',
    kind: 'proposal',
    industry: null,
    blocks: [
      block({
        id: 'heading',
        type: 'heading',
        text: '{{proposal.title}}',
        level: 1,
        align: 'left',
      }),
      block({
        id: 'details',
        type: 'keyValue',
        title: '',
        rows: [
          { label: 'For', value: '{{client.name}}' },
          { label: 'From', value: '{{company.name}}' },
          { label: 'Estimate', value: '{{proposal.number}}' },
          { label: 'Date', value: '{{proposal.date}}' },
        ],
      }),
      block({
        id: 'pricing',
        type: 'pricingTable',
        title: 'Estimate',
        showQuantity: true,
        showUnitPrice: true,
        allowOptionalSelection: true,
        showTotals: true,
      }),
      SIGNATURE,
    ],
  },
]

/** Templates offered to a company, most specific to its industry first. */
export function templatesForIndustry(industry: string | null): TemplateDefinition[] {
  return [...BUILT_IN_TEMPLATES]
    .filter((template) => template.kind === 'proposal')
    .sort((a, b) => {
      const aMatch = a.industry === industry ? 0 : 1
      const bMatch = b.industry === industry ? 0 : 1
      if (aMatch !== bMatch) return aMatch - bMatch
      // An industry-specific template a company cannot use ranks last.
      const aGeneral = a.industry === null ? 0 : 1
      const bGeneral = b.industry === null ? 0 : 1
      return aGeneral - bGeneral
    })
}

export function builtInTemplate(key: string): TemplateDefinition | undefined {
  return BUILT_IN_TEMPLATES.find((template) => template.key === key)
}
