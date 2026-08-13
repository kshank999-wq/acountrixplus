# ADR 0004 — A block document engine, not a vector canvas

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §7 (proposal designer), §8 (shared creative studio), §15 (Company Studio), §18 (PDF generation), §20 (Phase 4)
- **Builds on:** [ADR 0003](0003-crm-and-public-intake.md)

## Context

Spec §7 describes "a powerful browser-based vector/layout environment inspired
by professional design tools" — artboards, paths, gradients, transforms. It
also, in the same section, says this:

> The first release should prioritize business-document layout features;
> advanced Illustrator-class path editing can be phased in after the core
> proposal workflow is stable.

Spec §8 adds a second constraint: the same engine must produce marketing
collateral in Phase 5. ADR 0003's follow-up noted that the engine's boundaries
would matter more than the first template built on it.

## Decisions

### 1. A document is an ordered list of blocks that flow down a page

Not a canvas of absolutely-positioned shapes. Each block is a typed record —
`heading`, `text`, `list`, `keyValue`, `pricingTable`, `image`, `columns`,
`clause`, `signature`, `divider`, `spacer`, `pageBreak` — validated by a Zod
discriminated union.

This follows §7's own instruction, and it is what makes one document render
correctly in three places that a free canvas cannot serve at once:

| Surface | Why flow layout wins |
| --- | --- |
| A client's phone | Blocks reflow; absolute coordinates do not |
| A printed PDF | Content paginates with real page breaks and no orphaned headings |
| A marketing email (Phase 5) | Table-and-block structure is what email clients render |

The cost is real and worth naming: you cannot place a logo at an arbitrary
x/y, overlap elements, or draw a bezier. Those need a second, canvas-backed
block type — a natural extension, since the block union is open — rather than a
rewrite.

**Blocks are JSONB, not rows.** A document is always read and written whole,
and storing it as one value makes an immutable snapshot on send a single copy
rather than a fan-out.

### 2. Reading is forgiving, saving is strict

`parseBlocks` drops anything malformed; `validateBlocks` refuses the whole save
and reports which block failed.

The asymmetry is deliberate. On a client-facing page a document missing one
block beats a document that throws. On the save path, silently discarding
something the author just typed would be far worse than an error message.

### 3. The engine knows nothing about proposals

`design_documents` has a `kind` and an optional owner reference; the block
definitions carry a `kinds` list. `pricingTable` and `signature` are marked
proposal-only, so Phase 5 marketing gets the same palette minus those two, and
a flyer can never grow a fee table.

Merge-field resolution is a pure function over a flat `Record<string, string>`.
Whoever builds the context decides what is in it — proposals supply client and
pricing data, marketing will supply campaign data, and the resolver does not
change.

### 4. Merge fields render blank, and warn the author separately

An unresolved `{{client.name}}` renders as nothing. Leaving the raw syntax
visible on a page a client is reading is the worse failure.

But silence would hide a mistake, so `unresolvedInBlocks` reports every field
the context cannot fill and the designer shows them as a warning before the
proposal is sent. The author finds out, not the client.

### 5. Brand values are CSS custom properties, and hex-validated

The renderer sets `--doc-primary` and friends on the document wrapper. One
document renders under a different brand kit without touching its content, and
Phase 5 gets the same mechanism for free.

Those values land in a `style` attribute on a public page, so `createBrandKit`
rejects anything that is not a plain 3- or 6-digit hex colour rather than
attempting to sanitize it. **SVG uploads are refused** for the same reason: SVG
can carry script, and these files are served back to browsers on unauthenticated
proposal pages.

### 6. Print CSS, not server-side PDF

Spec §18 asks for server-side PDF generation. That is **not built**.

Adding it means either a headless browser in the deployment (heavy, and a
sandbox to operate) or a PDF layout library that would have to re-implement
pagination the browser already does correctly. Neither is justified before the
document model has settled.

What exists instead is a real print stylesheet — `@page` size and margins,
`break-before`/`break-inside` control, `orphans`/`widows`, and
`print-color-adjust` so brand colours survive — so the browser's own
Print → Save as PDF produces a properly paginated, print-ready file. The
interactive acceptance form is hidden in print media and replaced by ruled
signature lines for a wet signature.

When server-side generation is built, it renders the same components; this is a
gap in delivery, not in the model.

### 7. Acceptance recomputes the total server-side

The third public write path. Same posture as lead intake, with one rule above
all others: **the accepted total is recomputed from the optional items the
client selected**, never taken from the request. It is the number the company
will invoice against.

Also enforced: the typed signature must match the entered name; item ids that
belong to another proposal are ignored; a unique constraint on `proposalId`
makes double-acceptance impossible under concurrency rather than relying on a
status check; and the accepted total, the selected items, and the exact
`proposalVersionId` the client was shown are all recorded.

Acceptance closes the deal from **any open stage**. An earlier version matched
one exact stage, which meant accepting a proposal for a deal in negotiation
closed the proposal and quietly left the opportunity open. Restricting to open
stages keeps it forward-only without being brittle.

### 8. Clauses version; documents copy the wording in

`clauses` is the stable identity, `clause_versions` holds the wording. A clause
block stores the version id *and* a copy of the text. The copy means the block
still renders if a lookup fails, and it means revising a standard term never
changes a proposal a client is already reading.

## Consequences

- No arbitrary positioning, layering, or path editing. A `canvas` block type is
  the extension point when §7's advanced features are phased in.
- Assets live in Postgres through the default `AssetStore` adapter. Fine for
  logos; not what should hold receipt scans at volume. Object storage is one
  adapter away, which is why `storageProvider` is on the row.
- Rich text is plain text with paragraph breaks. Bold and links inside a
  paragraph need either a constrained inline format or a richer block, and both
  deserve their own decision.
- A document's brand kit is captured at composition. Changing the kit does not
  restyle existing documents — arguably right for sent proposals, arguably
  surprising for drafts.
- Comments and questions on a proposal (spec §7) are not built. The acceptance
  endpoint is the model to copy when they are.

## Follow-up

Phase 5 is marketing. It should reuse `design_documents` with `kind:
'marketing'` and the same block palette minus the proposal-only types — if that
requires changing the engine rather than only adding block types, this ADR's
central decision was wrong and should be revisited then.
