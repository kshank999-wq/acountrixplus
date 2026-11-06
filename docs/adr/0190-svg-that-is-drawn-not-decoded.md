# 0190 — SVG that is drawn, not decoded

**Status:** accepted
**Date:** 2026-11-06
**Phase:** 190

---

## The nomination held, and the obstacle was a correct decision

ADR 0189 nominated **SVG import/export (§7)** as the one of ADR 0173's three
remaining capabilities that is not the path editing §7 explicitly defers. The
audit row read *"Nothing for designs. The only SVG in the codebase is QR
output."*

Measured before building, per Phase 164: the row is true. And the reason it is
true is not neglect. SVG is refused in three places with one argument, written
in Phase 4 and quoted here verbatim because it is the thing this phase had to
answer:

> SVG is deliberately absent: it can carry script, and these files are served
> back to browsers on public proposal pages. Accepting it would turn the logo
> library into a stored-XSS vector.

That argument is **correct**, and `/api/assets/[id]` confirmed the mechanism
rather than only the worry: it served `Content-Type: image/svg+xml` with
`Content-Disposition: inline`, so a direct visit to an uploaded SVG would be a
document in this origin — against a colleague holding a session or a client
holding a proposal token.

So the phase is not "was SVG forgotten". It is §7's own qualifier: *"SVG
import/export **where practical**"*. **What would make it practical?**

## The decision: the subset worth importing is tiny

A logo is flat-filled paths and basic shapes. Everything that makes SVG
dangerous — script, event handlers, `foreignObject`, external references — and
everything that makes it hard to print — filters, gradients, patterns, text
needing fonts — is outside that subset.

So an allowlist of eleven elements and about twenty attributes covers what
anybody actually uploads. That much is unsurprising. The decision worth
recording is what the allowlist is **for**:

> The allowlist is both the security boundary and the printable subset, and the
> test of whether a construct is allowed is not whether it looks harmless. It
> is **whether this module can read it completely enough to redraw it.**

That is why `parsePath`, `parseTransform` and `resolvePaint` live in
`design/svg.ts` beside the allowlist rather than in the PDF writer that needs
them. The sanitiser refuses a path on exactly the condition under which the
writer would have had nothing to draw — not because both were written
carefully, but because it is the same function asking.

Two lists would have been two answers to one question, and the failure mode is
specific: **an SVG that is safe to serve and silently blank on paper.** That is
Phase 185's defect with a new file format, and Phase 185's defect survived
sixty phases because it was *declared* rather than hidden.

### Not the `svg` block ADR 0189 sketched

ADR 0189 nominated this with a shape in mind: *"An `svg` block that carried
markup would have the same shape"* as the QR block, which renders generated SVG
on the page.

It was built as a **content type in the asset library** instead, and the reason
is that the other shape would have duplicated five things that already exist
and agree: an upload control, a size measured at upload, Phase 186's crop,
Phase 186's mask, and the `image` block's alignment and caption. A `svg` block
holding markup would have needed its own answer to each, and the one the
`image` block already gives is the one the PDF already honours.

It also puts the sanitiser in the right place. Markup pasted into a block is
markup stored on a document; a file uploaded to the library passes through
`uploadAsset`, which is the single chokepoint every asset already goes through
— so there is one place to rewrite bytes rather than one place per surface.

### It rewrites rather than trusts

`sanitizeSvg` does not inspect and approve the uploaded bytes. It parses them
and emits its own document from what it understood, so a construct nobody
thought to deny cannot survive — there is nowhere in the representation to put
it. A comment, an XML declaration and an editor's `sodipodi:nodetypes` are gone
from the output not because anything removed them but because the serialiser
has no slot for them.

`uploadAsset` then **reassigns `data`** before the digest, the store, the size
and the measurement. That ordering is the security argument: there is no later
step that could reach for the original bytes, and no way to add one by
accident.

### It refuses rather than strips

The opposite of what a sanitiser usually does, and deliberate. A logo with its
gradient silently removed is a logo that prints wrong, and the person who can
fix it — by exporting a flattened copy — is standing at the upload form.
Stripping is right when the content is a comment somebody typed; refusing is
right when it is a file they chose and can re-export (Phase 119).

Each refusal carries **its own remedy**, because one remedy for every problem
is one remedy that is wrong for most of them.

## The second half, and why it is not a later phase

A sanitiser alone would have been a page that renders an imported logo and a
PDF with a hole in it. `pdf/vector.ts` converts the stored document to path
operators in the content stream — not an image XObject, which is what makes an
imported logo the one thing in the PDF that is resolution-independent.

It calls `readSvg`, the function the sanitiser calls. There is therefore **no
"unsupported, skip it" branch** anywhere in it: the branch would be
unreachable, and an unreachable fallback is how a silent blank gets into a
document.

Three facts do the work. SVG's y axis points down and PDF's points up, so there
is one negative scale in the base matrix and the drawing is emitted in its own
coordinates — converting each coordinate as it is written gets Bézier control
points and arcs wrong. `transform` nests exactly like `q`/`cm` … `Q`. And a PDF
stroke scales with the matrix as an SVG one does, so `stroke-width` needs no
correction.

Paint is the exception and is tracked in JavaScript, written out explicitly on
every shape: PDF's graphics state would inherit it too, but SVG's inheritance
rules are not PDF's, and a shape that is the right shape in the wrong colour is
worse than one that is missing.

### Three findings from rendering it and looking

Assertions would have missed all three; the same was true in Phases 185 and 186.

**A nested `<svg>` was accepted.** It establishes a second viewport with its own
`preserveAspectRatio`, which the converter does not honour — so it would have
printed at the wrong size. Refused now, rather than half-handled there.

**Every Inkscape export was refused**, over `xmlns:dc` and `inkscape:version`.
Namespace declarations, `id`, `class` and editor provenance carry no geometry
and no paint, so dropping one cannot change how the drawing looks while
refusing one rejects the file over bookkeeping. They are the single exception
to refuse-rather-than-strip, and the exception is stated with the condition
that would end it: **the allowlist has no element that references anything, so
there is nothing for `id` to be the target of.**

**Every Illustrator export was refused**, over `x="0px"` on the root — which
the SVG specification itself ignores there — and would next have been refused
over `style=`. CSS is now named apart from everything else, because it is the
refusal a real exporter is most likely to earn and the one with the most exact
remedy: Illustrator writes presentation attributes when its CSS option says to.

### And one found by reading the loop

`parsePath('M0 0 Z 5 5')` **never returned**. `Z` takes no arguments, so the
loop pushed it, left the command set and advanced nothing — forever, on a
string a file chooses.

Every other defect this phase found came from rendering the output and looking
at it, which is the technique that has paid since Phase 185. This one could not
have: the output is a hang, and there is nothing to look at. It came from
re-reading the loop and asking whether every path through it advances.

The fix clears the command after a zero-argument one, which makes the
termination argument short enough to state: each iteration consumes a letter,
consumes `needed` arguments, or returns. The test is an `it.each` over eight
ways to break the grammar, because the property worth holding is that
`parsePath` *returns* and the only honest way to assert that is to call it.

Worth recording because the module's own docstring argues that refusing is
safer than stripping, and a hang is the one failure mode where that is not
automatically true — a reader that refuses has to finish reading first.

## Transparency is accepted only where it is none

`opacity="1"` and `fill-opacity="1"` are what every exporter writes, so
refusing the attribute outright would refuse most real logos. A value below one
is refused, and the reason is precise rather than a shrug at scope:

**`opacity` on a `<g>` is group opacity.** The group is composited once, as a
unit. The nearest thing a PDF content stream can do without a transparency
group is set an alpha on each child, which composites overlapping children
differently — invisibly, until a logo with two overlapping shapes printed
wrong. That is the two-documents defect this whole arc is about, so the honest
answer is to refuse and say that flattening is a thing the exporter does well.

A transparency group XObject is the real implementation and is larger than this
phase.

## Two defences, in an order

The stored bytes are the one that has to hold. The response headers are the one
that catches it not holding.

`/api/assets/[id]` serves an SVG with `Content-Disposition: attachment` and
`default-src 'none'; style-src 'unsafe-inline'; sandbox`. That rests on a
browser behaviour, so it was **measured rather than asserted** — a local server
and a real Chromium:

| | result |
| --- | --- |
| `<img src=…>` with `Content-Disposition: attachment` | renders; `naturalWidth` 100 |
| direct navigation to the same URL | becomes a download, not a page |
| `<script>` inside it, on direct navigation | never ran; `window.origin` is `null` |

The first row is the one the feature depends on: browsers ignore
`Content-Disposition` for a subresource load, so the proposal page keeps
working while a direct visit stops being a page.

## The two lists that did not change together

**Evidence still refuses SVG**, and a test asserts the pair so the next reader
meets the decision rather than the discrepancy.

A brand asset is *drawn*: it is rewritten into a subset the writer can redraw,
and the person who chose it is there to be refused. Evidence is *kept*: it is
whatever the supplier sent, stored as sent. A sanitiser would rewrite a
supplier's document into one they did not send, which is the one thing a record
must not be. The choice there is between altering evidence and serving an
unexamined SVG back to a browser; excluding it is the third answer and costs
nothing, because nobody invoices in SVG.

## The register reported no drift, which is also a report

Phases 188 and 189 each moved one of `PINNED_CLAIMS`'s four numbers and the
test named which. This phase added three modules and moved none of them,
because `svg.ts`, `vector.ts` and `geometry.ts` are pure — no query, no tenant
filter, nothing for the isolation scans to count.

Worth writing down only because the previous two ADRs recorded the opposite: a
pinned number that holds when the tree grows is the same mechanism working, and
the phase it is silent in is the phase nobody would otherwise check it in.

## A sentence that was nine phases stale

`README.md` said, in the present tense:

> **One of the nine is built: asset association, in Phase 180.**

Seven of the nine are built. The sentence stopped being true in Phase 181 and
was read past by nine phases of ADR writing, this one included until the last
pass over the file.

`docs/SPEC-AUDIT.md` carried the right count the whole time, and that is
**why** the wrong one survived rather than an excuse for it: two places
answering one question, one of them maintained. The same shape as ADR 0021's
heading in Phase 188 and the same shape as the audit row in Phase 188 — which
is three findings of one defect in three consecutive phases, and worth naming
as a pattern rather than recording a third time as a surprise.

The paragraph now carries the count and says that the audit's table is the
answer and it is a summary. That does not make it self-correcting. The thing
that *is* self-correcting is `PINNED_CLAIMS`, which measures a sentence against
the tree — and a sentence counting struck-through rows in another file is
within what it can measure. Nominated as a small piece of whichever phase next
touches the register, rather than bolted onto this one.

## What this does not do

**There is no export.** §7's bullet says *"SVG import/export"*, and this is the
import half. The export half is a different question with a different answer —
a proposal page is text in fonts, and an SVG of it would either embed the fonts
or convert text to outlines, which stops it being text. Worth doing when
something asks for a logo *out* of the system; nothing does yet.

**A gradient is still a refusal, not a conversion.** A PDF shading dictionary
would turn the most common refusal into an acceptance, and it is the obvious
next thing to want. It is left out because a gradient is also the construct
most likely to differ between the browser's rendering and the PDF's, and this
phase's whole claim is that those two agree.

**`geometry.ts` exists because of a cycle that worked.** `fixed` and `KAPPA`
moved out of `writer.ts` because the writer now calls the converter and the
converter needs both. The cycle would have worked — the uses are inside
functions — and a cycle that works by accident is one that stops working when
somebody moves a constant.

**Nothing re-sanitises stored bytes.** A document already sent is the
sanitiser's output under the allowlist of the day it was uploaded. Widening the
allowlist later changes what may be uploaded and cannot change what was sent,
which is the Phase 21 property holding for a new kind of file.

## Nominated for Phase 191

**Artboard affordances (§7)**, with the measurement done first this time.

Two of ADR 0173's eight remain and both are the Illustrator-class work §7
defers — *"advanced Illustrator-class path editing can be phased in after the
core proposal workflow is stable"*. ADR 0182 recorded that this sentence defers
**path editing** specifically, and the audit's own note says reading it as
deferring both rows is the generous reading.

Of the two, artboard affordances is the one that is not path editing. The audit
measured it as *"No guides, rulers, snapping, grids, zoom, layers, grouping,
align/distribute, lock/hide, or designer undo/redo"* — ten things, which is a
list that wants measuring item by item the way Phase 188 measured the
client-link bullet, because a list of ten in one row is exactly the shape that
hid `comments/questions` being built for fourteen phases.

The first thing to look at is the block editor's existing drag-and-drop
ordering and Phase 186's `CropEditor`, which already does pointer-driven
geometry with handles. Snapping and guides are the same mechanism one level up.

Behind it: vector primitives, the last of the eight, which this phase has
quietly made nearer — `pdf/vector.ts` can already draw paths, and an `svg`
block that held markup would be the authoring surface for them.
