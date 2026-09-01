# 0080 — The comment that was doing the escaping

**Status:** accepted
**Date:** Phase 80
**Amends:** ADR 0079 (the palette), ADR 0074 (whose letter is it), ADR 0005 (marketing).

## The defect

ADR 0079 nominated this: widening a validator is the moment to check who else
trusted it. Phase 79 taught `parseColor` to accept three-digit hex because
`isHexColor` already did. So — who else read a brand value, and what had
`isHexColor` never promised?

`studio/service` refused any colour that was not plain hex, and said why:

> Colours land in a `style` attribute on client-facing pages, so anything that
> is not a plain hex value is refused rather than sanitized.

That is the correct rule, and it was **the whole defence**. The email renderer
interpolates brand values straight into `style="…"`:

```
<body style="margin:0;padding:0;background:#f8fafc;font-family:${brand.bodyFont};">
```

in a file whose own comment says *every author string passes through*
`escapeHtml`. Twenty-two interpolations of `brand.*`, none escaped, safe only
because of a guard three modules away that nothing asserted.

**And the guard did not cover the two fields beside the colours.**
`assertColors` named five; the renderer used seven. `headingFont` and `bodyFont`
were `z.string().trim().max(200)` in the action with no rule at all, so a body
font of `serif" onload="…` closes the attribute. A `<select>` in the Design
Center offers four stacks; a server action takes whatever is posted.

## What was and was not reachable

Stated plainly, because it changes what this is.

**Reachable today:** storing arbitrary two-hundred-character strings in
`heading_font` and `body_font`. Nothing validated them.

**Not reachable today:** the injection itself. `renderEmailHtml` has taken a
`brand` parameter since Phase 5 and **no caller has ever passed one**, so every
email rendered with the default. The break-out was a loaded gun whose safety was
that nobody had wired the trigger.

Which is the third finding, and the one worth the most:

## Decision 1: a campaign goes out in the company's own colours

That unwired parameter is a defect in its own right. A company sets its brand in
the Design Center, its proposals and its invoices use it, and **every marketing
campaign this application has ever sent went out in the default teal**. Phase 74
stopped a company's marketing going out under our name; this stops it going out
in our colours.

`sendStep` loads the default kit once per run — one row read for a send to four
thousand contacts, not four thousand — and `emailBrand()` maps it. The *body*
font stays the email stack rather than the kit's, deliberately: a document
renders in a browser that has `system-ui`, an email renders in Outlook, which
does not. That is the one place the two media are allowed to differ, and it is
now a named function with the reason on it rather than an omission.

Wiring that caller is what makes the guard load-bearing. So it is done in the
same phase, after the guard, not before.

## Decision 2: the rule is data, and it covers every field that needs it

`modules/design/style-values` holds `isHexColor` (moved out of the service, not
copied), a new `isFontStack`, and `BRAND_STYLE_FIELDS` — the registry of every
brand value that reaches a style attribute. `assertColors` becomes
`assertBrandStyle` and loops the registry, so the list and the set of fields
that need it cannot drift apart again, which is exactly how they drifted.

`isFontStack` is far narrower than CSS allows, on purpose. It is not a parser
trying to accept everything valid; it is a gate, and the population it must
admit is four stacks in a picker plus one email default. Letters, digits,
spaces, hyphens, and optional quotes around a family. A leading hyphen, because
`-apple-system` is real.

The rule lives in `modules/design` rather than in the service because the email
renderer, the PDF writer and the document page all need to know what a valid
brand value is, and none of them should import something that reads the database
to find out.

## Decision 3: the renderer escapes anyway

`styleValue()` wraps `escapeHtml` around every brand value the email renderer
interpolates. The validator should mean nothing ever needs it — that is the
point of a validator — but a promise made three modules away, enforced on a
write path that could gain a second one, is not what should stand between a
tenant's admin and the inbox of a stranger. Entities are decoded by the HTML
parser before the CSS is parsed, so `'Segoe UI'` still resolves with its quotes
escaped.

The test asserts the outcome rather than the guard: render with a hostile kit
the guard would never admit, and check the `<body>` tag has exactly two quote
characters. A third would mean the attribute closed early.

## Decision 4: the refusal reaches the person, and names what they can see

Found by the browser check rather than by a test, which is where the last three
phases have found their real defects.

`messageFor` denies by default — only a `DomainError` reaches the browser, and
everything else becomes a generic sentence. `assertColors` threw a bare `Error`.
So the message it had been throwing since Phase 4, worded for the person who hit
it, **had never once been shown to anybody**: the Design Center said *"Something
went wrong."* and let them guess. `BrandValueError` extends `DomainError`, and
the refusal now arrives intact.

And once it arrived, it was wrong in a second way: it named `headingFont`, a
column, beside a field the picker captions "Heading font". The registry carries
the caption, the component renders from the registry rather than from a fifth
written-out copy of the same five colour labels, and the test fails if the two
separate.

## A correction to ADR 0079

Phase 79 said the default brand kit was written out six times. It was **seven**.
`DEFAULT_EMAIL_BRAND` in `marketing/render-email` is the same three colours
again, missed because it is a different type in a different module and never
mentions `BrandTokens` — so the grep that found the other six went past it. Its
colours now come from `DEFAULT_BRAND_KIT`; its fonts stay its own, for the
reason in Decision 1.

## What this did not do

No schema change and no migration. Existing `heading_font` and `body_font` rows
are not swept: every one of them is a value the Design Center's own picker
produced, and a migration that rewrote a customer's stored font on the strength
of a validator added afterwards would be doing more than this phase can justify.
The gate is on the way in; a row that predates it is checked when it is next
saved.

The React document page is untouched. It puts brand values into a `style`
*object*, which React sets through the CSSOM — a malformed value is dropped, not
executed. Escaping there would be theatre.

## What the next phase might take

`safeUrl` in `modules/design/urls` is the same shape of promise, one field over:
a rule about what may be interpolated, relied on by two renderers, with the
argument in a comment. It guards `block.url`, and the email renderer wraps the
result in a tracking redirect that re-encodes it — so what `safeUrl` refuses and
what actually reaches an `href` after `${trackUrl}?u=${encodeURIComponent(url)}`
are two questions, and only the first one has been asked.
