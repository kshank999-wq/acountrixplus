import type { Block } from './blocks'

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

/** Stable ids: a template's blocks are copied, then given fresh ids on use. */
function block<T extends Block>(value: T): T {
  return value
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
        text: 'Thank you for the opportunity to work with {{client.name}}. This proposal sets out what we recommend, what it will cost, and how we will get there.',
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
        text: 'Describe what is included, in the order the work will happen.',
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
        type: 'list',
        items: ['Permits and municipal fees', 'Work outside the scope described above'],
        ordered: false,
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
        text: '{{company.paymentInstructions}}',
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
        text: '{{company.paymentInstructions}}',
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
