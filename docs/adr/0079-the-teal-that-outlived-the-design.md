# 0079 — The teal that outlived the design

**Status:** accepted
**Date:** Phase 79
**Amends:** ADR 0070 (the design canvas retheme), ADR 0073 (the mark), ADR 0021 (the PDF writer).

## The defect

An audit of every page for the Phase 70 palette came back clean, and that was
the interesting part. All 181 components under `src/app` and `src/components`
paint exclusively in design tokens — not one raw Tailwind palette class in the
tree, 348 uses of `.card`, 702 of `.btn`, and zero hand-expanded copies of
either. Sixty-six of the eighty-six pages sit in `AppShell`; every one of the
twenty that does not is deliberate and says so.

**And then there were the frames around it.** `#0d6e60` — the teal this
application stopped using nine phases ago — was still in eight places, every
one of them somewhere a stylesheet cannot reach:

| Where | What it painted |
| --- | --- |
| `app/layout` `viewport.themeColor` | the band behind a browser's address bar |
| `public/offline.html` | the whole page, when the device has no signal |
| `db/schema/studio` | five column defaults |
| `components/design/document-render` | `DEFAULT_BRAND` |
| `modules/pdf/service` | `DEFAULT_BRAND`, a second one |
| `modules/pdf/invoice` | `INVOICE_BRAND`, a third |
| `app/studio/studio-workspace` | nine `??` in a form |
| `modules/pdf/layout` | three float triples, converted by hand |

Two different defects wearing the same colour, so this ADR settles them
separately.

## Decision 1: the chrome reads a palette that cannot drift from the stylesheet

`globals.css` is the palette and stays the palette. `modules/brand/palette`
mirrors all nineteen tokens in both schemes as hex, and `tests/palette.test.ts`
reads the stylesheet and fails if a single value disagrees — in the CSS's own
`R G B` spelling, so a failure reads as the two lines somebody has to
reconcile. A copy is allowed on exactly that condition: that it cannot silently
be wrong.

`themeColor` now comes from `themeColorMeta()`, which returns `--chrome` —
`#0D1117` light, `#090C11` dark. Phase 73 fixed the icon and the manifest and
believed it had fixed this; it had not, because **the meta tag wins**. A
browser prefers `<meta name="theme-color">` to the manifest's `theme_color` for
the page it is on, so repainting the manifest changed nothing anybody could see
while the app was open.

`offline.html` keeps its inline copy — it is the one document that has to render
when nothing else can, so it cannot depend on a stylesheet — but the copy is now
five tokens, checked against the palette, and its button is `--action` rather
than the lime, because its ground is the light canvas and that is what
`.btn-primary` is. Two properties it declared and never read are gone: a value
nothing reads is a value nothing can notice going stale, which is how the rest
of that block got to be nine phases out of date.

The mark's own doc comment claimed its three colours were `--brand`, `--ink`
and `--chrome-muted`. True, and enforced by nothing. Now asserted.

## Decision 2: the document default stays teal, and is written once

The other five copies are a different question with a different answer. These
are the colours of **the customer's letterhead**, not our chrome. Repainting
the default would change the proposals and invoices of every company that never
chose one — somebody else's documents, altered to tidy a codebase. It stays
`#0d6e60`. What changes is that `DEFAULT_BRAND_KIT` in `modules/design/brand`
is the only place it is written; everything else reads it, and the column
defaults are guarded by the test the way `render-brand-icons.mjs` is.

## Decision 3: one answer to what a hex colour is

The sixth copy was three float triples in `pdf/layout`, someone's hand
conversion of the same hexes, and all three had drifted: `#0f172a` is
`0.0588 0.0902 0.1647`, not `0.06 0.09 0.16`, and `0.38` reads back as
`#0d6e61` rather than `#0d6e60`.

They were the fallback for a brand colour that will not parse — which looked
unreachable, and was not. **`isHexColor`, the guard on the only path a brand
colour takes into the database, accepts three-digit hex. `parseColor` took only
six.** So a company whose kit said `#fff` got a white document on screen, where
CSS understands the shorthand, and a document in three slightly-wrong teals on
paper. The form accepted it, the browser drew it, and the writer quietly
substituted something else.

`parseColor` now expands `#abc` to `#aabbcc` — a doubling, not a left-pad — and
the fallback is `parseColor(DEFAULT_BRAND_KIT.textColor)`, so the conversion
happens in the one function written to do it.

## What this did not do

No schema change, no migration, no ledger. Nothing a customer's data has to
move for.

The **document** brand kit is still two types — `pdf/layout`'s `BrandTokens`
has seven fields and the kit has eight. That is right rather than an omission:
paper is the colour of paper, and a PDF that filled its page with
`surfaceColor` would waste the ink of anybody who printed it.

The default a brand-new company inherits is still a colour nobody chose — it
was copied from the app's own palette when that palette was teal, and it has
outlived the reason. Choosing one deliberately is a design decision, not a
refactor, and it belongs to whoever owns the look of a customer's documents.

## What the next phase might take

`isHexColor` and `parseColor` agreed after this, and neither of them is the
only reader of a colour a customer typed. `merge-fields` and the marketing
email renderer both take brand values into HTML they generate, and the CSS
custom property the document page sets is interpolated from a `text` column
whose only guard is the one this phase just widened. Widening a validator is
the moment to check who else trusted it: the reason `assertColors` refuses
anything that is not plain hex is that these land in a `style` attribute on a
client-facing page, and that argument deserves a test rather than a comment.
