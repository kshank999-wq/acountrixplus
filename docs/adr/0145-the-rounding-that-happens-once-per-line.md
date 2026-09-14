# 0145 — The rounding that happens once per line

**Status:** accepted
**Date:** 2026-09-14
**Phase:** 145

---

## How this was found

ADR 0144 nominated the wiring pass. That is right about the sequence and wrong
about now — the staging instruction is to get everything in place and hook it up
afterwards — so the nomination was treated as a claim about what is left rather
than an instruction, and the phase was derived by measuring instead.

Six registries now cover money being **posted**, **banked**, **added**, **shown**,
**grounded** and **compared**. The gap is the arithmetic that is none of those:
money **divided**. Measured in `src/modules`: **140 roundings, 35 sites where a
cents amount is multiplied or divided, across 26 files.**

Most of those are a rate applied to a base — tax on a taxable amount, a markup on
a cost, a commission on a service — where nothing has to add back to anything.
The ones that matter are where a **whole exists first** and the parts must
reproduce it. Four places in this codebase already solve that, each with its own
implementation and its own paragraph explaining the same insight:

```
prorate        ledger/cash-basis.ts     last weight takes what is left
scaleSigned    ledger/cash-basis.ts     the same, in signed cents
consume        inventory/costing.ts     two clamps — last lot touched, and emptied lots
splitFor       appointments/split.ts    reports the residue rather than placing it
```

Four copies of one rule is ADR 0116's shape and ADR 0140's finding. The fifth
place is where this phase starts.

## The defect

`taxOn` in `sales-tax.ts` has carried this sentence since it was written:

> Pure, and rounded **once on the total** rather than per line. Rounding each
> line and adding them up drifts by up to half a cent per line, and a return that
> does not foot against the invoices behind it is a return somebody has to
> reconcile by hand.

Its only pricing caller rounds each line and adds them up:

```ts
taxCents: line.taxCents ?? taxOn(line.taxableCents, code.rateBp)   // inside a .map
totalCents: priced.reduce((sum, line) => sum + line.taxCents, 0)
```

That is ADR 0110's shape exactly — **a declaration argued from a fact that is not
a fact**. The sentence is right about the arithmetic and wrong about the code
underneath it, and it has been read as a guarantee by everything written since.

Three lines of $10.00, $20.00 and $33.33 under one 8.25% code round to 83, 165
and 275 cents. The code's own base of $63.33 gives **522**. The invoice charges
**523** — so the document the customer receives shows, under a named
jurisdiction, a tax that is not its own printed base times its own printed rate.
`recordDocumentTax` stores those per-line figures as the breakdown and
`salesTaxReturn` sums them, so the return inherits it.

Measured over sets of lines under one code at 8.25%, three hundred sets at each
size:

| lines | worst drift | sets where the total does not foot |
| --- | --- | --- |
| 50 | 7c | 249 / 300 |
| 400 | 19c | 279 / 300 |
| 2,000 | 50c | 292 / 300 |
| 10,000 | 75c | 300 / 300 |

The amounts are small and that is not the point. Tax on a document is checked by
recomputing it from the base, and a document that fails that check is queried
whatever the size of the difference — at which point the business has to explain
a number it cannot derive, because the figure came from a hundred separate
roundings that are not written down anywhere.

## Why "round once on the total" is not the repair

It is what the sentence literally asks for and it cannot be done. A document's
lines may carry **different tax codes**, and a return reports **per
jurisdiction**. A single document-wide rounding leaves no per-code figure to
report, and splitting one rounded number back out by code is the same problem
moved up a level.

The rule that holds is narrower: **round once per code, on that code's own base,
and split the rounded figure back across the lines it came from.** Then the lines
sum to the code, the code is `round(base × rate)`, and the codes sum to the
document.

## What this does not fix, and cannot

A return aggregates many documents, and `round(a × r) + round(b × r)` is not
`round((a + b) × r)` however each document was rounded. Once an invoice has
charged a whole number of cents, that is the money that changed hands; no later
period can re-round it. The return's own base-times-rate check will still be a
few cents out across a quarter.

That is inherent rather than a defect, and saying so is the phase's own
application of ADR 0135: the level where the identity is actually required is the
**document** — what somebody holds and what an auditor recomputes — and that is
the level this repairs. What it removes from the return is the part of the drift
that comes from rounding every line rather than every code.

The acceptance test asserts the document and says in its own prose that it does
not assert the quarter.

## The fifth implementation, and why it is not a sixth

`splitExactly` uses **largest remainder**: every part takes its floor share and
the spare cents go one at a time to the parts that dropped the most. That gives a
property none of the four existing sites has — no part is ever more than one cent
from its exact share. `prorate` puts the whole residue on the last weight, which
is fine for ledger legs nobody reads individually and wrong for a tax breakdown,
where one line would visibly carry the document's entire rounding and nobody
reading the invoice could tell that from a mistake.

It computes `whole × weight` in `BigInt`. Every existing implementation does it
in floating point; none is wrong at the sizes this codebase sees, and all are
wrong at some size, which is a poor property for the one function everything else
is meant to call. The test asserts the disagreement rather than the claim — a
naive double version of the same split does not even sum back to its whole.

Unifying the four existing sites onto it is **not** done here. Changing
`prorate`'s residue policy changes ledger output, and this phase is not the place
to do that quietly. `SPLIT_SITES` records all five, so the fifth had somewhere to
be declared rather than being written from scratch again.

## What the registry caught while being written

`SPLIT_SITES` is keyed by `file:symbol`, which puts it into the scan ADR 0140
built, and the counts caught two things in the ordinary way:

- `registry-error.test.ts` went 15 → **16**. `SPLIT_SITES` is the first registry
  written in a module that did not exist before — `money/` — and it still
  inherited the refusal shape, because the shape now comes from reading any
  registry in the codebase rather than from sitting next to a particular one.
- `enclosing-function.test.ts` went to **four registries, 66 declarations**. Four
  of the five entries were read off the source by hand, which is exactly how
  `LEDGER_POSTINGS` came to hold two functions that did not exist.

`pending-wiring.test.ts` refused the new entry for a different reason: its
`liveDefect` must match `/compares|posts|refuse|reports|puts/`, and the sentence
says *rounds*. The verb list is a spelling, and rewriting the sentence to say
"posts" would have been a worse sentence passing a check that had stopped meaning
anything. `rounds` was argued in instead, on ADR 0130's precedent — which is the
eighth time this project has found a scan matching a spelling rather than a fact.

## A table that was wrong before it was committed

The drift figures above were first measured by a scratch script whose generator
ran one continuous stream across the four sizes. The test restarts it per size,
so three of the four rows disagreed on the first run.

The measurement was kept and the prose corrected, which is the same call ADR 0144
made about its own counts. The table now lives in one place and is reproduced by
`tests/tax-rounding.test.ts` rather than quoted from a script that no longer
exists.

## What is nominated next

Nothing new was found, for the third phase running — but unlike 143 and 144 this
one was not a scan, and the thing it found was a **sentence that had been true
about nothing since the day it was written**. Two registries hold what is
outstanding: `PENDING_WIRING`, now six entries over nine targets, five of them
blocked by nothing and each naming a skipped acceptance test; and
`BLIND_FACE_SUMS`, three registered sums.

The next piece of work is still the wiring pass, and the register is now complete
enough to be worked straight down.
