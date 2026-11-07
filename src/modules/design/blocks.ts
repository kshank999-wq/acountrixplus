import { z } from 'zod'
import { SHAPE_KINDS, SHAPE_PAINTS } from './shapes'

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

/**
 * What every block carries, whatever type it is (Phase 191, §7's `lock/hide`).
 *
 * `hidden` and `locked` are on the base rather than on the types that seemed
 * to want them, because both are properties of *a block in a document* rather
 * than of a kind of content: there is no type for which "keep this but do not
 * show it" is meaningless, and a flag that existed on some types would be a
 * flag an author has to remember the rules of.
 *
 * Both default to false, so every block stored before this phase parses
 * unchanged and is visible and editable — the same bargain Phase 186's `crop`
 * struck, and the reason `parseBlocks` can stay forgiving.
 */
const baseBlock = {
  id: z.string().min(1),
  /**
   * Kept in the document and shown to **no reader**.
   *
   * Not a draft and not a deletion. The case it is for is a section an author
   * has written and is not ready to send — an optional scope, a price
   * breakdown held back for the second meeting — which today is either
   * deleted and retyped or sent by accident.
   *
   * Who honours this is not left to each renderer to remember: see
   * `forReader`.
   */
  hidden: z.boolean().default(false),
  /**
   * Protected from accidental change, including by the Design Assistant.
   *
   * A courtesy against a slip, **not a permission** — anybody who can edit the
   * document can unlock it, and nothing here is a security boundary. Said
   * plainly because a lock that looked like a permission would be worse than
   * no lock: somebody would rely on it.
   *
   * It is enforced on the save path rather than only greyed out in the editor,
   * because a toggle that only the editor respects is Phase 160's shape —
   * installed and inert — and because the Design Assistant rewrites block
   * lists without going through the editor at all.
   */
  locked: z.boolean().default(false),
}

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

/**
 * A plain table (spec §7, Phase 181).
 *
 * §7 names *"tables, pricing tables"* as two things. `pricingTable` renders the
 * proposal's own line items and holds no figures of its own, which is right for
 * a fee table and useless for everything else — a specification table, a
 * schedule with three columns, a comparison, a list of materials with
 * quantities. ADR 0173 measured the absence; until now such a table was built
 * from `keyValue` rows, which are two columns with no header and no way to add
 * a third.
 *
 * ## Rectangular, enforced
 *
 * Every row must have as many cells as the header. A ragged table is not a
 * rendering edge case, it is four different wrong answers: HTML drops the
 * missing cells, the PDF computes column widths from a row that is not
 * representative, the email's table-based layout silently misaligns, and the
 * plain-text alternative loses the column boundary entirely. Refusing it in the
 * schema is one answer instead.
 *
 * ## Why the column cap is six
 *
 * Not taste — the PDF. §7 asks for *"print-quality output"*, and the content
 * width of a letter page at the body size this engine uses fits six columns of
 * readable text. A seventh does not become ugly, it becomes unreadable, and a
 * block that renders acceptably on a screen and illegibly in the document the
 * client downloads is the kind of half-working this engine's single-model
 * design exists to avoid.
 */
/**
 * How many columns a table may have, and why it is six.
 *
 * Not taste — the PDF. §7 asks for *"print-quality output"*, and the content
 * width of a letter page at the body size this engine uses fits six columns of
 * readable text. A seventh does not become ugly, it becomes unreadable, and a
 * block that renders acceptably on a screen and illegibly in the document the
 * client downloads is the half-working this engine's single-model design exists
 * to avoid.
 */
export const MAX_TABLE_COLUMNS = 6

export const tableBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('table'),
  title: z.string().default(''),
  /**
   * Header cells. Empty means no header row — a table used for layout does not
   * need one, and a header of empty strings is not the same thing.
   */
  header: z.array(z.string()).max(MAX_TABLE_COLUMNS).default([]),
  rows: z.array(z.array(z.string()).max(MAX_TABLE_COLUMNS)).max(200).default([]),
  /**
   * Per-column alignment, so a quantity or a figure can sit right.
   *
   * Shorter than the row is allowed and means "left from here on", because a
   * three-column table where only the last is right-aligned should not have to
   * say `['left', 'left', 'right']`.
   */
  columnAlign: z.array(z.enum(['left', 'center', 'right'])).max(MAX_TABLE_COLUMNS).default([]),
  /** `grid` rules every cell, `rows` only between rows, `plain` neither. */
  style: z.enum(['grid', 'rows', 'plain']).default('rows'),
})


export type TableBlock = Extract<Block, { type: 'table' }>

/**
 * A table's column count, and every row padded to it.
 *
 * Called by **every** renderer, and that is the point. A ragged table is not a
 * rendering edge case, it is four different wrong answers: HTML drops the
 * missing cells, the PDF computes column widths from a row that is not
 * representative, the email's table layout silently misaligns, and the
 * plain-text alternative loses the column boundary.
 *
 * `validateBlocks` refuses to *save* a ragged table, so the editor cannot
 * produce one. This exists for the other direction — a document stored by an
 * older editor, or hand-edited, still renders, because `parseBlocks` is
 * deliberately lenient: *"a document that fails to render is worse than one
 * missing a block."* Lenient and **consistent** is the pair that needs a
 * function; lenient alone is how the four wrong answers happen.
 */
export function normalizeTable(block: TableBlock): {
  width: number
  header: string[]
  rows: string[][]
  align: Array<'left' | 'center' | 'right'>
} {
  const width = Math.min(
    block.header.length > 0 ? block.header.length : (block.rows[0]?.length ?? 0),
    MAX_TABLE_COLUMNS,
  )

  const pad = (cells: string[]) =>
    Array.from({ length: width }, (_, index) => cells[index] ?? '')

  return {
    width,
    header: block.header.length > 0 ? pad(block.header) : [],
    rows: block.rows.map(pad),
    // Left from here on, so a caller never indexes past the end.
    align: Array.from({ length: width }, (_, index) => block.columnAlign[index] ?? 'left'),
  }
}

/**
 * What is wrong with a table, in sentences for the editor's save path.
 *
 * Separate from the schema because a discriminated union cannot hold a
 * `superRefine` — Zod turns one into a `ZodEffects`, which is not a `ZodObject`,
 * and the union degrades to `any` without saying so. The first draft of this
 * phase did exactly that and the typecheck caught it in seven places.
 */
/**
 * A crop clamped to the picture it is a crop of.
 *
 * The same device as `normalizeTable`: three renderers reading the raw numbers
 * is how one document becomes three documents, so each one asks this instead.
 *
 * A crop whose right edge runs past the source is **pulled back rather than
 * shrunk**, because an author dragging a box off the edge means "as far right
 * as it goes" and not "make it narrower". Shrinking would change the shape of
 * the box under their hand, which is the one thing a crop control must not do.
 */
export function normalizeCrop(crop: Crop): Crop {
  const width = Math.min(Math.max(crop.width, 0.05), 1)
  const height = Math.min(Math.max(crop.height, 0.05), 1)

  return {
    width,
    height,
    x: Math.min(Math.max(crop.x, 0), 1 - width),
    y: Math.min(Math.max(crop.y, 0), 1 - height),
  }
}

/** Whether a crop shows the whole picture, so renderers can skip the work. */
export function isWholeImage(crop: Crop): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1
}

/**
 * What is wrong with an image block, in sentences.
 *
 * Here rather than as a `.superRefine` on the schema, and the reason is Phase
 * 181's: a refinement inside a `discriminatedUnion` produces a `ZodEffects`,
 * which is not a `ZodObject`, and the union silently degrades to `any` —
 * surfacing as implicit-any errors in two unrelated files rather than as the
 * mistake it is.
 */
export function imageProblems(block: Extract<Block, { type: 'image' }>): string[] {
  const problems: string[] = []
  const { crop } = block

  if (crop.x + crop.width > 1 || crop.y + crop.height > 1) {
    problems.push(
      'The crop runs off the edge of the picture. It is read back clamped, so the document ' +
        'renders — but the box an author sees and the box a client sees would be different, ' +
        'which is the one thing a crop must not be.',
    )
  }

  return problems
}

export function tableProblems(block: TableBlock): string[] {
  const problems: string[] = []
  const width = block.header.length > 0 ? block.header.length : (block.rows[0]?.length ?? 0)

  if (width === 0 && block.rows.length > 0) {
    problems.push('A table with rows needs at least one column.')
    return problems
  }

  for (const [index, row] of block.rows.entries()) {
    if (row.length !== width) {
      problems.push(
        `Row ${index + 1} has ${row.length} cells and the table has ${width} columns. Every row ` +
          'must be the same width — a ragged table renders four different wrong ways across the ' +
          'page, the PDF, the email and the plain-text alternative.',
      )
    }
  }

  return problems
}

/**
 * The firm's people on a document (spec §15, Phase 183).
 *
 * §15 ends *"brand assets feed both the Proposal Designer and Marketing
 * Creative Studio"*, and a team bio is the asset most obviously meant: a
 * capability statement is largely who you are, and a proposal for professional
 * services names the two people who will do the work.
 *
 * ## It holds ids, not bios
 *
 * The same decision `pricingTable` makes and for the same reason — its comment
 * says *"the figures on the page can never drift from the proposal's actual
 * totals."* A bio copied into the block is a second copy of a paragraph that
 * will be edited once, and the stale one is the one the client reads.
 *
 * So the block names members and `RenderData` supplies them, which also means a
 * member retired after a proposal was sent still renders on it: the block kept
 * the id and `team_members` kept the row.
 *
 * ## Why `memberIds` and not "all of them"
 *
 * A firm of twelve puts three on a proposal. An empty list means *the active
 * members in their sort order* — the useful default for a capability statement —
 * and a non-empty one is a deliberate selection, in the order the author put
 * them rather than the firm's standing order, because who leads a pitch is not
 * who leads the firm.
 */
export const teamBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('team'),
  title: z.string().default('Who you will be working with'),
  /** Empty means every active member, in the firm's own order. */
  memberIds: z.array(z.string()).max(24).default([]),
  showPhotos: z.boolean().default(true),
  /**
   * The outline a headshot is seen through (Phase 186).
   *
   * The same two shapes as an `image` block's mask, minus `none`: a headshot is
   * cropped to a square either way, because a directory of mixed portrait and
   * landscape faces reads as a mistake. So the choice here is the **outline**,
   * which is the half of §7's `crop/mask` that a capability statement actually
   * varies — a circular headshot is a style decision firms have opinions about.
   */
  photoShape: z.enum(['square', 'rounded', 'circle']).default('square'),
  showQualifications: z.boolean().default(true),
  /** `list` is one per row with the photo beside; `grid` is cards. */
  layout: z.enum(['list', 'grid']).default('list'),
})

/**
 * Which part of a picture is shown, in fractions of the source (spec §7,
 * Phase 186).
 *
 * **Fractions and not pixels.** An asset can be replaced by a larger scan of
 * the same photograph, and a crop stored in pixels would then show a corner of
 * it. Fractions survive that, and they are also the only form that means
 * anything before the renderer knows how big the source is.
 *
 * The default is the whole picture, so a block written before this phase reads
 * back uncropped rather than reading back as nothing.
 */
export const cropSchema = z.object({
  x: z.number().min(0).max(1).default(0),
  y: z.number().min(0).max(1).default(0),
  /** A floor rather than zero: a crop of nothing is a block that vanished. */
  width: z.number().min(0.05).max(1).default(1),
  height: z.number().min(0.05).max(1).default(1),
})

export type Crop = z.infer<typeof cropSchema>

export const WHOLE_IMAGE: Crop = { x: 0, y: 0, width: 1, height: 1 }

/**
 * The shape a picture is seen through (spec §7's `crop/mask`).
 *
 * Three, and the list is short on purpose. §7 pairs *crop* with *mask* in one
 * bullet and the two are different operations: a crop chooses pixels, a mask
 * chooses an outline. An arbitrary mask is a path, which is the vector work §7
 * defers; a circle and a rounded rectangle are what a capability statement and
 * a product sheet actually ask for, and both are four Bézier curves in a PDF
 * and one CSS property on the page.
 */
export const MASK_SHAPES = ['none', 'rounded', 'circle'] as const

/**
 * The corner radius of a `rounded` mask, as a fraction of the shorter side.
 *
 * One constant, read by the CSS the page emits and by the Bézier path the PDF
 * writes — because a corner that is rounder on screen than on paper is two
 * documents, which is the mistake `normalizeTable` exists to prevent one level
 * down.
 */
export const ROUNDED_MASK_FRACTION = 0.08
export type MaskShape = (typeof MASK_SHAPES)[number]

export const imageBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('image'),
  assetId: z.string().nullable().default(null),
  caption: z.string().default(''),
  /** Percentage of the content width. */
  widthPercent: z.number().int().min(10).max(100).default(100),
  align: alignment,
  crop: cropSchema.default(WHOLE_IMAGE),
  maskShape: z.enum(MASK_SHAPES).default('none'),
})

/**
 * A drawn primitive — §7's *vector primitives*, in this engine's idiom
 * (Phase 193).
 *
 * Parameters rather than markup. The author chooses which primitive, which
 * brand role paints it, how tall it is and how wide; `design/shapes.ts` turns
 * that into the SVG both renderers already draw. So there is no new trust
 * boundary and no second renderer — which is what makes this small enough to
 * be worth doing in a block stack at all.
 *
 * **Colour is a brand role, not a hex.** No block in this engine has ever
 * carried a colour, and ADR 0004's fifth decision is why: brand values are
 * custom properties so one document renders under a different kit without
 * touching its content. A hex here would be content that outlives the kit.
 */
export const shapeBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('shape'),
  shape: z.enum(SHAPE_KINDS).default('rectangle'),
  fill: z.enum(SHAPE_PAINTS).default('primary'),
  stroke: z.enum(SHAPE_PAINTS).default('none'),
  strokeWidthPt: z.number().min(0).max(24).default(1),
  cornerRadiusPt: z.number().min(0).max(200).default(0),
  /** How much vertical space it takes, in points. */
  heightPt: z.number().int().min(2).max(600).default(48),
  /** Percentage of the content width, as `image` and `table` measure it. */
  widthPercent: z.number().int().min(5).max(100).default(100),
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

/**
 * Marketing collateral blocks (spec §8).
 *
 * Added in Phase 5. They are new entries in the same union — the engine, the
 * renderer's dispatch, the merge-field resolver, and the storage model all
 * stayed as they were, which is the test ADR 0004 set for itself.
 */

/** A call to action (spec §8 buttons/links). */
export const buttonBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('button'),
  label: z.string().default('Get in touch'),
  url: z.string().default(''),
  style: z.enum(['solid', 'outline']).default('solid'),
  align: alignment,
})

/**
 * A QR code (spec §8).
 *
 * Rendered as SVG so it stays sharp in print, which is the whole point of a QR
 * code on a one-sheet or capability statement.
 */
export const qrCodeBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('qrCode'),
  value: z.string().default(''),
  caption: z.string().default(''),
  sizePt: z.number().int().min(48).max(288).default(120),
  align: alignment,
})

/**
 * Linked video for digital collateral (spec §8).
 *
 * Rendered as a thumbnail that links out rather than an embedded player:
 * a document that has to survive print and email cannot rely on an iframe, and
 * a silently blank rectangle is worse than a picture with a play affordance.
 */
export const videoBlockSchema = z.object({
  ...baseBlock,
  type: z.literal('video'),
  url: z.string().default(''),
  thumbnailAssetId: z.string().nullable().default(null),
  caption: z.string().default(''),
  widthPercent: z.number().int().min(20).max(100).default(100),
})

export const blockSchema = z.discriminatedUnion('type', [
  coverBlockSchema,
  headingBlockSchema,
  textBlockSchema,
  listBlockSchema,
  keyValueBlockSchema,
  tableBlockSchema,
  teamBlockSchema,
  pricingTableBlockSchema,
  imageBlockSchema,
  shapeBlockSchema,
  dividerBlockSchema,
  spacerBlockSchema,
  columnsBlockSchema,
  clauseBlockSchema,
  signatureBlockSchema,
  pageBreakBlockSchema,
  buttonBlockSchema,
  qrCodeBlockSchema,
  videoBlockSchema,
])

/**
 * Visible and unlocked: the state of a block nobody has marked (Phase 191).
 *
 * For block lists built in **code** rather than by an author — an invoice's
 * generated layout, a test's fixture. Spread rather than defaulted away,
 * because `Block` is the parsed type and the parsed type has both fields: a
 * constructed literal that omitted them would be a `Block` with two holes in
 * it, and the compiler is right to say so.
 */
export const SHOWN = { hidden: false, locked: false } as const

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

/**
 * The blocks a reader may see (Phase 191, §7's `lock/hide`).
 *
 * ## Why this is a function and not a filter written five times
 *
 * `parseBlocks` is the single door every block list in this application comes
 * through — twenty-odd call sites, every surface among them. It would be the
 * obvious place to drop a hidden block, and it is the wrong one, because it
 * serves **both** audiences: the designer parses to show the author their
 * document, and the client page parses to show a client theirs. A filter there
 * would hide the block from the person who hid it.
 *
 * So the audiences have to be told apart somewhere, and the danger is that
 * "somewhere" becomes "wherever each renderer remembered". `BLOCK_SURFACES`
 * exists because six of eight dispatches handle an unknown block silently; a
 * renderer that forgot this would fail the same way, except that the block it
 * shows is one an author deliberately held back — which is worse than a
 * missing block, because nobody is looking for it.
 *
 * One function, named at every reader surface, and `READER_SURFACES` counts
 * them.
 */
export function visibleBlocks(blocks: Block[]): Block[] {
  return blocks.filter((block) => !block.hidden)
}

/**
 * What a locked block forbids, given what it looked like before.
 *
 * Returns the problems, so the save path can report all of them at once rather
 * than the first.
 *
 * **Content, existence and position** — the three things the word means
 * everywhere else, so all three are here. Content-and-existence alone was the
 * first version and it was wrong in a way worth recording: the Design
 * Assistant *only ever reorders*, never rewrites, so a lock that permitted
 * reordering would have been inert against the one caller it most exists to
 * stop. A toggle that does nothing to the thing it was built for is Phase
 * 160's shape.
 *
 * Position is compared **among the blocks common to both lists**, which is
 * what makes the rule usable. Inserting a new section above a locked clause is
 * ordinary editing and is allowed, because a new block is in neither list's
 * common part. Deleting an unlocked block elsewhere is likewise fine.
 *
 * The consequence worth stating: dragging *another* block past a locked one is
 * refused too. That is deliberate rather than a side effect — "this clause
 * stays after the scope" is exactly what somebody locking a clause means, and
 * a rule that let a neighbour hop over it would protect the block and not the
 * arrangement.
 *
 * Unlocking is always allowed, and is the one change a locked block accepts.
 * A lock nobody can undo is not a lock, it is damage.
 */
export function lockProblems(before: Block[], after: Block[]): string[] {
  const problems: string[] = []
  const now = new Map(after.map((block) => [block.id, block]))
  const survived = new Set(after.map((block) => block.id))

  const commonBefore = before.filter((block) => survived.has(block.id)).map((block) => block.id)
  const commonAfter = after
    .filter((block) => before.some((earlier) => earlier.id === block.id))
    .map((block) => block.id)

  for (const locked of before.filter((block) => block.locked)) {
    const next = now.get(locked.id)

    if (!next) {
      problems.push(`"${describeBlock(locked)}" is locked and cannot be deleted. Unlock it first.`)
      continue
    }

    if (commonBefore.indexOf(locked.id) !== commonAfter.indexOf(locked.id)) {
      problems.push(`"${describeBlock(locked)}" is locked and cannot be moved. Unlock it first.`)
      continue
    }

    /*
      Compared whole rather than field by field, because a block gains fields
      and a comparison that listed them would be a comparison that fell behind
      — the exact shape of Phase 182's columns nothing rendered. `locked` is
      excluded because clearing it is the permitted change; `hidden` is not,
      because hiding a locked block changes what a client sees.
    */
    const stripLock = ({ locked: _locked, ...rest }: Block) => rest
    if (JSON.stringify(stripLock(locked)) !== JSON.stringify(stripLock(next))) {
      problems.push(`"${describeBlock(locked)}" is locked and cannot be changed. Unlock it first.`)
    }
  }

  return problems
}

/** A short name for a block in a message to a person. */
function describeBlock(block: Block): string {
  const definition = BLOCK_DEFINITIONS.find((item) => item.type === block.type)
  const label = definition?.label ?? block.type

  if ('title' in block && block.title) return `${label}: ${block.title}`
  if ('text' in block && block.text) return `${label}: ${block.text.slice(0, 40)}`
  return label
}

/** Validates a block list strictly, for the editor's save path. */
export function validateBlocks(raw: unknown): { blocks: Block[]; errors: string[] } {
  if (!Array.isArray(raw)) return { blocks: [], errors: ['Blocks must be a list.'] }

  const blocks: Block[] = []
  const errors: string[] = []

  raw.forEach((candidate, index) => {
    const parsed = blockSchema.safeParse(candidate)
    if (parsed.success) {
      /*
        The rectangularity rule lives here and not in the schema, because the
        schema is shared with `parseBlocks` — which is lenient on purpose, and
        must stay so: a table stored ragged by an older editor should render
        padded rather than disappear from a client-facing page.

        Strict on save, lenient on render, consistent in both. The consistency
        is `normalizeTable`.
      */
      if (parsed.data.type === 'table') {
        for (const problem of tableProblems(parsed.data)) {
          errors.push(`Block ${index + 1}: ${problem}`)
        }
      }

      // Same bargain for a crop (Phase 186): refused on save, clamped on
      // render by `normalizeCrop`, so an older document still shows a picture.
      if (parsed.data.type === 'image') {
        for (const problem of imageProblems(parsed.data)) {
          errors.push(`Block ${index + 1}: ${problem}`)
        }
      }
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
    type: 'table',
    label: 'Table',
    description:
      'Rows and columns with an optional header — a specification, a schedule, a comparison.',
    kinds: ['proposal', 'marketing'],
    create: (id) =>
      tableBlockSchema.parse({
        id,
        type: 'table',
        header: ['Item', 'Detail'],
        rows: [
          ['', ''],
          ['', ''],
        ],
      }),
  },
  {
    type: 'team',
    label: 'Team',
    description: 'Bios for the people on this job. Edited once, in the Design Center.',
    kinds: ['proposal', 'marketing'],
    create: (id) => teamBlockSchema.parse({ id, type: 'team' }),
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
    type: 'button',
    label: 'Button',
    description: 'A call to action. Becomes a plain link in print.',
    kinds: ['marketing'],
    create: (id) => buttonBlockSchema.parse({ id, type: 'button' }),
  },
  {
    type: 'qrCode',
    label: 'QR code',
    description: 'Scannable link, drawn as vector so it stays sharp in print.',
    kinds: ['marketing'],
    create: (id) => qrCodeBlockSchema.parse({ id, type: 'qrCode' }),
  },
  {
    type: 'video',
    label: 'Video',
    description: 'A thumbnail that links to the video. Works in print and email.',
    kinds: ['marketing'],
    create: (id) => videoBlockSchema.parse({ id, type: 'video' }),
  },
  {
    type: 'shape',
    label: 'Shape',
    description:
      'A rectangle, ellipse or line in your brand colours — a panel behind a figure, a heavier ' +
      'rule, a marker beside a step.',
    kinds: ['proposal', 'marketing'],
    create: (id) => shapeBlockSchema.parse({ id, type: 'shape' }),
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
