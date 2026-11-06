# 0191 — A block the client never sees

**Status:** accepted
**Date:** 2026-11-06
**Phase:** 191

---

## The row said ten things. The bullet says twelve.

ADR 0190 nominated **artboard affordances (§7)** and said the measurement
should come first, because ADR 0173's audit row is a list of ten in one cell —
*"No guides, rulers, snapping, grids, zoom, layers, grouping,
align/distribute, lock/hide, or designer undo/redo"* — and a list of ten in one
cell is exactly the shape that hid `comments/questions` being built for
fourteen phases.

Measured item by item, the way Phase 188 measured the client-link bullet. §7's
actual sentence is:

> Artboard/page system with multiple page sizes, guides, rulers, snapping,
> grids, zoom, layers, grouping, alignment/distribution, lock/hide, undo/redo.

Twelve things. The row names ten.

| | measured |
| --- | --- |
| artboard/page system | **built** — `design_documents` carries page size, orientation, four margins, a running header and footer, page numbering, and a `pageBreak` block |
| multiple page sizes | **built** — `pageSizeEnum` is letter, A4 and legal, each with both orientations |
| guides | nothing |
| rulers | nothing |
| snapping | nothing |
| grids | nothing |
| zoom | nothing |
| layers | the block list is the ordered object list; no visibility control |
| grouping | nothing. `columns` holds two or three text runs and forbids nesting |
| alignment/distribution | per-block `align` exists; distribution of objects does not |
| **lock/hide** | **nothing** |
| undo/redo | nothing in the designer. `undoLast` is bookkeeping's |

**The row understates the capability and overstates the gap**, in the same
cell. Two of the twelve are built and it names neither, which is worth saying
plainly: the row is not wrong about the eight it lists, but a reader taking it
as the measurement of §7's artboard bullet would start by building a page
system that has existed since Phase 4.

## Five of them are a decision somebody already made

Guides, rulers, snapping, grids and object distribution are not features this
engine is missing. They are properties of a document model it deliberately
does not have, and **ADR 0004 is titled after the decision**: *"A block
document engine, not a vector canvas."*

That ADR argued it from §7's own text — *"The first release should prioritize
business-document layout features; advanced Illustrator-class path editing can
be phased in after the core proposal workflow is stable"* — and from a
constraint the canvas cannot meet: one document has to render on a phone, in a
paginated PDF and in a marketing email, and absolute coordinates serve none of
those three at once. It named the extension point: *"a `canvas` block type is
the extension point when §7's advanced features are phased in."*

A declared limitation is exactly the thing this arc has twice found to be
stale — Phase 185's *"no images beyond a placeholder frame"* and Phase 188's
*"serves the snapshot, never a live render"* — so it was re-read rather than
quoted. It holds, and ADR 0004 set its own test for whether it holds: *"if
[Phase 5 marketing] requires changing the engine rather than only adding block
types, this ADR's central decision was wrong."* Phase 5 happened.
`render-email.ts` renders the same block union. The decision passed its own
test.

So those five are not this phase, and the honest thing is to stop calling them
a gap.

## `lock/hide` needs no canvas, and that is the phase

Hiding a block and locking one are properties of *a block in a document*. They
mean the same thing in a stack as on a canvas, and neither is built.

The case is ordinary: a section the author has written and is not ready to
send — an optional scope, a price breakdown held for the second meeting, a
clause legal has not signed off. Today that is deleted and retyped, or sent by
accident.

## The decision: where "who is looking at this" is answered

`parseBlocks` is the single door every block list in the application comes
through. Twenty-odd call sites, every surface among them. It is the obvious
place to drop a hidden block and it is **the wrong one**, because it serves
both audiences: the designer parses to show an author their document, and the
client page parses to show a client theirs. A filter there would hide the
block from the person who hid it.

So the audiences have to be told apart somewhere, and the danger is that
"somewhere" becomes "wherever each renderer remembered". That is not
hypothetical here. `BLOCK_SURFACES` exists, and its docstring records why:
**six of eight dispatches handle an unknown block silently.** A renderer that
forgot this flag would fail the same way — except that the block it shows is
one an author deliberately held back, and nobody is looking for it.

Three things carry the decision:

**`visibleBlocks` is the one filter**, named at each reader surface.

**`READER_SURFACES` counts them**, and it is a different register from
`BLOCK_SURFACES` because it asks a different question. That one asks *does
each block type reach each surface*, and a scan for a pattern answers it. This
one asks *does each surface skip a block the author hid*, which **no scan can
answer**: the absence of a block from an output is not a string anybody can
grep for. So the register is checked behaviourally — a hidden block carrying a
marker is rendered through every surface named, and the marker has to be
absent — and a test asserts the renderers and the register name the same four
keys, so a ninth surface fails a test rather than quietly showing held-back
content.

**`DocumentPage` takes a required `audience`.** It renders the client's page
*and* the designer's preview, so it is the one surface with two answers. The
prop has no default, and that is the mechanism: a defaulted prop would pick
one of the two for a caller that never considered the question. The compiler
named both call sites the moment it was added.

### The author sees what they held back

Only the author's preview reaches the hidden branch, and it has to. A
held-back block that simply vanished would look deleted and the author would
write it again. It renders greyed, behind the words *"Hidden — not sent to the
client"*, so the preview answers "what is in this document" and "what will the
client see" at the same time.

### Nothing is fetched for a block no reader sees

The PDF service and the client-link page filter before `teamForDocument`,
`assetSizes` and `imagesFor` run, not only before anything is drawn.

That is not what makes the output correct — the renderers already skip the
block, and Phase 185's `usedImages` records what was *placed* rather than what
was prepared, so a hidden picture's bytes never reach the file regardless.
That decision was made for a different reason and pays here.

It is filtered anyway because it keeps the claim to one sentence. "Nothing is
read for a block no reader sees" needs no second sentence explaining why the
thing that was read turned out to be harmless, and a claim that needs the
second sentence is the one that stops being true.

## The lock, and the clause that was nearly missing

A lock means content, existence **and position** — the three things the word
means everywhere else.

The first version covered content and existence only, with a tidy argument:
order is a property of the list, not of the block. That argument was wrong in
a way worth recording. **`applyLayoutSuggestion` only ever reorders.** Its own
comment says so — *"Reordered, never rewritten"* — so a lock permitting
reordering would have been inert against the single caller it most exists to
stop. Pinning a clause where legal put it is the best reason anyone has to
lock a block, and the first draft protected it from everything except the
Design Assistant. Phase 160's shape, caught by asking what the feature is for
rather than what it is.

Position is compared among the blocks **common to both lists**, which is what
keeps the rule usable: inserting a section above a locked clause is ordinary
editing, and so is deleting an unlocked block elsewhere. The consequence worth
stating is that dragging *another* block past a locked one is refused too —
deliberate rather than a side effect, because "this clause stays after the
scope" is what somebody locking a clause means.

### It is enforced on the save path, and it is not a permission

Enforced server-side in `saveDocument` and in `applyLayoutSuggestion`, not
only greyed out in the editor. A toggle only the editor respects is installed
and inert, and a browser tab left open from before the lock was set would save
straight over it.

And it is **a courtesy against a slip, not a permission**. Anybody who can
edit the document can unlock it; it costs an accident a deliberate act and
costs a deliberate act nothing. That is said in the docstring, in the ADR and
in a test, because a lock that looked like a permission would be worse than no
lock — somebody would rely on it to keep a colleague out, and it does not.

The editor withholds the field panel for a locked block rather than disabling
each input, because a form full of greyed boxes invites somebody to work out
which one still responds.

## Layers, answered rather than skipped

§7 says "layers", and the block list now is one. In a stack of flowing blocks
there is no z-order to manage, so what a layer panel is *for* — seeing every
object at once and turning one off without deleting it — is this list plus the
two toggles. Recorded here rather than claimed in the audit, because "layers"
in a canvas tool also means stacking order and this does not do that.

## What the registers reported

`registry-error`'s scan found its own drift, as designed: **39 throws became
40**, and the test named the number. `readerSurfaceFor` is the fortieth
registry lookup that refuses an undeclared key, and the comment beside the
count says what this one earns the throw on — the register is the list a test
iterates, so a key answering `undefined` would quietly shrink the set of
surfaces being checked.

The isolation scans did not move. No query was added this phase.

## What this does not do

**No undo/redo**, which is the twelfth item and the one most worth doing next.
It was measured and set aside rather than attempted: the designer holds blocks
in React state behind an explicit Save, so undo is a client-side history and
the interesting question — whether undo crosses a save — has a dull answer
here. Dull is not a reason to skip it; scope is. It is one coherent piece of
work and deserves to be that.

**No zoom and no grouping**, the other two that need no canvas. Zoom is a CSS
transform on the preview pane and is nearly free; grouping is not, because a
group is a container and the block union is deliberately flat — `columns`
forbids nesting, and ADR 0004's "a document is an ordered list" is what makes
one document render in three places.

**A run of hidden blocks repeats its label.** Two consecutive held-back
blocks each carry their own *"Hidden — not sent to the client"* rule, which is
noisier than an author thinks of them: they hid one section, and the preview
says it twice. Left as it is because the alternative is a renderer that knows
about runs, and because the per-block label is the honest one — hiding is per
block, and an author who unhides one of the two needs to see which is which.
Seen by rendering the preview and looking at it, not by any assertion.

**Hiding is not a review state.** There is no "pending approval", no record of
who hid a block or when, and a hidden block in a sent snapshot is simply
absent from what the client got. The audit trail records a `document.update`
with a block count and nothing finer. A clause that must be approved before it
can be sent is a workflow, and workflows are not flags.

**A hidden `pricingTable` hides the table, not the price.** Acceptance
recomputes the total server-side from the proposal's items, which is ADR
0004's decision 7 and is not negotiable — so hiding the block removes the
*presentation* of a total the client still signs for. Worth naming because it
is the one place where "the client does not see it" and "it does not apply"
come apart.

## Nominated for Phase 192

**Designer undo/redo (§7)**, the twelfth item of the artboard bullet and the
last of it that needs no canvas model.

The measurement is already done above, which is the point of having done it
item by item: of §7's twelve, two were built, five belong to a model ADR 0004
decided against, `lock/hide` is this phase, layers is answered, and zoom and
grouping are named above with their costs. Undo/redo is what is left, and
nothing about it is blocked.

The shape to look at first is `update(next: Block[])` in `designer.tsx` — a
single funnel every mutation already goes through, which is the thing that
makes a history stack cheap. The decision to make is what counts as one step:
every keystroke in a text field is not a step anybody wants to undo, and a
save is probably a boundary rather than a step.

After that, ADR 0173's eighth and last: **vector primitives**. Phase 190 moved
it closer than the audit's wording suggests — `pdf/vector.ts` draws paths on
paper and the page renders them already — so what remains is an authoring
surface, and whoever takes it should re-measure rather than inherit the row.
