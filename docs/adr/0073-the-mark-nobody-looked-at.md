# 0073 — The mark nobody looked at

**Status:** accepted
**Date:** Phase 73
**Amends:** ADR 0070 (the retheme), ADR 0008 (the PWA shell).

## The defect

Two of them, and the second is worse.

**One thing, five answers.** The application named itself in five places and no
two the same way:

| Where | What it drew |
| --- | --- |
| The rail | a lime square with "A+" typed into it, a wordmark, a bordered badge |
| Login | `<h1>Accountrix Plus</h1>` |
| Password reset | `<p>Accountrix Plus</p>` |
| Marketing header | `<span>Accountrix Plus</span>` |
| Marketing footer | `<span>Accountrix Plus</span>` |

That is the defect this codebase keeps removing. Phase 70 removed it from the
words for corrections — *one answer to four questions* — and this is the same
shape applied to the product's own name.

**The stale one.** `public/icons/icon.svg` was a **teal `#0d6e60`** rounded
square with a white letter A, and `manifest.webmanifest` painted its splash
screen and status bar the same teal. Both predate Phase 70's retheme by thirty
phases. So the icon on somebody's home screen, and the colour behind the
application while it loaded, belonged to a design this product stopped using
long ago.

Nobody noticed because **a favicon is the one part of an interface its builders
never look at.** It is on the tab behind the tab you are working in.

## Decision 1: the name and the mark are named data

`modules/brand/identity` holds the name, the suffix, the three colours and the
two paths. It is pure — no database, no clock — and it is where anything that
needs to say what this product is called or looks like goes to find out.

The colours are hex rather than the CSS custom properties they mirror, and that
is deliberate: two of the three consumers are not a stylesheet's audience. A
`.svg` served to a browser tab and a `.webmanifest` read by an operating system
have no `:root`, and a favicon that tried to resolve `var(--brand)` would render
as nothing at all.

## Decision 2: one logo component, two tones, one drawing

`components/logo.tsx` is now the only thing in the application that draws its
own name.

The **mark never changes between tones** — a lime ground carries its own
contrast, so it needs no light and dark variant. What changes is the wordmark
(ink on the workspace, white on the rail) and the badge's hairline. On white
that hairline is ink; on the rail it is `--chrome-line`, which Phase 70's
stylesheet already called *"the badge hairline"* — the token was waiting for
this.

The lime is type only inside its own outline, which is why the "PLUS" is a
badge rather than a word: lime at text weight on white is unreadable, the same
finding that made `.btn-primary` blue in Phase 70.

## Decision 3: the raster icons are generated, and a test stops them drifting

`scripts/render-brand-icons.mjs` renders the PNG sizes from the same geometry,
using Chromium as the rasteriser — nothing new is installed to draw four
squares, and Playwright is already how this project checks its own screens.

The script is a plain `.mjs` and cannot import a TypeScript module behind a
path alias, so it repeats the constants. That is exactly the defect this ADR is
about, reappearing one level down, and the honest mitigation is a test that
fails the moment the two copies disagree. `tests/brand-identity.test.ts` asserts
every colour, both paths and the corner radius against the script's source, and
asserts that the icon and manifest on disk carry the brand rather than the teal.

The maskable icon is full-bleed with the mark inset to the middle 80%, because
Android crops it to whatever shape the launcher uses and only that area is
guaranteed to survive. A round launcher gets a lime disc with the A+ centred,
rather than a rounded square with its corners shaved off.

## Decision 4: `/favicon.ico` exists

Found while verifying: every declared icon path returned 200 and
`/favicon.ico` returned **404 on every page load** — the one request no page
declares and every browser makes anyway.

An ICO is a six-byte header, one sixteen-byte directory entry and a payload,
and since Vista that payload may itself be a PNG. So the 32-pixel render is
wrapped rather than re-encoded into the old bitmap format, and the script emits
it alongside the rest.

## What this did not do

Nothing in the ledger, no migration, no schema. The invoice and proposal PDFs
still carry the *company's* brand kit rather than this one — a customer's
invoice is their document, and putting our mark on it would be the same
mistake as a template that assumes one industry.

## What the next phase might take

`modules/notify` writes "Accountrix Plus" into email subjects and bodies as a
literal, and `modules/pdf` writes it into the PDF `/Producer` field. Neither
reads `BRAND.full`. They are outside the browser so no test above catches them,
and they are the two places the product names itself to somebody who is not
looking at a screen.
