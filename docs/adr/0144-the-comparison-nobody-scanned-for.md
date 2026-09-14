# 0144 — The comparison nobody scanned for

**Status:** accepted
**Date:** 2026-09-14
**Phase:** 144

---

## How this was found

ADR 0143 nominated it, and the nomination came with a measurement rather than a
hunch: **63 money-versus-money comparisons in `src/modules`, 30 in files that
read a currency-bearing table, across 23 functions** — and nothing scans any of
them.

The argument for building it is two defects, found by hand, four phases apart:

```
Phase 138  applyDeposit     input.amountCents > position.heldCents
Phase 142  redeemGiftCard   redeemFor(card.balanceCents, bill.balanceCents)
```

Phase 122 built a tripwire for money being **added** and Phase 123 gave it a
registry of forms, because *"it reads the source"* turned out to mean *"it reads
one syntactic form"*. Nothing was ever built for money being **compared**, and
`€500 > $500` is as meaningless as `€500 + $500`.

## Four forms, and the fourth is the one that mattered

The first three are what anybody would write down: a relational operator,
`Math.min`/`Math.max`, an equality. Between them they reach `applyDeposit`.

They do **not** reach `redeemGiftCard` — the defect that motivated the phase.
Its comparison is `Math.min(balanceCents, dueCents)` inside `redeemFor`, a pure
helper in `appointments/split.ts`, over two bare parameters. That file reads no
currency-bearing table, so the narrowing excludes it; the comparison is in one
place and the two currencies arrive from another.

So the fourth form is the call itself:

> **A helper handed two money amounts cannot know whether they are comparable.**
> It has to be told, or its callers have to be checked.

`spends` (Phase 138) and `affords` (Phase 142) take a `documentCurrency` and a
`homeCurrency` and say so in their refusals. `redeemFor` and `releaseFor` take
two bare numbers.

Writing the three obvious forms and stopping would have produced a scan that
missed the defect it was built for — which is ADR 0123's lesson exactly, a
registry later.

## Five reasons two amounts can be compared

The ground is declared per site and the facts are measured, which is the split
ADR 0141 settled for `DOMESTIC_GROUNDS`: the half that could *excuse* a site is
the half that has to be checkable.

| reason | count | what it means |
| --- | --- | --- |
| `home-money` | 7 | neither side carries a currency — a till, a gift-card balance, a fund, an inventory valuation |
| `same-row` | 6 | both operands come off one row, and one row has one currency |
| `inherited` | 5 | one row was created carrying the other's currency: a checkout takes the invoice's, a credit note takes the document's it reverses |
| `refused-upstream` | 2 | a guard refused a mismatch before the comparison ran — `applyCreditWithin` calls `creditableAgainst` and throws first |
| `blind` | 3 | not known comparable, and wrong today |

`inherited` is the one I did not expect to need. `postCapturedCheckout` caps a
capture at `Math.min(checkout.grossCents, invoice.balanceCents)` — two rows, so
not `same-row`; no refusal, so not `refused-upstream`. It is sound because
`createCheckout` writes `currency: row.invoice.currency`. Two rows, one currency,
guaranteed when the second was written.

## What it found: three, and every one already known

This is the part that matters for whether the scan works.

A new tripwire that announces three defects nobody has heard of is a tripwire
nobody can check. This one disagrees on its first run — Phase 121's rule — and
what it disagrees about is **three defects already found by hand over five
phases**, each already on a register:

| site | tracked in |
| --- | --- |
| `applyDeposit` | `PENDING_WIRING` — `spends` → `applyDeposit` |
| `redeemGiftCard` | `PENDING_WIRING` — `affords` → `redeemGiftCard` |
| `contractorPayments` | `BLIND_FACE_SUMS` — Phase 143 |

Zero new findings, and that is the result rather than a disappointment: the scan
independently rediscovered every comparison defect this project has ever found,
and nothing else.

`contractorPayments` is now caught from both ends — Phase 143 registered the
**sum** of `payment_applications.amount_cents`, and this registers the
**comparison** of that sum against a statutory threshold. One defect, two
tripwires, which is what it looks like when the coverage finally overlaps.

## The two siblings, which is why this is per-site

`applyDeposit` and `refundDeposit` contain the **same expression**:

```ts
input.amountCents > position.heldCents
```

One is wrong and one is not. Refunding hands a tenant back money the business is
holding — both sides are the company's own and no document is involved. Applying
it puts that money against an **invoice**, which may be in any currency at all.

A per-file or per-expression rule would have to call them the same. The registry
is per site because the question is about what the two amounts *are*, not about
how the comparison is written.

## And a rule the scanners were missing

The first run of this scan reported three extra sites, all in registries:
`LEDGER_POSTINGS`, `PENDING_WIRING` and `integrity/register.ts` quote real
comparisons inside their `because` and `liveDefect` prose. One of them was **the
entry this phase itself wrote** about `redeemGiftCard`.

Phase 141 established that a posting site is code and a sentence about one is
not, and blanked comments. **String literals are the other half**, and this is
what found it: a registry's prose is not a site, whichever way it is quoted.
`money-addition` and `comparable-sums` solve their own version by excluding the
file that declares the patterns, which is still right for `looksLike` examples —
but it does nothing about one registry quoting the code another describes.

## What this does not do

**It does not repair anything.** All three blind sites are live, and all three
were already registered before this phase started.

**It does not cover comparison in SQL.** A `WHERE amount_cents > ?` is compared
by the database, and the bound value's currency is a different question from the
one this asks. Declared out of scope rather than silently missed: `eq`, `gte`
and `lte` are excluded by name.

**It does not claim the narrowing is right.** A comparison in a file that reads
no currency-bearing table is unscanned, which is exactly how `redeemFor` escaped
the first three forms. The fourth form covers that case *from the call site*, not
from the helper — so a helper called only from unscanned files is still invisible.

## What is nominated next

Nothing was found, for the second phase running. Six registries now cover
posting, banking, addition, screens, grounds and comparison, and the last two
phases of scanning have produced no defect that was not already on a register.

That is the signal the staging pass asked for: the cores are in place, the scans
overlap, and what is outstanding is written down. **The wiring pass is the next
piece of work** — four entries on `PENDING_WIRING` blocked by nothing, three
registered sums, each with a skipped acceptance test that says when it is done.
