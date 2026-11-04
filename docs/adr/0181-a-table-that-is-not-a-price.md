# 0181 — A table that is not a price

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 181

---

## The nomination held

Second of ADR 0173's eight measured gaps, in the order recommended. §7 names
*"tables, pricing tables"* as two things, and measurement confirmed only one
exists: `pricingTable` renders the proposal's own line items and holds no
figures of its own — right for a fee table, and useless for a specification, a
schedule with three columns, a comparison or a list of materials with
quantities. Such a table had to be built from `keyValue` rows: two columns, no
header, no way to add a third.

The block itself is small. **What writing it found is not.**

## The finding

A block type has to reach **eight surfaces**: the union, the palette, the field
editor, the client-facing web page, the PDF, the marketing email's HTML, its
plain-text alternative, the merge-field filler, the merge-field detector and the
designer's block label. Counting them found that three types had never reached
one.

`blocks.ts` states the engine's claim, about Phase 5's three marketing blocks:

> They are new entries in the same union — the engine, the renderer's dispatch,
> the merge-field resolver, and the storage model all stayed as they were, which
> is the test ADR 0004 set for itself.

That passed, and it passed for a reason nobody checked. **Six of the seven
dispatch sites end in a `default:` clause**, so a new block type compiles and is
silently handled as nothing: `render-email` returns `''`, `document-render`
returns `null`, the plain-text alternative `break`s, `merge-fields` returns the
block unchanged and reports no fields. The PDF has no `default` and would not
have helped either, because `add(block: Block): void` returns nothing and
TypeScript does not require a switch to be exhaustive when its value is unused.

And `block-editor.tsx` is not a switch at all — a chain of `&&` — whose own
docstring claims *"one case per block type"*. It had **thirteen of sixteen**.

So from Phase 5 to Phase 181, a marketing document could contain a
call-to-action **button that rendered on the page, in the email and in the PDF
with its default label and an empty `url`, and nothing anywhere could set it.**
Same for a QR code's `value` and a video's link. §8's *"buttons/links, QR codes,
embedded/linked video"* existed on every surface except the one where somebody
configures them.

It was not a compile error, not a test failure, and not visible in a screenshot,
because all three blocks render perfectly well — containing nothing. That is
Phase 160's shape exactly: a capability installed and inert.

Twenty-three phases. Phase 179 found a cross-tenant check broken for nine and
called that the one to sit with; this is longer, and the reason is the same —
nothing counted it.

## So the coverage is counted

`BLOCK_SURFACES` names the eight surfaces, how a handled type appears at each,
and **what a reader loses when one is missing**. The floor on the argument is set
on that question deliberately: every one of these gaps compiles and most look
like nothing is wrong, so "this surface should handle every type" is a
restatement rather than a reason.

Seven of the eight fail silently. The eighth is the palette, where a gap means
the block never appears in the menu — which somebody notices the first time they
look for it. It is in the register anyway, because a register of surfaces that
skipped the obvious one would leave a reader wondering whether it had been
considered.

The register holds the **pattern**, never a list of types, so a seventeenth
block type is caught by the scan rather than by somebody remembering to add it
here as well. Same device as `PINNED_CLAIMS` in Phase 179 and for the same
reason.

### What the scan caught immediately

Six more gaps: `divider`, `spacer` and `pageBreak` were not handled in either
merge-field switch. The scan was right in a way worth acting on — those three
have no text, so falling to the `default` was *correct behaviour* reached by the
wrong route.

That is the ambiguity that let three editors go missing. **A `default` doing
double duty for "nothing to merge" and "somebody forgot" cannot tell you which
it is.** The three no-op cases are now listed explicitly, so the `default` means
one thing: a block type nobody declared. Six lines, and they are how those three
types say they were considered — Phase 157's rule about a declaration that
accuses rather than excuses.

## The block

- **Optional header.** Empty means no header row; a header of empty strings is a
  different thing, and a table used for layout needs neither.
- **Up to six columns**, and the cap is the PDF rather than taste. §7 asks for
  *"print-quality output"*, and six equal columns of the content width at this
  body size are still readable. A seventh is not ugly, it is unreadable — and a
  block that renders acceptably on screen and illegibly in the document the
  client downloads is the half-working this engine's single model exists to
  avoid.
- **Per-column alignment**, shorter than the row meaning "left from here on", so
  a three-column table where only the last is right-aligned need not say
  `['left', 'left', 'right']`.
- **Three border styles**: between rows, every cell, none.

### Rectangular, from two directions

A ragged table is not a rendering edge case. It is four different wrong answers:
HTML drops the missing cells, the PDF computes column widths from a row that is
not representative, the email's table layout silently misaligns, and the
plain-text alternative loses the column boundary entirely.

The module already had the right shape for this and it took a wrong turn to
find it. The first draft put the rule in the schema with `superRefine` — which
Zod turns into a `ZodEffects`, which is not a `ZodObject`, which a
`discriminatedUnion` cannot hold. The union degraded to `any` **without saying
so**, and the typecheck reported it as seven implicit-`any` errors in two other
files.

The right place was the split the module already has:

- `validateBlocks` — the editor's save path — refuses a ragged table with a
  sentence naming the row and the width.
- `parseBlocks` — the render path — keeps it, because its comment is right: *"a
  document that fails to render is worse than one missing a block."*
- `normalizeTable` — called by **every** renderer — pads it.

Lenient and *consistent* is the pair that needs a function. Lenient alone is how
the four wrong answers happen.

## Three renderers, three different right answers

Worth recording, because they are not variations on one implementation:

- **The email's HTML omits `role="presentation"`.** Every other table in that
  renderer carries it, which tells a screen reader to ignore the structure. This
  one *is* tabular data, so the attribute that is right for layout is exactly
  wrong here. Borders go inline on each cell because Outlook ignores
  `border-collapse` and draws a collapsed table's rules twice.
- **The plain-text part column-aligns with spaces**, widths from the widest cell
  capped at 24 characters. A table is the one block that loses its meaning
  entirely without its shape, and the plain-text part is read by somebody who
  chose it.
- **The PDF makes each row its own piece**, so a long table breaks across pages
  where the engine already knows how to break, with the header `keepWithNext` so
  a table never starts orphaned at the foot of a page. Columns are equal width:
  measuring content to size them is the better answer and a bigger one — two
  passes and a rule for what to do when the widths do not fit — and equal
  columns are predictable rather than surprising. `MAX_TABLE_COLUMNS` is six for
  exactly that reason.

## Nominated for Phase 182

**`deliverables` and `assumptions` (§7)**, next in the order recommended. Ten of
the twelve components §7 names have a dedicated block or column; these two have
neither and would be typed into a `text` or `list` block — which is the same
shape of gap as the table: possible to fake, and therefore not reported, and
therefore never counted.

Behind it, unchanged from ADR 0180: team bios (§15), then §7's four remaining
design-engine pieces (crop/mask, SVG, artboard affordances, vector primitives),
and the conversion of `document_links` away from twelve keyless polymorphic
subject references.
