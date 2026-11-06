/**
 * Every place a block type has to reach, and what a gap costs (Phase 181).
 *
 * ## What writing the table block found
 *
 * `blocks.ts` says the engine's claim plainly, about Phase 5's three marketing
 * blocks: *"They are new entries in the same union — the engine, the renderer's
 * dispatch, the merge-field resolver, and the storage model all stayed as they
 * were, which is the test ADR 0004 set for itself."*
 *
 * That passed, and it passed for a reason nobody checked: **six of the seven
 * dispatch sites have a `default:` clause**, so a new block type compiles and
 * is silently handled as nothing. `render-email` returns `''`,
 * `document-render` returns `null`, the plain-text alternative `break`s. The
 * PDF has no default and would not help either, because its `add(block): void`
 * returns nothing and TypeScript does not demand exhaustiveness of a switch
 * whose value is unused.
 *
 * And `block-editor.tsx` is not a switch at all — a chain of `&&`, whose own
 * docstring claims *"one case per block type"*. It had thirteen of sixteen.
 *
 * So since Phase 5, a marketing document could contain a **call-to-action
 * button that rendered on the page, in the email and in the PDF with its
 * default label and an empty url, and nothing anywhere could set it.** Same for
 * a QR code's value and a video's link — §8's "buttons/links, QR codes,
 * embedded/linked video" existed on every surface except the one where somebody
 * configures them.
 *
 * It was not a compile error, not a test failure, and not visible in a
 * screenshot, because the three blocks render perfectly well — with nothing in
 * them. That is Phase 160's shape exactly: a capability installed and inert.
 *
 * ## So the coverage is counted
 *
 * This register names the surfaces and how to recognise a type being handled at
 * each, and `tests/a-table-that-is-not-a-price.test.ts` asserts every type
 * reaches every surface. Adding a seventeenth block type now fails a test
 * naming the file instead of quietly rendering as nothing.
 *
 * It holds the **pattern**, never a list of types — so a new type is caught by
 * the scan rather than by somebody remembering to add it here too. Same device
 * as `PINNED_CLAIMS` from Phase 179, and for the same reason.
 */

import { RegistryError } from '@/modules/errors/registry'

export type BlockSurface = {
  key: string
  /** Repository-relative path. */
  file: string
  /**
   * How a handled type appears in that file, with `TYPE` standing in for the
   * block type's name.
   *
   * A pattern rather than a parser: these are seven hand-written dispatches in
   * five different styles, and a scan that tried to understand them would be a
   * scan with its own bugs.
   */
  pattern: string
  /** What a reader loses when a type is missing here. */
  because: string
  /**
   * Whether a missing case is **silent**.
   *
   * The field that matters. A surface that throws or fails to compile needs no
   * register; this register exists for the six that do not.
   */
  silent: boolean
}

export const BLOCK_SURFACES: readonly BlockSurface[] = [
  {
    key: 'palette',
    file: 'src/modules/design/blocks.ts',
    pattern: "type: 'TYPE',",
    because:
      'A `BLOCK_DEFINITIONS` entry is the only way to add a block from the designer, so a type ' +
      'missing here cannot be created at all. The one surface where a gap is **not** silent — the ' +
      'block simply never appears in the palette, which somebody notices the first time they look ' +
      'for it. Listed anyway, because a register of surfaces that skipped the obvious one would ' +
      'leave a reader wondering whether it had been considered.',
    silent: false,
  },
  {
    key: 'editor',
    file: 'src/components/design/block-editor.tsx',
    pattern: "block.type === 'TYPE'",
    because:
      'Where a block\'s fields are set. A gap here is the worst of the seven and the one this ' +
      'phase found: the block renders everywhere, perfectly, containing its defaults — a button ' +
      'labelled "Get in touch" with an empty url. Nothing errors, nothing looks broken, and the ' +
      'capability is inert. Three of the sixteen types were in this state from Phase 5 to Phase ' +
      '181.',
    silent: true,
  },
  {
    key: 'web',
    file: 'src/components/design/document-render.tsx',
    pattern: "case 'TYPE'",
    because:
      'The client-facing page — the thing a proposal link opens. Its dispatch ends in ' +
      '`default: return null`, so a missing type is a block the author placed, saved and can see ' +
      'in the designer, and that the client never sees. The author has no way to tell, because ' +
      'the designer renders from a different function.',
    silent: true,
  },
  {
    key: 'pdf',
    file: 'src/modules/pdf/layout.ts',
    pattern: "case 'TYPE'",
    because:
      'The PDF the client downloads and the one that gets printed, signed and filed. No ' +
      '`default:`, which looks like safety and is not: `add(block: Block): void` returns nothing, ' +
      'so TypeScript does not require the switch to be exhaustive and a missing type falls ' +
      'through to the end silently. The failure mode is a document that is right on screen and ' +
      'missing a section on paper.',
    silent: true,
  },
  {
    key: 'email-html',
    file: 'src/modules/marketing/render-email.ts',
    pattern: "case 'TYPE'",
    because:
      'The marketing email, which §8 requires this engine to render. `default: return \'\'` means ' +
      'a missing type is dropped from the send — and a campaign is measured by opens and clicks, ' +
      'so a dropped call-to-action looks like an audience that did not engage rather than like a ' +
      'bug.',
    silent: true,
  },
  {
    key: 'merge-fill',
    file: 'src/modules/design/merge-fields.ts',
    pattern: "case 'TYPE'",
    because:
      'Where `{{client.name}}` becomes a name. `default: return block` leaves the braces on the ' +
      'page, in front of the client — the most visible kind of unfinished document, and the one ' +
      'that makes a proposal look machine-generated in the specific way §7 is trying to avoid.',
    silent: true,
  },
  {
    key: 'merge-detect',
    file: 'src/modules/design/merge-fields.ts',
    pattern: "case 'TYPE'",
    because:
      'The other half of merge fields: which fields a document uses, for the editor to list and ' +
      'warn about. `default: return []` reports a document as using no merge fields when it uses ' +
      'several, so a field that will not resolve is not flagged before the document is sent. Same ' +
      'file as `merge-fill` and a separate surface, because they are separate switches and the ' +
      'first draft of the table block filled one and not the other.',
    silent: true,
  },
  {
    key: 'designer-label',
    file: 'src/components/design/designer.tsx',
    pattern: "case 'TYPE'",
    because:
      'What the block list in the editor calls each block. `default: return \'Block\'` is the ' +
      'mildest gap here — a document of eight blocks all labelled "Block" is navigable but ' +
      'tedious. Counted because the whole point of counting is not having to decide which gaps ' +
      'are worth it.',
    silent: true,
  },
]

export function blockSurfaceFor(key: string): BlockSurface {
  const found = BLOCK_SURFACES.find((surface) => surface.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'BLOCK_SURFACES',
    key,
    message:
      `No block surface is declared as "${key}". This register is the list of places a block ` +
      'type has to reach, six of which handle an unknown type silently — so a lookup answering ' +
      '`undefined` would report a surface as covered when nothing checks it. ' +
      `Declared: ${BLOCK_SURFACES.map((surface) => surface.key).join(', ')}.`,
  })
}

/** The pattern that recognises one type at one surface. */
export function coverageMarker(surface: BlockSurface, type: string): string {
  return surface.pattern.replace('TYPE', type)
}

export function blockSurfaceStands(surface: BlockSurface): string[] {
  const problems: string[] = []

  if (surface.because.length < 260) {
    problems.push(
      `${surface.key} does not argue itself. The argument here is **what a reader loses**, ` +
        'because every one of these gaps compiles and most of them look like nothing is wrong — ' +
        'so "this surface should handle every type" is not a reason, it is a restatement.',
    )
  }

  if (!surface.pattern.includes('TYPE')) {
    problems.push(
      `${surface.key}'s pattern has no TYPE placeholder, so it cannot be checked per block type.`,
    )
  }

  return problems
}

// ---------------------------------------------------------------------------

/**
 * Every place a block reaches somebody who is not its author (Phase 191).
 *
 * ## A different question from `BLOCK_SURFACES`
 *
 * That register asks *does each block **type** reach each surface*, and is
 * checked by a scan for a pattern. This one asks *does each surface **skip** a
 * block the author hid*, which no scan can answer: the absence of a block in
 * an output is not a string anybody can grep for.
 *
 * So this register is checked **behaviourally** — a document with a hidden
 * block carrying a marker is rendered through each surface named here, and the
 * marker has to be absent. The register's job is to make the list of surfaces
 * a thing a test iterates rather than a thing somebody remembers, so a ninth
 * reader surface fails a test instead of quietly showing held-back content.
 *
 * ## Why the failure is worse than a missing block
 *
 * A block type missing from a surface is content the author put in and nobody
 * sees — bad, and visible to the author the moment they look at the output. A
 * **hidden** block appearing on a surface is content the author deliberately
 * held back, shown to the one person it was held back from, and the author has
 * no reason to go looking. The draft scope, the price breakdown kept for the
 * second meeting, the clause legal has not approved.
 *
 * The author surfaces are deliberately **not** listed. The designer, the block
 * editor, the save path and the Design Assistant's outline all see every
 * block, because hiding one from its author is how it gets lost.
 */
export type ReaderSurface = {
  key: string
  /** Repository-relative path of the function that renders for this reader. */
  file: string
  /** Who is on the other side of it. */
  reader: string
  /** What is lost if a hidden block reaches this reader. */
  because: string
}

export const READER_SURFACES: readonly ReaderSurface[] = [
  {
    key: 'web',
    file: 'src/components/design/document-render.tsx',
    reader: 'A client opening the proposal link.',
    because:
      'The page the link opens, and the one surface where the author can be looking at the same ' +
      'document at the same moment and see something different. It takes an explicit `audience` ' +
      'rather than filtering unconditionally, because the designer renders its preview through ' +
      'this same component and an author must see what they have held back — greyed, labelled, ' +
      'and plainly not part of what is sent.',
  },
  {
    key: 'pdf',
    file: 'src/modules/pdf/layout.ts',
    reader: 'Whoever opens the attachment, now or in five years.',
    because:
      'The worst place for this to leak, because a PDF is the artifact that gets forwarded, ' +
      'printed and filed. A page can be corrected by hiding the block properly and reloading; a ' +
      'PDF that went out cannot be corrected at all, and Phase 21 guarantees it will never ' +
      'change. There is no author audience here — a preview renders what a client would get, ' +
      'which is the whole point of a preview.',
  },
  {
    key: 'email-html',
    file: 'src/modules/marketing/render-email.ts',
    reader: 'Everybody on the campaign list.',
    because:
      'A send reaches an audience at once and cannot be recalled. A marketing creative is ' +
      'exactly where a held-back block is likely — an offer being drafted alongside the one ' +
      'going out — and the blast radius is the whole list rather than one client.',
  },
  {
    key: 'email-text',
    file: 'src/modules/marketing/render-email.ts',
    reader: 'The same list, in a plain-text client.',
    because:
      'The alternative part of the same message, and a separate switch in the same file. Listed ' +
      'separately for the reason Phase 181 listed `merge-fill` and `merge-detect` separately: ' +
      'they are two dispatches, and the first draft of a change fills one.',
  },
]

export function readerSurfaceFor(key: string): ReaderSurface {
  const found = READER_SURFACES.find((surface) => surface.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'READER_SURFACES',
    key,
    message:
      `No reader surface is declared as "${key}". This register is the list of places a block ` +
      'reaches somebody who is not its author, and a lookup answering `undefined` would report ' +
      'a surface as checked when nothing renders through it. ' +
      `Declared: ${READER_SURFACES.map((surface) => surface.key).join(', ')}.`,
  })
}
