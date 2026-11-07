# 0193 — A shape somebody can place

**Status:** accepted
**Date:** 2026-11-07
**Phase:** 193

---

## The row, measured again

ADR 0192 nominated **vector primitives** — the eighth and last of ADR 0173's
capabilities — and said explicitly to re-measure rather than build against the
row, because Phase 190 had changed the ground under it.

§7's bullet lists **thirteen** things: *text, lines, rectangles, ellipses,
paths/shapes, fills, strokes, gradients, opacity, shadows, corner controls,
transforms, and reusable components.* The audit row names **ten**, omitting
`text`, `opacity` and `reusable components` — the same undercount Phase 191
found in the artboard row, in the row directly below it.

| | measured, Phase 193 |
| --- | --- |
| text | **built** — six block types are text, and the row omits it |
| lines | drawable; `divider` is a rule; no arbitrary line |
| rectangles, ellipses, paths | **drawable on both surfaces**, not placeable |
| fills, strokes, corner controls | drawable, not placeable |
| transforms | drawable, not placeable |
| gradients | refused by name in `design/svg.ts` (ADR 0190) |
| opacity | refused above 0 and below 1 (ADR 0190); the row omits it |
| shadows | nothing anywhere |
| reusable components | **built** — templates, save-as-template, the clause library; the row omits it |

So the gap was never a renderer. `pdf/vector.ts` has drawn rectangles,
ellipses, lines, paths, fills, strokes, corner radii and transforms since
Phase 190, and the page renders the same markup, because an imported SVG is
exactly those things. **What was missing is a way for an author to place one
without going to a vector editor and uploading a file.**

## What measuring found first

Before any of that: §8's **QR codes had never produced a QR code**.

`renderQrCodes` had no caller anywhere — not in `src`, not in a test — so
`RenderData.qrCodes` was always `undefined`. The client-facing page drew a
dashed box reading "QR" with the raw URL printed underneath it, and the PDF
drew an empty framed box reading "QR". Since Phase 5, using one of this
project's nine dependencies.

ADR 0189 walked past it in a sentence — *"that QR output is the thing to look
at first, because it already produces SVG the page renders and the PDF does
not"* — and Phase 190 built the converter that draws it without wiring it up.

**One attribute stood between them.** `qrcode` emits
`shape-rendering="crispEdges"` on the root, and the Phase 190 allowlist
refused it. It is dropped now rather than refused, on that allowlist's own
stated test: a rendering hint changes no coordinate and no colour, so a
drawing without it is the same drawing. `vector-effect` is deliberately still
refused — `non-scaling-stroke` changes a stroke's width under a transform,
which is geometry wearing a hint's name.

Verified module by module rather than by eye: `QRCode.create` gives the
encoder's own 29×29 matrix, the PDF was rendered at 300dpi, the dark bounding
box found and the centre of every module sampled. **841 modules, zero
mismatches** — stronger than a decoder, which would only have shown that one
reading succeeded.

## The decision: a shape is generated, never authored as markup

A `shape` block holds parameters — which primitive, which brand role paints
it, how tall, how wide, how round — and `design/shapes.ts` turns them into
SVG. The author never writes markup.

That is what makes vector primitives cheap enough to be worth having in a
block stack: no new trust boundary, no second sanitiser, and **no second
renderer**. Both surfaces draw the string one function returns.

The output is inside `design/svg.ts`'s allowlist, and a test asserts that
across the whole parameter space — three kinds × five paints × five paints ×
four stroke widths × three radii × three boxes — rather than this module
promising it. If the generator ever stepped outside, `page.vector` would draw
nothing while the page drew the shape, which is the two-documents defect the
shared subset exists to prevent.

### Colour is a brand role, not a value

**No block in this engine has ever carried a colour**, and this one does not
break that. ADR 0004's fifth decision is that brand values are CSS custom
properties so *"one document renders under a different brand kit without
touching its content"* — a hex in a block is content that outlives the kit,
and a document full of them cannot be restyled.

It also keeps clear of a validation surface with a history. `style-values.ts`
exists because a colour reaching a `style` attribute was safe only by virtue
of a guard three modules away, asserted by nothing. A role resolves to a value
that has already been through that check.

A hex does not fall back to the default: the block does not parse and
`parseBlocks` drops it. I assumed a fallback writing the test and the test
said otherwise.

### `surface` is not one of the roles

`brand.ts` records that the page background colour is on the kit and not on
the PDF's tokens, *"which is right rather than an omission: paper is the
colour of paper, and a PDF that filled its page with a surface colour would
waste the ink of anybody who printed it."*

Offering it would have meant reaching round that decision or painting a shape
a colour the PDF has no value for — and it would buy nothing. Blocks here flow
rather than overlap, so a shape the colour of the page is invisible by
construction; there is nothing beneath it to knock out. `ShapeColors` is
therefore the intersection of the two renderers' brand types rather than
either of them.

### The email is the one surface that renders it differently

Gmail strips inline SVG, so a shape drawn that way would be a gap in the
message for most of a list. A rectangle *is* a background colour with a border
radius, and that is as well supported as anything in email.

It degrades, and predictably: an ellipse is `border-radius:50%`, which
Outlook's renderer squares off. Named here because a marketing creative is
laid out by somebody who should know what the least capable client will show.

**`EmailBrand` grew an `accentColor`** for this. Nothing in an email had used
the accent, so its absence cost nothing until an author could pick it in the
designer — at which point a shape set to the accent would have come out the
primary colour in the send, and the page and the email would have disagreed
about a colour somebody chose on purpose.

## Two things seen only by rendering all three side by side

The email ignored `align` entirely, and ignored `widthPercent` for lines — so
a centred shape sat left and a 40% rule ran the full width. Both fixed with
`text-align` on the cell and `display:inline-block` on the box, rather than
`margin:0 auto`, because Outlook ignores auto margins and respects the cell.

Neither was visible in an assertion I had thought to write. They were visible
immediately in a picture of the three surfaces next to each other.

## What the registers reported

`BLOCK_SURFACES` did exactly what Phase 181 built it for. Adding the type
failed a test that named all seven surfaces it had to reach, by file:

```
shape is not handled at editor (src/components/design/block-editor.tsx)
shape is not handled at web (src/components/design/document-render.tsx)
shape is not handled at pdf (src/modules/pdf/layout.ts)
shape is not handled at email-html (src/modules/marketing/render-email.ts)
shape is not handled at merge-fill (src/modules/design/merge-fields.ts)
shape is not handled at merge-detect (src/modules/design/merge-fields.ts)
shape is not handled at designer-label (src/components/design/designer.tsx)
```

That is the register earning its keep: three block types went twenty-three
phases with no editor before it existed, and this one could not go one.

The pinned block-type count moved 18 → 19, as Phase 126 intends.

## What this does not do

**No gradients, no shadows, no opacity.** Three of §7's thirteen, each refused
somewhere with a reason rather than missing by accident. A gradient is a PDF
shading dictionary, which is a different piece of work from a fill; opacity on
a group composites once where per-element alpha does not, and the difference
is invisible until something overlapping prints wrong. A shadow is a blur,
which needs either a raster step or a transparency group.

**No arbitrary path, and no rotation.** Both are *drawable* — `pdf/vector.ts`
applies a transform and `design/svg.ts` reads one — and neither is placeable,
for the same reason: a block in a flowing stack has a width and a height and
no position, and a rotated rectangle's bounding box is not its height, so the
engine would have to reserve space it cannot compute. That is a canvas's job,
and ADR 0004 named `canvas` as the block type for it in Phase 4.

**A shape is decoration, and is marked as such.** It renders
`aria-hidden="true"` on the page and carries no alternative text, because
there is nowhere to put one and a rectangle with a label is a worse lie than a
rectangle with none. A shape carrying meaning — a status marker, a chart — is
a block type that knows what it means, not this one.

## ADR 0173's eight are done

| phase | capability |
| --- | --- |
| 180 | asset association |
| 181 | the generic `table` block |
| 182 | `deliverables` and `assumptions` |
| 183 | team bios |
| 186 | crop and mask |
| 190 | SVG import |
| 191 | `lock/hide` |
| 192 | undo/redo |
| **193** | **vector primitives** |

Nine entries for eight capabilities plus the client-link comment thread, which
Phase 188 found had been built in Phase 174 and never struck through.

Three of the nine were not what their row said. The comments/questions row was
stale by fourteen phases; the artboard row listed ten features of which two
were built and five had been decided against by name in ADR 0004; this row
listed ten of thirteen and most of them were already drawable. **The rows that
were measured again were the rows that turned out to be wrong**, which is an
argument for measuring the next list rather than a reason to feel finished.

## Nominated for Phase 194

**The audit itself, re-measured.** `docs/SPEC-AUDIT.md` was written in Phase
173 against a tree that is now twenty phases old, and the three rows re-opened
since have each been wrong in the same direction — understating what exists.
The audit's own closing claim is that *"the other sections hold up"*, and no
phase has tested that sentence.

It is the same work Phase 188 did to §7's client-link bullet and Phase 191 did
to the artboard bullet, applied to the document that nominates everything
else. ADR 0173 measured §1–§11 and said §12–§18 *"would likely find more"* —
that is a stated, unmeasured claim sitting in the file this process reads to
decide what to do next, which makes it the highest-leverage thing left to
check.

The first thing to look at is §18, which ADR 0004 recorded as *"not built"* in
Phase 4 and which Phase 21 then built; whether the audit knows that is the
question in miniature.
