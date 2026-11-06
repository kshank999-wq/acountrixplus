# 0192 — The editor that forgot

**Status:** accepted
**Date:** 2026-11-06
**Phase:** 192

---

## The nomination held. Measuring found something else first.

ADR 0191 nominated **designer undo/redo (§7)**, the last item of the artboard
bullet needing no canvas model, and said nothing about it was blocked.

Measuring before building found two things that were, and neither was undo.

## The application did not build, and had not for eight phases

`npm run build` failed from **Phase 183 to Phase 192** on four lines that named
Node built-ins and not the import that reached for them:

```
Module not found: Can't resolve 'fs' / 'net' / 'tls' / 'perf_hooks'
```

One edge caused it. Phase 183 gave `document-render.tsx` — the renderer the
client designer and the client-facing page share — a **value** import of
`selectTeam` from `modules/studio/team.ts`, which imports `@/db`, which imports
`postgres`, which needs Node's sockets. Everything behind that edge was pulled
toward the browser: the schema, the query builder, the driver.

Measured rather than inferred. A worktree at Phase 189 was checked out and
built, and failed identically; `git log -S` dates the import to `1353aa5`.

### Why nine phases of this process walked past it

Every phase ran `tsc --noEmit` and `vitest`, and **neither bundles for a
browser**. A type-only question cannot see a server/client boundary, and a Node
test runner has `fs`. `.github/workflows/ci.yml` runs `npm run build` and would
have said so on the first push; nothing in the inner loop did.

That is the finding under the finding, and it is about the loop rather than the
code: every phase since 183 verified the thing it changed and the suite around
it, and none of them verified that the application still assembles. The habit
that has paid repeatedly here — *render it and look at it* — was applied to
PDFs and never to the product.

### The fix is a split, and it is load-bearing

The pure half of `team` — `selectTeam`, `teamIdsInBlocks`,
`RenderedTeamMember` — moves to `team-render.ts`, which imports one type and
nothing else. `team.ts` re-exports it, so every existing importer is unchanged.

A module a client component imports has to be one that **cannot** reach the
database, and the way to guarantee that is for it not to import it: a property
of a file rather than a promise in a comment.

### And a scan, because the build is the step that gets skipped

`modules/source/client-bundle.ts` walks the import graph from every
`'use client'` file and refuses any path to server-only code. Same argument as
`isolation-scan`: the tree is the thing that can be wrong, so measure the tree,
in the suite, in milliseconds. The build remains the authority — it catches
what a scan cannot — but it takes tens of seconds and names the symptom, while
this names the chain:

```
designer.tsx -> document-page.tsx -> document-render.tsx
  -> modules/studio/team.ts -> db/index.ts -> postgres
```

**The subtlety that makes it usable:** a `'use server'` file is a *boundary,
not a dependency*. The bundler replaces its exports with RPC stubs, so a client
component may freely import a server action. A first version missed that and
reported **93** leaks where there is one — worse than no scan, because a check
that cries wolf is a check somebody turns off. `import type`, and a clause
whose every specifier is `type`, are skipped for the same reason: `designer.tsx`
imports `RenderedTeamMember` as a type and always shipped nothing.

## The editor was ignoring the server

With the build fixed, the probe this phase set out to run could finally run:
drive the designer in a real browser and watch what undo would have to coexist
with.

`useState(initialBlocks)` never re-reads its prop. Applying a template or
accepting an AI layout suggestion wrote the server and called
`router.refresh()`, which re-renders the server component and **does not reseed
client state**. Measured against the database:

| | state |
| --- | --- |
| before | 17 blocks |
| author applies a template | **13 on the server, 17 still on screen** |
| author makes any edit and saves | **17 blocks — the template is gone** |

So §7's template gallery and §11's Design Assistant were both inert in the same
way, and worse than inert: accepting a suggestion is what undid it. Neither
had a test, because neither module is wrong — the defect lives in the seam
between a server action and a client component, which is exactly where this
codebase's tests do not look.

## The decision: one reducer owns the block list

The two problems are one question — **what are the legal transitions of the
editor's block list?** A history that did not know about a server replacement
would undo straight past it; a server replacement that did not go through the
history would be the same dropped update in a new place.

`modules/design/history.ts` is the single answer, with five actions: `edit`,
`replace`, `undo`, `redo`, `saved`. `designer.tsx` holds no block state of its
own.

### A server replacement is an ordinary entry

`replace` pushes what the server wrote and moves the saved marker to it. So
applying a template can be **undone** — which is when anybody reaches for undo,
because *"Applying a template replaces everything in this document"* is a
warning people read just after clicking — and the undone state correctly shows
as unsaved, since saving is how it would be kept.

The action returns the blocks it wrote. The client could not have fixed this
alone: re-reading the prop would clobber unsaved edits on every refresh, and
remounting would lose the selection. Only the action knows the document was
replaced *and* by what.

### What counts as one step, and why it is inferred

Every keystroke in the block editor calls `onChange`, so without coalescing a
sentence would be forty undos. Two conditions, and it needs both: consecutive
edits merge only while they touch **the same field of the same block**, and
only within a second. The first handles moving between fields; the second
handles typing, stopping to think, and typing again in the same box.

Which field changed is **inferred** from the before and after rather than
labelled by the caller. A tag each `update()` site had to pass would be a thing
a new call site forgets, which is the finding `BLOCK_SURFACES` exists because
of. Inference costs one comparison and covers call sites nobody has written.

Structural changes — add, delete, reorder, hide, lock — never coalesce. Each is
one deliberate act and should cost one undo.

### The clock is an argument

`reduceHistory` reads no clock; every timestamp arrives on the action. Same
decision `writePdf` makes about `createdAt` and for the same reason: a reducer
that called `Date.now()` is a reducer no test can pin, and the coalescing rule
is the part most worth pinning.

### `dirty` stops being a guess

The old boolean was set by any edit and cleared only by a save, so typing a
character and deleting it left the document unsaved forever — and that flag
gates the Design Assistant's button, so a no-op edit disabled the assistant
until somebody saved nothing. `isDirty` is now `savedAt !== at`: undoing back to
the saved state genuinely clears it, verified in the browser.

One bug found by reading that interaction rather than by a test: a save
followed by a keystroke in the same field within the coalescing window would
merge into the entry the server holds, leaving the button saying "Saved" over
unsaved work. A save now clears the coalescing key, and has a test.

## Two things seen only by opening the page

**The lock glyphs were unreadable.** Phase 191 shipped 🔓 for unlocked and 🔒
for locked, which is correct and illegible: at the size these render, an open
padlock and a closed one are the same yellow blob, so a row of unlocked blocks
looked like a row of locked ones. Both toggles are now muted when off, so the
set state is the one that stands out.

**The undo and redo buttons belong beside the editing controls**, not in a
menu, because the question they answer — "I did not mean that" — is answered by
having seen them before doing it.

## What this does not do

**No navigation guard.** Closing the tab still loses unsaved work silently, and
that is more galling now than it was, because an editor with undo invites
somebody to trust it. Named rather than fixed: it is a different change, and a
history that outlived the page would be a second copy of the document competing
with the server's.

**The keyboard shortcut does not fire inside a text field.** The browser's own
undo is better there — it knows the caret — and taking Ctrl+Z away from a
half-typed sentence to undo a whole block is the wrong trade. Structural undo is
for when you are not typing.

**Undo is not the audit log's undo.** `audit_events` has carried `isUndo`,
`undoneByEventId` and `batchId` since Phase 3, and `undoLast` uses them to
reverse a *committed* bookkeeping action by restoring the `before` snapshot
recorded on the event. It cannot serve this: `document.update` records a block
*count*, not the blocks, so there is nothing to restore from. Making it
undoable would mean copying every document into the audit log on every save,
which is a second copy of the thing `design_documents` already holds. Two
different features that share a word.

**The scan cannot see a dynamic import or a re-export through a package.** It
reads `import ... from` and nothing else, which covers this codebase and would
not cover one using `require` or `await import()` for the same purpose. The
build still would.

## Nominated for Phase 193

**Vector primitives (§7)** — the eighth and last of ADR 0173's capabilities,
and the row most in need of re-measuring before anything is built against it.

The audit says *"No lines, rectangles, ellipses, paths, fills, strokes,
gradients, shadows, corner controls or transforms. The engine is 18 block
types."* That was true when written and Phase 190 changed the ground under it:
`pdf/vector.ts` already draws paths, rectangles, ellipses, fills, strokes and
transforms on paper, and the page already renders them, because an imported SVG
is exactly those things. What is missing is an **authoring surface**, not a
renderer — which is a different and smaller piece of work than the row
describes.

ADR 0004 named the extension point for it in Phase 4: *"a `canvas` block type
is the extension point when §7's advanced features are phased in."* Whether
that is still the right shape is the decision to make, and it should be made by
measuring what `pdf/vector.ts` and `design/svg.ts` can already express rather
than from the row.

Behind it, with nothing left of ADR 0173's eight: §7's artboard zoom and
grouping, both named with their costs in ADR 0191.
