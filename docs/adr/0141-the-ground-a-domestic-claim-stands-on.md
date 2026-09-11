# 0141 — The ground a domestic claim stands on

**Status:** accepted
**Date:** 2026-09-11
**Phase:** 141

---

## How this was found

ADR 0140 nominated three entries whose `domestic` basis the source contradicts.
Verifying them first found the nomination right and the framing too small.

`LEDGER_POSTINGS` sorts every posting site into three baskets, and fourteen sit
in `domestic`:

> The money cannot be foreign at this site, argued from the schema.

Each of the fourteen does argue. What none of them does is say **what kind of
argument it is making** — and the kinds are not interchangeable:

- nothing with a currency is anywhere near this code;
- something is, and the path **refuses** when it differs;
- something is, and a callee **converted** it before this line ran;
- something is, and this function **writes** it, at a rate of one;
- something is, and the figure is a **sum** already argued to be one currency.

Fixing three sentences would have left the class exactly as it was. Naming the
grounds makes each one imply something a scan can check.

## The design, which is one decision

**The ground is declared; the reach is measured.** Choosing which argument a site
is making is a judgement a person has to make. Remembering what the site reaches
is not, and it is the half that goes stale — ADR 0134's rule, that a declaration
which *excuses* a site is worse than one that misses it, applies precisely to the
half that could excuse.

One structural consequence is worth stating, because it closes the hole a
self-declared field would otherwise leave. `covered` is built **only** from what a
named `via` reaches. A carrier the function reads in its own body is therefore
never covered by a callee, so a failing entry cannot be rescued by relabelling it
`converted-downstream` and pointing at something plausible. `groundStands` has a
unit test that does exactly that to `applyDeposit` and is refused.

## What measuring found

Three of the fourteen argue a ground the source contradicts. Each keeps the
argument it has always made rather than having it softened, so the scan disagrees
with it by name.

| entry | argues | and the source says |
| --- | --- | --- |
| `applyDeposit` | "the lease it is applied to carries no currency either" | reaches `invoices` through `settleInvoiceWithoutCash` |
| `redeemGiftCard` | "a gift-card balance that has no currency column" | reads `invoices` itself |
| `recordContribution` | "`contributions` and `funds` carry no currency column" | debits a bank account read straight out of the table |

The other eleven stand, and two of them are more interesting than they look:

- **`closeShift`** reaches `payments` through `shiftPosition`, unlike either of
  its drawer siblings. It is right anyway, and this entry points at
  `SAFE_FACE_SUMS` rather than restating the argument — two answers to one
  question is the defect.
- **`commitOpenDocumentImport`** reaches four carriers because it *creates* them.
  Its file already says "the rate is one and the functional figure *is* the face
  figure"; the ground turns that sentence into a check that the face column and
  its functional twin take **the same expression**, and it would fail the day
  somebody converted one of them.

### `redeemGiftCard`

`redeemFor(card.balanceCents, bill.balanceCents)` bounds a home-currency card by
the invoice's **face** balance, posts `plan.appliedCents` to both journal lines,
and then relieves the invoice through `relieveFunctional`, which converts. On a
euro invoice the control account and the subledger therefore move by different
amounts — Phase 137's defect exactly, in a path Phase 137 did not reach.

It is **not** on `PENDING_WIRING`, and that is deliberate: the register holds work
with a staged core, and no core answers this one. Relieving a face balance by a
functional amount is the inverse of `relieveFunctional`, which has no counterpart,
and inventing one is a phase rather than a wiring step.

### `recordContribution`, and the sixth reach failure

The gift branch reads `financialAccounts.chartAccountId` straight out of the table
and debits it. `receivePledge`, forty lines below in the same file, goes through
`bankGlAccountFor` and is refused a foreign account. **Same business, same
account: told no for a pledge, nothing at all for a gift.**

It is absent from `BANK_POSTINGS` altogether. Phase 133's scan matches
`chartAccountId: bank.chartAccountId` or a variable whose name contains `gl`, and
this assigns to `debitAccountId` first — a scan that looked for a spelling rather
than for the fact. That is the sixth time this codebase has found that shape,
after Phases 128, 131, 133, 136 and 140.

Measured across every read of `financial_accounts.chart_account_id` in
`src/modules`: **ten sites — four go through the gate, five post nothing** (a
pick list, two listings, and the feed's own `bankGlAccount` helper in two files,
which `bank-side` skips by rule) **and one is `recordContribution`.** So the
bypass is a class of one, which is worth knowing rather than assuming.

It is on the register with a skipped acceptance test rather than repaired in
place, because the staging pass is holding every bank path until they are hooked
up together. Not a missing capability and not a missing field: the gate exists
and **ten other functions already call it**, and this one reads around it.

## The scan, and what each guard is for

Three guards, each of which the first cut of this scan lacked and was wrong for:

- **Comments blanked.** The first cut read the word `invoices` in a sentence
  inside `completeAppointment` and called it a table.
- **Table identifiers restricted to what the file imports from `@/db/schema`.**
  The same run read an `invoiceLines` array — a local variable in the same
  function — as `invoice_lines`.
- **Hops resolved through the calling file's own imports**, rather than a list of
  candidate files typed by hand. This phase's own first measurement used a
  hand-typed list; it happened to agree with the resolved one, which is luck
  rather than a reason to keep it. A hand-typed narrowing is where five of the
  six reach failures lived.

## And one the scanners themselves needed

`fx/ground.ts` explains what Phase 133's scan matches, and quotes the pattern to
do it. `bank-side.test.ts` promptly reported its own documentation as a twentieth
posting site.

`money-addition` and `comparable-sums` each solved this in Phases 123 and 125 by
excluding the file that declares their patterns, and their prose is emphatic
about why that is the honest fix: *"excluding it by rule is honest, excluding the
finding by tightening the regex would not be."* Both remain right — those
examples live in string literals, which are code.

This one is a comment, so there is a better rule available: **a posting site is
code; a sentence about one is not.** All four scanners now blank comments before
matching, using Phase 140's offset-preserving `withoutComments` so line numbers
are still the file's own. Measured: `bank-side` back to 19, and unchanged for the
other three — the guard costs nothing today and is what stops the next scanner
reading its own documentation.

## What this does not do

**It does not repair anything.** All three defects are live: `applyDeposit` still
posts a euro face amount into Accounts Receivable, `redeemGiftCard` still moves
the control account and the subledger by different amounts, and
`recordContribution` still debits a euro bank account with a dollar figure.

**It does not make `domestic` safe.** It makes each `domestic` claim *falsifiable*.
Eleven entries now assert something about the source that a change could break,
where before they asserted something about the schema that nobody could check.

**It does not extend to `converted` or `ledger`.** Those baskets argue
differently — a `converted` entry names the expression, which
`ledger-postings.test.ts` already checks — and inventing grounds for them would
be a registry built for symmetry rather than for a question anybody has.

## What is nominated next

`redeemGiftCard` is the one finding with no staged core and no register entry, so
it is the one at risk of being forgotten — which is the failure mode Phase 139
built `PENDING_WIRING` to prevent, in the one case that register cannot hold. The
question it needs answered is narrow and real: **what relieves a face balance when
the amount applied was decided in functional money?** `relieveFunctional` goes one
way only.
