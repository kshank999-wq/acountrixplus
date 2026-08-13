import { z } from 'zod'

/**
 * The block model (spec §7).
 *
 * Spec §7 sets the scope explicitly: "The first release should prioritize
 * business-document layout features; advanced Illustrator-class path editing
 * can be phased in after the core proposal workflow is stable."
 *
 * So a document is an ordered list of blocks that flow down a page, not a free
 * canvas of absolutely-positioned vectors. That choice is what makes the same
 * document render correctly on a phone, in a print-ready PDF, and inside a
 * marketing email — which spec §8 requires, since this engine serves marketing
 * too. ADR 0004 records the reasoning and what it costs.
 *
 * Nothing here knows what a proposal is. `pricingTable` and `signature` bind
 * to data the *renderer* supplies, so a marketing flyer simply never uses them.
 */

const baseBlock = { id: z.string().min(1) }

/** Horizontal placement, shared by several block types. */
const alignment = z.enum(['left', 'center', 'right']).default('left')

export const coverBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('cover'),
  title: z.string().default(''),
  subtitle: z.string().default(''),
  /** Shown under the title — usually a merge field for the client. */
  preparedFor: z.string().default(''),
  showLogo: z.boolean().default(true),
  /** Fills the block with the brand colour rather than the page background. */
  useBrandBackground: z.boolean().default(true),
})

export const headingBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('heading'),
  text: z.string().default(''),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  align: alignment,
})

export const textBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('text'),
  text: z.string().default(''),
  align: alignment,
  /** Slightly larger, for an executive summary or a lead paragraph. */
  emphasis: z.boolean().default(false),
})

export const listBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('list'),
  items: z.array(z.string()).default([]),
  ordered: z.boolean().default(false),
})

export const keyValueBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('keyValue'),
  title: z.string().default(''),
  rows: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .default([]),
})

/**
 * The fee table (spec §7).
 *
 * Deliberately holds no prices of its own — it renders whatever line items the
 * caller supplies, so the figures on the page can never drift from the
 * proposal's actual totals.
 */
export const pricingTableBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('pricingTable'),
  title: z.string().default('Investment'),
  showQuantity: z.boolean().default(true),
  showUnitPrice: z.boolean().default(true),
  /** Lets the client choose optional items on the client-facing page. */
  allowOptionalSelection: z.boolean().default(true),
  showTotals: z.boolean().default(true),
})

export const imageBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('image'),
  assetId: z.string().nullable().default(null),
  caption: z.string().default(''),
  /** Percentage of the content width. */
  widthPercent: z.number().int().min(10).max(100).default(100),
  align: alignment,
})

export const dividerBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('divider'),
})

export const spacerBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('spacer'),
  heightPt: z.number().int().min(4).max(216).default(24),
})

export const columnsBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('columns'),
  /** Each column is a short text run; nesting is deliberately not allowed. */
  columns: z.array(z.object({ heading: z.string(), body: z.string() })).min(2).max(3),
})

/**
 * Approved legal language pulled from the clause library (spec §7, §15).
 *
 * Stores the *version* id, not the clause id: what a client was shown must not
 * change when the company later revises its standard terms.
 */
export const clauseBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('clause'),
  clauseVersionId: z.string().nullable().default(null),
  /** Snapshotted at insert, so the block renders even if lookup fails. */
  title: z.string().default(''),
  body: z.string().default(''),
})

/** The acceptance block (spec §7 signature/acceptance). */
export const signatureBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('signature'),
  prompt: z.string().default('Accept this proposal'),
  /** Wording the client agrees to when they sign. */
  agreementText: z
    .string()
    .default('By signing below I accept this proposal and its terms.'),
})

export const pageBreakBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('pageBreak'),
})

export const blockSchema = z.discriminatedUnion('type', [
  coverBlockSchema,
  headingBlockSchema,
  textBlockSchema,
  listBlockSchema,
  keyValueBlockSchema,
  pricingTableBlockSchema,
  imageBlockSchema,
  dividerBlockSchema,
  spacerBlockSchema,
  columnsBlockSchema,
  clauseBlockSchema,
  signatureBlockSchema,
  pageBreakBlockSchema,
])

export type Block = z.infer<typeof blockSchema>
export type BlockType = Block['type']

/**
 * Parses a stored block list, dropping anything malformed.
 *
 * A document that fails to render is worse than one missing a block: these are
 * client-facing pages, and a single bad block written by an older version of
 * the editor should not take the whole proposal down.
 */
export function parseBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return []

  const blocks: Block[] = []
  for (const candidate of raw) {
    const parsed = blockSchema.safeParse(candidate)
    if (parsed.success) blocks.push(parsed.data)
  }
  return blocks
}

/** Validates a block list strictly, for the editor's save path. */
export function validateBlocks(raw: unknown): { blocks: Block[]; errors: string[] } {
  if (!Array.isArray(raw)) return { blocks: [], errors: ['Blocks must be a list.'] }

  const blocks: Block[] = []
  const errors: string[] = []

  raw.forEach((candidate, index) => {
    const parsed = blockSchema.safeParse(candidate)
    if (parsed.success) {
      blocks.push(parsed.data)
    } else {
      errors.push(`Block ${index + 1}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
    }
  })

  return { blocks, errors }
}

export type BlockDefinition = {
  type: BlockType
  label: string
  description: string
  /** Only offered on documents of these kinds. */
  kinds: Array<'proposal' | 'marketing'>
  create: (id: string) => Block
}

/**
 * What the editor offers when adding a block.
 *
 * `kinds` is how the shared engine stays shared: a pricing table and a
 * signature belong to proposals, everything else works anywhere, and Phase 5
 * marketing gets the same palette minus the two.
 */
export const BLOCK_DEFINITIONS: BlockDefinition[] = [
  {
    type: 'cover',
    label: 'Cover',
    description: 'Title page with your logo and the client name.',
    kinds: ['proposal', 'marketing'],
    create: (id) => coverBlockSchema.parse({ id, type: 'cover' }),
  },
  {
    type: 'heading',
    label: 'Heading',
    description: 'Section title.',
    kinds: ['proposal', 'marketing'],
    create: (id) => headingBlockSchema.parse({ id, type: 'heading', text: 'Section title' }),
  },
  {
    type: 'text',
    label: 'Text',
    description: 'A paragraph or several.',
    kinds: ['proposal', 'marketing'],
    create: (id) => textBlockSchema.parse({ id, type: 'text' }),
  },
  {
    type: 'list',
    label: 'List',
    description: 'Bulleted or numbered points.',
    kinds: ['proposal', 'marketing'],
    create: (id) => listBlockSchema.parse({ id, type: 'list', items: ['First point'] }),
  },
  {
    type: 'keyValue',
    label: 'Details table',
    description: 'Label and value rows — project details, schedule, terms at a glance.',
    kinds: ['proposal', 'marketing'],
    create: (id) =>
      keyValueBlockSchema.parse({
        id,
        type: 'keyValue',
        title: 'Project details',
        rows: [{ label: 'Prepared for', value: '{{client.name}}' }],
      }),
  },
  {
    type: 'pricingTable',
    label: 'Fee table',
    description: 'The proposal line items and totals. Always matches the real figures.',
    kinds: ['proposal'],
    create: (id) => pricingTableBlockSchema.parse({ id, type: 'pricingTable' }),
  },
  {
    type: 'image',
    label: 'Image',
    description: 'A photo or diagram from your asset library.',
    kinds: ['proposal', 'marketing'],
    create: (id) => imageBlockSchema.parse({ id, type: 'image' }),
  },
  {
    type: 'columns',
    label: 'Columns',
    description: 'Two or three side-by-side blurbs.',
    kinds: ['proposal', 'marketing'],
    create: (id) =>
      columnsBlockSchema.parse({
        id,
        type: 'columns',
        columns: [
          { heading: 'Approach', body: '' },
          { heading: 'Timeline', body: '' },
        ],
      }),
  },
  {
    type: 'clause',
    label: 'Legal clause',
    description: 'Approved wording from your clause library, locked to a version.',
    kinds: ['proposal'],
    create: (id) => clauseBlockSchema.parse({ id, type: 'clause' }),
  },
  {
    type: 'signature',
    label: 'Acceptance',
    description: 'Where the client signs. Only one per proposal is used.',
    kinds: ['proposal'],
    create: (id) => signatureBlockSchema.parse({ id, type: 'signature' }),
  },
  {
    type: 'divider',
    label: 'Divider',
    description: 'A horizontal rule.',
    kinds: ['proposal', 'marketing'],
    create: (id) => dividerBlockSchema.parse({ id, type: 'divider' }),
  },
  {
    type: 'spacer',
    label: 'Spacer',
    description: 'Vertical breathing room.',
    kinds: ['proposal', 'marketing'],
    create: (id) => spacerBlockSchema.parse({ id, type: 'spacer' }),
  },
  {
    type: 'pageBreak',
    label: 'Page break',
    description: 'Start the next section on a fresh printed page.',
    kinds: ['proposal', 'marketing'],
    create: (id) => pageBreakBlockSchema.parse({ id, type: 'pageBreak' }),
  },
]

export function blockDefinition(type: BlockType): BlockDefinition | undefined {
  return BLOCK_DEFINITIONS.find((definition) => definition.type === type)
}

/** Block types offered for a document kind. */
export function definitionsForKind(kind: 'proposal' | 'marketing'): BlockDefinition[] {
  return BLOCK_DEFINITIONS.filter((definition) => definition.kinds.includes(kind))
}

/** Moves a block within the list, returning a new array. */
export function moveBlock(blocks: Block[], from: number, to: number): Block[] {
  if (from === to || from < 0 || from >= blocks.length) return blocks

  const clamped = Math.max(0, Math.min(blocks.length - 1, to))
  const next = [...blocks]
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved)
  return next
}
