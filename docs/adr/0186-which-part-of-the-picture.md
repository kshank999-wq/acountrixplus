# 0186 — Which part of the picture

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 186

---

## The nomination, two phases later

ADR 0184 nominated §7's *"Image and logo placement, crop/mask"*. ADR 0185
found the layer underneath — the PDF contained no images at all — and built it,
nominating this. So the gap is now what it always said on the tin, and it is
finally worth closing: a crop is a thing a client can be shown.

Measuring first, as always, found one more thing in the way.

## The two columns that had to exist first

`assets.width` and `assets.height` have been in the schema since **Phase 4**,
carrying the comment:

> Pixel dimensions when known, so layout can reserve space.

No caller has ever passed them. Nothing has ever read them. Every row is NULL.
Phase 49's rule twice in one row — a column with no writer and a column with no
reader are both fields that do not exist — and the comment names a purpose that
has never once been served.

This is not a tidy-up noticed in passing. **It is the blocker.** A crop is not
expressible in CSS without the source's aspect ratio: the cropped box has to
take the *cropped* shape, and a browser can only work that out from the
original's proportions. The nominated feature could not reach a client's page
until those two columns held something.

Phase 185 had already built the thing that fills them. `prepareImage` reads
width and height out of a JPEG's SOF and a PNG's IHDR without decoding, so
`imageSize` is the same parsing asked a smaller question — and it answers for
**WebP and GIF too**, which the PDF cannot embed. That asymmetry is deliberate:
a size is a fact about a file, and a browser can crop a WebP perfectly well.
Tying the measurement to what a printer can do would have made the page's crop
depend on the PDF's limits.

### The ones already uploaded

SQL cannot read a PNG header, so a migration cannot backfill this. A lazy fill
on read was the other option and was rejected: the read that would do it is on
the client-facing proposal page, and a read that writes is a surprise in the
one place that should be inert.

So `measureStoredAssets` is an operation somebody runs, and until they do the
renderers **degrade honestly** — an unmeasured asset shows the whole picture
rather than a crop guessed from a ratio nobody knows. A crop the author sees
and the client does not is the one failure a crop control must not have.

## Fractions, not pixels

A crop is `{ x, y, width, height }` in fractions of the source.

Pixels would break the first time somebody re-scans a certificate at a higher
resolution: the same numbers would then describe a corner of it. Fractions
describe the same part of the same photograph at 600 pixels wide and at 3000,
and they are also the only form that means anything before a renderer knows how
big the source is — which is exactly the situation the designer is in while a
picture is still loading.

`normalizeCrop` is the single answer to "where may this box be", shared by the
editor, the page and the PDF. It **pulls a box back onto the picture rather
than shrinking it**, because dragging off the right edge means "as far right as
it goes" and a box that changes shape under the pointer is a control nobody
trusts.

Strict on save and lenient on render, the bargain Phase 181 struck for ragged
tables: `validateBlocks` refuses a crop that runs off the edge, and
`parseBlocks` clamps it, so a document stored by an older editor renders rather
than disappearing from a link a client already has.

## Crop and mask are two operations in one bullet

§7 writes them together and they are different. A crop chooses **pixels**; a
mask chooses an **outline**. They compose rather than being modes, and a test
says so.

Three shapes, and the list is short on purpose. An arbitrary mask is a path,
which is the vector authoring §7 defers; a circle and a rounded rectangle are
what a capability statement and a product sheet ask for. Both are four Bézier
curves in a PDF and one CSS property on the page.

`ROUNDED_MASK_FRACTION` is one constant read by both, because a corner rounder
on screen than on paper is two documents — the mistake `normalizeTable` exists
to prevent one level down.

A `circle` on a non-square box is an **ellipse**. That is the right
generalisation rather than a shortcut: it is what `border-radius: 50%` does,
and the two renderers have to agree about the shape of a face.

## Nothing is resampled, on either surface

In the PDF a crop is a clipping path and a scale — `re W n`, then a `cm` that
draws the picture larger than its box. No pixel is touched, so a cropped
photograph prints at exactly the resolution it was uploaded at. That is why a
crop is free here and would not be if it were done by re-encoding, which is the
usual way and would need the image codec this project does not have.

On the page it is percentages all the way down: a box with the cropped aspect
ratio, holding an image sized `100 / crop.width` and `100 / crop.height`
percent of it and offset by `-x / width` and `-y / height`. The browser does
the arithmetic, so a resized window, a phone and the print box all keep the
crop.

Measured rather than asserted: a 1000×500 picture cropped to `x 0.2, y 0.25,
w 0.2, h 0.5` renders in Chromium as a 300×375 box holding a 1500×750 image
offset by −300 and −187.5. The image's own ratio is 2.0, the source's is 2.0, so
nothing is distorted; the visible strip is source fractions 0.2–0.4 across and
0.25–0.75 down, which is the crop exactly. The PDF was rendered with `pdftoppm`
and looked at for the same reason.

## The editor is a picture with a box on it

Four spinners describing a shape is a form somebody fills in twice and gets
wrong once. The control is the picture with the kept region drawn over it at
full strength on a dimmed whole, so an author sees the framing rather than its
coordinates — which is the only way to tell whether a face is in it.

Two gestures, because they are the two things people do: dragging inside moves
the box, dragging the corner resizes it. Pointer positions become fractions
immediately and are never held as pixels, and both gestures are clamped by
`normalizeCrop` rather than by arithmetic in the component — one answer, shared
with the renderers.

The presets centre on what is already chosen rather than resetting to the
middle, so picking **Square** after framing a face keeps the face.

## The headshot, from the other side

Phase 183's headshots were already cropped to a square — `object-fit: cover` on
the page and, since Phase 185, a clipping path in the PDF. What they could not
do is change **outline**, which is the half of `crop/mask` a capability
statement actually varies: firms have opinions about circular headshots.

So `photoShape` is three values and the default is the square Phase 183
shipped. There is no `none`, because a directory of mixed portrait and
landscape faces reads as a mistake and the crop is not the author's to turn
off.

## What this does not do

**The email shows no pictures, so it crops nothing.** `render-email.ts` has no
absolute asset URL to put in a `src` and has said so since Phase 183. The
editor says it too, where an author chooses the crop, rather than leaving them
to find out from a sent campaign.

**There is no focal point.** A crop is a rectangle an author places; it does
not follow a face when a block is resized. That is a different feature and
would want the same rectangle plus a point, so nothing here forecloses it.

**`measureStoredAssets` has no screen.** It is exported, permissioned and
tested, and nothing in `src/app` calls it — which is the `PENDING_WIRING` shape
Phase 139 named, so it is said here rather than discovered. Every asset
uploaded from now on is measured at upload; the ones already stored need
somebody to run it.

**Phase 185 did not get a full-suite run.** Its shards were stopped after the
first to free the tree for this phase, and its targeted runs covered every file
importing what it touched plus all ten tree-wide scans. The run at the end of
this phase is the first complete one since Phase 184, and it covers both.

## Nominated for Phase 187

**Moving the read and write scans into `src/modules/source/`.**

It has been nominated three times and skipped three times, and the cost is now
measured rather than argued: `PINNED_CLAIMS` holds twelve claims a test checks
and one it cannot, and that thirteenth has needed correcting **by hand in every
phase since Phase 179 that touched a read** — 180, 183, 184, 185 and this one.
Five phases of a declaration watching itself go stale is the argument for
fixing it, and Phase 157's rule is why it is still declared rather than
deleted: it accuses.

It is also the smallest remaining item by a distance, which is exactly why it
keeps losing to §7 work. Doing it next is a decision about which kind of debt
gets paid, not about which is larger.

Behind it: SVG import/export, artboard affordances, vector primitives, and the
client-link comment thread — the last four of ADR 0173's eight, all §7's design
engine.
