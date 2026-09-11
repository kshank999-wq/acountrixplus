# 0140 — The enclosing function that was not one

**Status:** accepted
**Date:** 2026-09-11
**Phase:** 140

---

## How this was found

Not by taking the nomination. ADR 0139 left no single nomination to verify, so
this started as a check on a different claim: that `LEDGER_POSTINGS` had argued
`applyDeposit` as `domestic` from a fact that is not a fact — "the lease it is
applied to carries no currency either" — and that the declaration had therefore
**licensed** the defect Phase 138 measured rather than missed it.

That check was written, committed unrun, and came back red: it named seven
entries where it expected one. Two of the seven turned out to be a comment and a
local variable — `invoices` in a sentence and an `invoiceLines` array — so the
first job was to fix the scan rather than the expectation.

Fixing it meant asking how the neighbouring scanners read source. They read it
the same way, and the way is wrong.

## The defect

Four test files each held their own copy of this:

```ts
/** The enclosing function a character offset sits inside. */
function symbolAt(src: string, index: number): string {
  const matches = [...src.slice(0, index).matchAll(/(?:export )?(?:async )?function (\w+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : '(top level)'
}
```

`ledger-postings`, `bank-side`, `comparable-sums`, `money-addition` — the four
scanners that drive every currency registry in the codebase. The pattern is not
anchored, **so the word `function` in a sentence counts.** `src/modules` holds 85
mid-line occurrences of the keyword and every single one is prose — 96 counting
the module that now documents this, which is left out for the same reason
`addition.ts` is left out of the scan for the patterns it declares.

Two of them sit between the top of a function and a place money is posted:

```
receivables/service.ts:567          // A function that accepts an executor has to use it …
receivables/customer-credit.ts:180   * since — while this function converted both sides …
```

So seven posting sites — four in `createInvoice`, three in `applyCredit` — were
attributed to functions named **`that`** and **`converted`**.

## Why nothing noticed for thirteen phases

`LEDGER_POSTINGS` was written from the scanner's output, so it contains entries
for `that` and `converted`. Which means:

> `ledgerPostingFor('src/modules/receivables/service.ts', 'createInvoice')` throws
> today — for the function that raises every invoice in the system.

The test that should have caught it is `ledger-postings.test.ts`'s *"keeps every
declaration pointing at a function that still posts"*. It compares the
declarations against `postingSites()`. Both sides of that comparison come from
the same broken measurement, so it agrees with itself — and always will.

That is Phase 121's rule at its sharpest. **A check only ever seen to agree is
not a check**, and this is not a check that happens never to have disagreed: it
is one that *cannot*.

## The reach it spoils

Two wrong names in one registry is the visible part. Measured on a much wider net
— every `…Cents:` assignment in `src/modules`, 2,402 of them — the old reader and
the new one disagree on **126 sites**, across **seventeen invented names**:

```
a   as      converted  exists  has  holds  in  is  never
nobody  of  rather  that  the  to  whose  with
```

Not one of those is a function anywhere in the codebase. The two that reached a
registry are the ones the current narrowings happen to touch, not the extent of
the fault: widen any of the four scanners by a line and more arrive under a word.

`comparable-sums.test.ts` is the one that stings. ADR 0134 replaced a fixed-line
currency window with an **enclosing-function** boundary precisely because the
window leaked past a boundary and *excused* a real defect — and the boundary it
replaced it with reads the word `function` out of a sentence. It had its own
second copy of the reader to do it.

## The repair

`src/modules/source/enclosing.ts`, and one module rather than four copies,
because a constraint beats a check (Phase 116): four fixed copies is four things
that can drift apart again, and the next scanner makes five.

- **`enclosingSymbol(src, index)`** — anchored to column zero, comments blanked
  first, the opening `(` required. A declaration in this codebase is always at
  column zero and the word in a sentence never is, which alone fixes all 126.
  Requiring the `(` is about nested functions rather than prose: an inner
  declaration is indented, so a site inside one is attributed to the top-level
  function a registry can be keyed by.
- **`enclosingSpan(src, index)`** — the same reading as offsets, for the caller
  that wants the body. That is `currencyAware`, and it is why ADR 0134's boundary
  now has one definition instead of two.
- **`withoutComments(src)`** — blanks comment bodies to spaces and keeps every
  newline, so **byte offsets survive**. A scanner that renumbered the file it is
  describing would be a worse failure than the one being fixed.
- **`declaresFunction(src, symbol)`** — the half that closes the class. A registry
  keyed by `file:symbol` can now be asked whether its keys are real, instead of
  being compared against the scan that produced them.

`LEDGER_POSTINGS` gets the two names it meant: `createInvoice` and `applyCredit`,
each with a comment saying which sentence it used to be named after.

All three site-keyed registries — `LEDGER_POSTINGS`, `BANK_POSTINGS`,
`SAFE_FACE_SUMS`, **59 declarations** — are now checked against the source.
`BANK_POSTINGS` and `SAFE_FACE_SUMS` were clean; that is worth knowing rather
than assuming, and it is now asserted rather than believed.

## What this does not do

**It does not change a single posting.** No money moves differently. What changes
is that the registry deciding which postings are allowed can be asked whether it
is talking about real code — and could not be, before.

**It does not claim the four scanners are now right about everything.** It claims
they agree about one thing, measured, and that the thing they agreed about
wrongly is fixed. Each still has its own narrowing, and a narrowing is where the
previous five reach failures lived.

**It does not fix the defect that started it.** `applyDeposit` is still declared
`domestic` on the argument that a lease carries no currency, still reaches
`invoices` through `settleInvoiceWithoutCash`, and still posts a euro face amount
into Accounts Receivable. `PENDING_WIRING` tracks it and `spends` is waiting.

## What the corrected scan found, for the phase after this one

The measurement that turned this up is worth keeping, because it is not what ADR
0140 part 1 expected. With comments stripped and table identifiers restricted to
what each file actually imports from `@/db/schema`, the fourteen `domestic`
entries reach these currency-carrying tables, directly or through one call:

| entry | reaches | what keeps the currency out |
| --- | --- | --- |
| `completeAppointment` | `invoices`, `invoice_lines` via `createInvoice` | `createInvoice` converts |
| `commitOpenDocumentImport` | `invoices`, `bills` and their lines | writes both twins from one expression, so the rate is one |
| `closeShift` | `payments` via `shiftPosition` | argued in `SAFE_FACE_SUMS` |
| `recordRemittance`, `receivePledge`, `receiveDeposit`, `refundDeposit` | `financial_accounts` | Phase 133's refusal |
| `sellGiftCard`, `openShift`, `payOut`, `commitTrialBalanceImport` | — none — | nothing to keep out |
| **`redeemGiftCard`** | `invoices` | **nothing** |
| **`recordContribution`** | `financial_accounts` | **nothing** |
| **`applyDeposit`** | `invoices` via `settleInvoiceWithoutCash` | **nothing** |

Three, not one — and the "only one" sentence has now been wrong five consecutive
times, which is itself the argument for making the class checkable rather than
correcting a sentence.

- **`redeemGiftCard`** bounds a home-currency card balance by
  `bill.balanceCents`, the invoice's **face** balance, and posts that figure to
  both lines — while relieving the invoice's functional twin with
  `relieveFunctional`. On a euro invoice the control account and the subledger
  therefore move by different amounts: Phase 137's defect exactly, in a path
  Phase 137 did not reach.
- **`recordContribution`** reads `financialAccounts.chartAccountId` directly
  rather than through `bankGlAccountFor`, so it is the one path posting into a
  bank account that Phase 133's `BANK_POSTINGS` never listed and Phase 133's
  refusal never covered. Its sibling `receivePledge`, in the same file, does it
  correctly.

Part 1 of this phase proposed detecting these by regex over the registry's prose.
That is the wrong instrument — it matched a sentence quoting a *corrected* claim
in `postFee` and a scoped claim about one field in `createDeposit` — and it is
recorded here so the next phase does not rebuild it. The right shape is a
declared **ground** per `domestic` entry, checked against a measured reach.
