# 0185 — The pictures that never printed

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 185

---

## The nomination was downstream of a bigger gap

ADR 0184 nominated §7's crop and mask on images. Measuring first found
something underneath it.

**The PDF contained no images at all.** An `image` block drew a grey frame
labelled *"Image — see the online version"*. The `cover` block's `showLogo` —
a toggle in the editor since Phase 5, honoured on the web page since Phase 5 —
was ignored outright; `RenderInput` did not even carry the asset id. And Phase
183's team headshots were stated as not drawn.

So a capability statement with a logo, a product photograph and three faces
rendered perfectly in a browser and printed as three empty boxes. The PDF is
the artifact that leaves the building: it is what a client downloads, prints,
signs and files.

Cropping a picture the PDF cannot draw is a crop the client never sees. This is
the phase underneath the nominated one, and ADR 0182 already named the pattern:
doing the nominated work in the shape that made the nomination necessary would
have been the nominated work wasted.

### Why it survived a hundred and sixty phases

Because it was **declared**, not hidden. `writer.ts` said so in its own
docstring — *"no images beyond a placeholder frame"* — and ADR 0021 listed it
under consequences. A stated limitation reads as a decision, so nobody looked
at it again, and the placeholder was visibly incomplete in the designer preview
where an author never looks at the PDF.

That is a third variety of the shape Phases 181 to 184 kept finding. Phase 181:
installed and inert. Phase 182: a column with no reader. Phase 184: a
constraint's second guarantee, unexamined. This one is **a limitation that
outlived its reason**: embedding images was genuinely hard when the writer was
250 lines, and the sentence stayed true-looking long after it stopped being
necessary.

## No image library, and none needed

This project has nine dependencies and no image codec. It still has nine,
because **PDF speaks both formats natively**:

- A JPEG is embedded **byte for byte** under `/Filter /DCTDecode`. A PDF viewer
  contains a JPEG decoder; ours does not have to. Nothing is decoded,
  re-encoded or degraded — the stream in the file is the file somebody uploaded.
- A PNG's `IDAT` is a zlib stream of predictor-filtered rows, and PDF's
  `/FlateDecode` with `/Predictor 15` **is the PNG filter set** — the PDF
  specification adopted it verbatim for exactly this. So a PNG without alpha is
  also embedded byte for byte.

Only transparency needs real work, because PDF keeps alpha in a separate
`/SMask` image rather than interleaved with the colour. That one path inflates
with `node:zlib` — a Node builtin, so still no dependency — unfilters, splits
colour from alpha, and re-deflates both.

The tests are therefore mostly **identity assertions**: the bytes in the PDF
are the bytes of the upload. That is the claim worth making, and it is only
makeable because nothing is decoded.

### What refuses, and why a refusal is a sentence

WebP and GIF are in `ALLOWED_IMAGE_TYPES` and cannot be embedded: WebP is VP8,
GIF is LZW, and neither is a PDF filter. A decoder for either is a dependency
or a thousand lines, and it would be the wrong thousand — converting the upload
once beats decoding it on every render.

So they refuse, and the refusal carries **a remedy** (Phase 119):

> Cannot print this image — image/webp cannot be placed in a PDF. Convert it to
> PNG or JPEG and upload it again.

Against what it replaced, which told a client holding a printed page to go and
look at something else. Progressive JPEGs, CMYK JPEGs, interlaced PNGs,
transparent-palette PNGs and sub-8-bit alpha each refuse with their own
sentence, because the conversion is different in a person's head each time.

The three *empty* cases are now distinguished too, which one sentence could not
do: no asset chosen, an asset that cannot be printed, and an asset that is no
longer in the library.

## The two blocks whose pictures were never reached

The `image` block was the nominated one. Two more were the same gap and would
have been left behind:

**`cover`'s logo.** The toggle existed on every surface and the PDF ignored it.
It is drawn above the title now — height-bounded rather than width-bounded,
because logos are wide and short or square and bounding the width makes a
square mark enormous. It is **not** drawn on a brand-coloured band: a logo is
usually one colour with a transparent surround, so a dark mark on a dark band
is an invisible logo. Skipped rather than drawn wrong, and the band is already
the company's colour, which is what the toggle was reaching for.

**`team`'s headshots.** ADR 0183 stated they were not drawn and gave a reason —
*"embedding an image means decoding it"* — which was true of this writer then
and is precisely the gap this phase closed. The rest of that sentence, that a
photograph at whatever resolution is worse than a name set properly, turned out
to be about **placement**: bounded to a square and set beside the name, it
prints like a capability statement.

Squaring it needed a clipping path, which is the nominated feature's own
primitive arriving early. `PageCanvas.image` takes a `clip` rectangle and emits
`re W n`; the picture is scaled so its shorter side fills the square and the
overflow is clipped. That is `object-fit: cover` written in PDF operators, and
it is the same answer `.doc-team-photo` gives in CSS — so the two renderers
agree about the shape of a person's face, which they would not if one squashed
and the other cropped.

## A test caught the comment

The first version embedded every image the caller had **prepared**, and carried
a comment claiming it embedded only the ones a page had **placed**. Both
sentences were in the same commit.

`PageCanvas` records the resource names it actually invokes, and the embed pass
asks the canvases rather than the blocks. The difference is not pedantry: a
block can decline to draw its picture — a logo on a brand-coloured band does —
so a map keyed off the blocks would put an XObject in the file that nothing
references.

Phase 110's rule, in the smallest possible form: a declaration argued from a
fact that is not a fact. The only reason the paragraph in the code is accurate
now is that a test disagreed with it.

## Verified by looking at it

A test can assert that `/Subtype /Image` is in the file and that the JPEG's
bytes are in it. Neither says the picture is the right way up, the right shape,
or visible.

So the output was rendered with `pdftoppm` and looked at: the logo on the
cover, a JPEG at 60% of the content width with its aspect ratio intact, a PNG
whose 50%-alpha half composites to pink over white — the `/SMask` doing its job
— the WebP refusal wrapping across two lines inside its frame, and a square
headshot clipped from a 6×4 original beside the name. The one defect that found
was in the first `/DecodeParms`, which no assertion would have caught because
the dictionary was well-formed and wrong.

## What this does not do

**Crop and mask are still not author-controlled**, which is what ADR 0184
nominated. The PDF primitive is built and in use, and `object-fit: cover` is
already in the page's CSS, so what remains is the part that was never the hard
part: a rectangle on the block, an editor to drag it, and the three renderers
reading it. Nominated below rather than half-built here.

**The email still shows no pictures**, and that is the medium rather than this
renderer: `render-email.ts` has no absolute asset URL to put in a `src`, which
its own comment has said since Phase 183.

**WebP and GIF still cannot be printed.** The asset library accepts them, so
the honest options were to refuse them at upload or to refuse them at render.
Refusing at render is the one that does not throw away a file somebody already
has, and the sentence tells them what to do.

**Content streams are still uncompressed.** Image streams are not — they
arrive compressed and stay that way — so a proposal with photographs is now
mostly compressed bytes with a readable text skeleton, which is the best of
both and was not designed, just true.

## Nominated for Phase 186

**Crop and mask**, the item ADR 0184 nominated, now that there is something to
crop.

The shape is clear enough to state: a crop rectangle in fractions of the
source on the `image` block, so it survives the asset being re-uploaded at a
different size; `object-fit`/`object-position` on the web; the `clip` that
`PageCanvas.image` already takes in the PDF; and an honest degradation in the
email, which cannot crop at all in Outlook. The editor is the real work, and it
is a drag handle over a preview rather than anything in the renderers.

Behind it: SVG import/export, artboard affordances, vector primitives, the
client-link comment thread, and moving the read and write scans into
`src/modules/source/`. That last one has now been nominated three times, and
its thirteenth pinned claim has needed correcting by hand in every phase since
Phase 179 that touched a read — 180, 183, 184 and this one.
