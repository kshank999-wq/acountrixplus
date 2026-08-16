# ADR 0021 — A sent document never changes

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §18 ("server-side PDF generation and immutable
  proposal-version snapshots"), §7 ("PDF export, print-quality output …
  version history, and PDF download")
- **Builds on:** [ADR 0004](0004-document-engine-and-brand.md),
  [ADR 0020](0020-one-file-stored-once-reachable-only-through-a-record.md)

## Context

§18's list of infrastructure had one line left unbuilt: *"server-side PDF
generation and immutable proposal-version snapshots."* ADR 0004 deferred it
with a genuine choice — *"either a headless browser in the deployment or a
layout library re-implementing pagination the browser already does"* — and
shipped a print stylesheet instead, so a client's own Save as PDF produced a
correct file.

That was the right call then and it leaves two holes. A client's browser cannot
produce the *server's* copy, so nothing in the system knows what anybody
received. And `proposal_versions` snapshotted the *data* — titles, line items,
totals — while the brand kit, the block layout and the clause text stayed live.
A company that restyled its proposals in June silently restyled every proposal
it had ever sent.

Two claims, both asserted in `tests/pdf.test.ts`:

1. **The same input produces the same bytes.**
2. **What the client was sent never changes**, whatever happens to the brand
   kit, the wording or the price list afterwards.

## Part one: why a hand-written writer

### Decision 1: determinism decided it, and neither option in ADR 0004 was judged on that

The two options ADR 0004 weighed were about *effort*. The property that
actually settles the question is reproducibility, and it rules out the browser
outright: Chromium stamps a producer string and a wall-clock creation date into
every file it makes, and its text shaping changes between versions. Upgrading
the browser would silently rewrite the bytes of every historical document — and
the whole point of a snapshot is that its bytes are the evidence.

So the writer is a few hundred lines of PDF 1.4: a catalog, a page tree, one
uncompressed content stream per page, seven standard fonts, an info dictionary
and a cross-reference table. It reads no clock and uses no randomness. The
creation date is a *parameter*, all the way down to `writePdf` — and it is the
moment the proposal was sent, which is the honest value anyway.

The second-order benefits were not the reason but are worth naming: no headless
browser in the deployment, no 300 MB of Chromium in the image, no subprocess to
sandbox, and a file small enough to read in a text editor when something looks
wrong. That last one has already paid for itself twice.

### Decision 2: the standard 14 fonts, and no embedding

Every PDF viewer already has Helvetica, Times and Courier. Using them is what
keeps this a few hundred lines rather than a font toolchain — no `glyf`
parsing, no subsetting, no CMap.

The cost is real and visible: **a company's brand font does not reach the PDF.**
A brand kit naming `Georgia, serif` gets Times; anything else gets Helvetica.
The on-screen and print-stylesheet versions still use the real font, so the two
do not match exactly. That is the single biggest limitation of this phase and
it is in the consequences below rather than buried.

### Decision 3: WinAnsi, not ASCII folding

The first version folded typographic characters to ASCII, and the very first
rendered proposal came out titled "Reroofing -- North Wing". That is a visible
defect in a client-facing document.

It was also unnecessary. The font dictionaries declare `/WinAnsiEncoding`,
which is Windows-1252, and that has curly quotes, en and em dashes, the
ellipsis and the bullet in the 0x80–0x9F range where Latin-1 has control codes.
So those characters are emitted as *bytes*, with their own width entries — real
prose is full of them, and wrapping has to measure them correctly. Only
characters with no glyph at all fold, and the last resort is `?` rather than a
blank: something visibly wrong beats something invisibly missing.

### Decision 4: measure everything, then place

Each block reports its height before anything is drawn. A block that does not
fit moves whole; a paragraph taller than a page splits by line, because moving
a two-page paragraph whole would leave a blank page and overflow anyway. A
heading and a table header carry `keepWithNext`, so a section title cannot be
orphaned at the foot of a page.

Spacing between blocks is dropped when it would land at the top of a page —
otherwise a page starts an inch too low, which is the commonest way paginated
output looks amateur.

## Part two: the snapshot

### Decision 5: rendered inside the send transaction

`sendProposal` renders the PDF and files it against the version it just
created, in the same transaction. A proposal is therefore never recorded as
sent without the document that was sent.

Rendering afterwards on the Phase 10 queue was the obvious alternative and it
is wrong here: it leaves a window in which the version exists, the client has
the link, and the snapshot does not — which is precisely the window in which
somebody edits the price list. The render is a pure function over data already
in hand and takes milliseconds; there is nothing to defer.

One `sentAt` is computed once and used for the version row *and* stamped into
the file. Two calls to `new Date()` would differ by milliseconds and make the
bytes irreproducible.

### Decision 6: the digest is the proof, and Phase 20 supplies it

The bytes go into Phase 20's content-addressed store, so the evidence that
nothing changed is free: the file is named by its own SHA-256.

The two phases compose in a way worth recording. Sending the same unchanged
proposal twice within one second produces *byte-identical* files — the only
varying input is a timestamp with one-second resolution — so the store hands
back the same document to both versions. Two rows in `proposal_versions`, one
row in `documents`, one blob. A test asserts it.

### Decision 7: the public link serves the snapshot, never a live render

A client who opens their link a month after the price list moved downloads what
they were sent. The live record is reachable too, as an explicitly separate
function called `renderProposalPreview` — and the test that proves immutability
also asserts that the *preview* moves, because otherwise the first assertion
would be equally true of a renderer that ignored its inputs.

### Decision 8: a proposal with no document can still be sent

The CRM lets a proposal exist before anybody opens the designer. Refusing to
send it would be the wrong trade: the record of what was sent matters more than
the rendering of it. The version simply carries no PDF, the download is not
offered, and the workspace shows that version in grey.

### Decision 9: invoices are rendered, not snapshotted

An invoice is regenerated from the record every time. An invoice is not a
negotiating position — if it was wrong it gets credited and reissued, and the
*ledger* is the authority for what is owed. Snapshotting one would create a
second answer to "how much does this customer owe", which ADR 0002 spent a
whole phase refusing.

It is built from the same block model the designer uses rather than a second
layout engine, so there is one place to fix when a page break is wrong.

## Consequences

- **Brand fonts do not reach the PDF.** Serif stacks become Times, everything
  else becomes Helvetica. The web and print-stylesheet versions use the real
  font, so a company comparing the two will see a difference.
- **Images are placeholders.** An image or video block renders a labelled frame,
  not the picture — embedding raster data means decoding PNG and JPEG and
  writing image XObjects, which is a phase of its own. A logo does not appear on
  the PDF cover. This is deliberately visible rather than silently blank.
- **QR codes are placeholders too**, for the same reason, even though the SVG
  already exists on the web version.
- **No hyperlinks.** A button block writes its URL out as text, which is right
  in print and worse than the web version on screen. Link annotations are not
  written.
- **Streams are uncompressed**, so files are perhaps three times larger than
  they need to be. For a few kilobytes of text that is a good trade for being
  able to read the file; for a document with many pages it stops being one.
- **No accessibility structure.** No tagged PDF, no reading order, no alt text.
  A screen reader gets the text in drawing order, which is usually right and is
  not guaranteed to be.
- **The layout engine is not the browser's.** Justification, hyphenation,
  widow/orphan control beyond `keepWithNext`, right-to-left text and vertical
  centring are all absent. Business documents survive this; a designed one-sheet
  may not.
- **Only the standard Latin range renders.** Anything outside Windows-1252 —
  Greek, Cyrillic, CJK, most accented characters beyond the common ones —
  becomes `?`. For a product that will eventually be sold outside the
  English-speaking world this is the limitation that forces font embedding.
- **The snapshot is not signed.** It proves what the *system* rendered, and the
  digest is recorded in the audit log — but nothing external timestamps or
  countersigns it, so it is evidence of a system's own record rather than a
  notarised document.
- **Older sent versions have no PDF.** Anything sent before this phase, and
  anything sent before its design document existed, shows in the history
  greyed out. There is deliberately no backfill: rendering today's document and
  calling it the March file would be a lie of exactly the kind this phase
  exists to prevent.

## Follow-up

1. **Embed a subset font**, which unblocks brand fonts and non-Latin text at
   once. The largest single improvement available here.
2. **Embed images**, starting with the logo on a cover block.
3. **Link annotations**, so a button and an emailed URL work on screen.
4. **Compress content streams** once documents grow past a few pages.
5. **Tagged PDF** for accessibility.
6. **Statement and report PDFs** — the writer is general enough, and customer
   statements are the obvious next document.
