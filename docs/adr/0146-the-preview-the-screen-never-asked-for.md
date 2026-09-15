# 0146 — The preview the screen never asked for

**Status:** accepted
**Date:** 2026-09-15
**Phase:** 146

---

## How this was found

ADR 0145 nominated the wiring pass, which the staging instruction still rules
out, so the nomination was treated as a claim about what is left and the phase
was derived by measuring.

The first measurement was of **my own last phase**. `SPLIT_SITES` is five entries
chosen by hand out of thirty-five division sites, and ADR 0145 argued for
declaring rather than scanning. ADR 0134's rule is that a declaration which
*excuses* a site is worse than one that misses it, so the scan was built to check
the five.

It found something better on the way past. Writing a proportional-share scan
produced **sixteen sites and zero inside a loop** — and `prorate`, the canonical
split, was not among them, because its weight is `weights[index]` and brackets do
not match an operand pattern built for dotted names. My own new scan was reach-
limited on its first run, which is the eighth time this project has found that
shape and is recorded here rather than shipped as a result.

Of the sixteen, one was on a screen:

```
src/app/jobs/[id]/panels.tsx:685   BillingPanel   (item.scheduledValueCents * bp) / 10_000
src/modules/jobs/billing.ts:239    priceApplication (item.scheduledValueCents * line.percentCompleteBp) / 10_000
```

The same arithmetic in two places, one of them a browser.

## The defect

`priceApplication` carries this, and has since it was written:

> Separated from `createProgressBilling` so the UI can show the person what they
> are about to bill, and so the arithmetic — the part worth testing — is
> reachable without writing to the database.

**The UI does not call it.** Measured: `priceApplication` has exactly one caller
in `src/`, and it is `createProgressBilling`. There is no action wrapping it.
The screen it was separated out for works the three figures out again in a
`useMemo`, and the two do not agree:

| | screen | service |
| --- | --- | --- |
| line billed backwards | `Math.max(0, …)` — contributes 0 | refuses the application |
| beyond the scheduled value | no check — previews the excess | refuses the application |
| percent above 100% | no bound | refuses the application |
| retainage above 100% | no bound | refuses the application |

So the preview shows a total, somebody clicks, and the server refuses. The clamp
is the worst of the four: a line billed backwards contributes **nothing** to the
preview, so the figure looks ordinary and is not the figure anybody will be
invoiced. Measured on the fixture in the test — item 02 dropped from 50% to 20%
with $2,500 already billed — the screen shows $2,000 and the service refuses the
document.

This is ADR 0110's shape once more, a phase after Phase 145 found the same thing
in `taxOn`: **a declaration argued from a fact that is not a fact.** Underneath
it is Phase 49's rule, and this is the sharpest instance of it the project has
had — not a function nobody happened to call, but a function *written for a
caller that went and did it again itself*.

## Why wiring the screen to the existing function would not have been enough

`priceApplication` **throws on the first bad line**. That is right for a commit
and useless for a preview: somebody filling in twelve items wants to see all
twelve problems, not to fix one, click, and be told about the next.

So the core does not simply move the arithmetic. It changes one thing:

- every rule and every sentence lives in `priceApplicationLines`;
- problems come back as a **list** beside the figures, keyed to the item;
- a preview renders the list, a commit refuses when it is not empty.

`willPost(priced)` is a named predicate rather than `problems.length === 0`
written at two call sites, because a preview and a commit agreeing about a name
is easier than two people agreeing about an expression they wrote separately —
which is the fault the module exists to end.

## The sentences were moved, not restated

The five refusals are the service's own wording, character for character, and a
test asserts that each still appears in `billing.ts`. If the service's wording
changes and the core's does not, somebody meets two different sentences for one
refusal — the same fault reappearing in the prose rather than the arithmetic.

## What the measurement said about the rest of the screens

Worth recording, because the answer was *not* a sprawl. Measured across
`src/app`: **23 client files do money arithmetic at 46 sites.** Reading them, all
but one are either a display sum over figures the server already computed, or a
single operation that matches the service exactly — a drawer's over-and-short is
`counted − expected` on both sides; a deposit's net is `gross − fee`.

Two are better than that and are worth naming as the pattern:

- `invoices/board.tsx` asks the server for the conversion rather than working it
  out, saying so in a comment: *"the arithmetic has to be the posting's own"*.
- `payables/board.tsx` **defaults** its amount to what fits, with a comment that
  the refusals exist in the service and defaulting sensibly means nobody meets
  them. Avoiding a refusal is the right way for a screen to handle one.

`BillingPanel` is the outlier because it does the opposite: it *hides* a refusal
by clamping past it.

## What this does not do

**It repairs nothing.** `priceApplication` still throws on the first line and
`BillingPanel` still works the figures out for itself; a test asserts both, so
the register entry cannot go stale unnoticed.

**It does not cover the screen half automatically.** `BillingPanel` is a React
component and this suite has no browser. What holds that side is a transcription
of the panel's own `useMemo` kept in the test — the device ADR 0140 used for the
broken symbol reader — which fails when the two rules disagree. A transcription
is a copy and copies rot; that is an argument for wiring it, not for pretending
the coverage is something it is not.

**It does not build the division scan it set out to build.** The scan was written,
was reach-limited on its first run, and found one thing worth more than itself.
`SPLIT_SITES` is still five declared entries with nothing measuring the extent,
and that is still outstanding.

## What is nominated next

Two candidates, both measured rather than guessed.

**The division scan, properly.** The one written for this phase missed `prorate`
— the canonical split — because of a bracket. A scan whose first run cannot see
the function the registry was built around is not evidence about the other
thirty-four sites, and `SPLIT_SITES` is still declared rather than held to
anything.

**The wiring pass**, which is now seven entries over eleven targets, five blocked
by nothing, each naming a skipped acceptance test — and, with this phase, the
first entry that names a screen.
