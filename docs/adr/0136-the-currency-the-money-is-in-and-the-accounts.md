# 0136 — The currency the money is in, and the account's

**Status:** accepted
**Date:** 2026-09-10
**Phase:** 136

---

## How this was found

By the project's own rule rather than by judgement. "Foreign account" is named as
still open in **ADR 0131, 0132, 0134 and 0135** — four times, the last two
consecutive. Phase 31 and Phase 33 established that a follow-up repeated across
consecutive ADRs is usually the phase.

## One question where there are two

Measured: `mayPostToBank` took `accountName`, `accountCurrency`, `homeCurrency`
and `what`. **It never saw the money.** And nothing in `importPayouts` compared
the payout's currency to the account's.

So one refusal covered two situations that are not the same situation:

**The money and the account agree.** A €96.80 payout into a euro account. This
is the bank feed's shape, and the feed has done it correctly since Phase 128 —
`bank_transactions` inherits its currency from `financial_accounts`, so the money
*is* the account's currency. €96.80 really landed, the statement will say so, and
the ledger takes the converted figure at a recorded rate. Nothing is unknown.
`BANK_POSTINGS` says of `buildLines`: *"It is the shape the ten that refuse would
have to grow into."*

**They disagree.** A €96.80 payout into a dollar account. The **bank** converted
it, at the bank's rate on the bank's terms, and these books do not have that
rate. Any figure posted is an estimate of somebody else's arithmetic. Phase 40's
tie-out compares each account in its own currency, so the statement and the
ledger differ by the spread with nothing to name it.

## The inversion

**Phase 133 refused the first. Phase 134 converted the second.** Exactly the
wrong way round.

That is not a subtle reading — it is what the new tests found, in Phase 134's own
database test. Three assertions there were written against a dollar account
receiving a euro payout, and they passed: the arithmetic was self-consistent, the
clearing account reached zero, and it described something a bank would not do.

They are **repaired onto a euro account** rather than deleted — the same
assertions, now on a case that can happen — and the mismatched case is its own
test with its own refusal.

## Why only one path gets the sharper question

`importPayouts` is the only one of Phase 133's ten with a field saying what
currency the money is in: `payouts.currency` is what the processor said it sent.

The other nine have no such field. A person typed an amount and chose an account,
and nothing asked what currency the amount was in — so the account being foreign
is the only question that can be asked of them, and the honest answer is still
no. `moneyCurrency` is optional for exactly that reason, and its absence means
"this path does not know", not "assume it matches".

## A third handling, argued

`BANK_POSTINGS` gains `matched`, added rather than folded into a neighbour —
Phase 130's rule that a new enum value is argued, not bent from the nearest.

Calling this `converts` would claim the path always posts. Calling it `refuses`
would claim it never does. **Both are false half the time**, and a registry whose
value is false half the time is worse than one with a value missing.

## Two counts moved, and both were caught

Neither by inspection:

- `bank-side.test.ts` asserted ten `refuses`; nine now, with `matched` naming
  `importPayouts` explicitly so the move is recorded rather than absorbed.
- **Phase 135's own count** asserted six `refuses` + `converted`; five now. Its
  device catching this phase's change is what it was built for.

## What Phase 135 did not catch, and why that is right

The `BANK_POSTINGS` prose for `importPayouts` went stale again — it said a euro
payout into a euro account "should not be converted at all", which this phase
makes false.

**Phase 135's check did not fire, correctly.** Its `DENIALS` registry catches
denial-*of-conversion* phrases beside a `converted` declaration. This staleness
is a claim about *what is refused*, which is a different shape. ADR 0135 said so
in as many words: "It does not check prose in general, and cannot. Three phrases
against one declaration is the whole of it."

So the prose was corrected by hand, and the limit is confirmed rather than
discovered. A check that had fired here would have been a check that fires on
anything.

## What this does not do

**It does not tell the nine what currency their money is in.** Giving
`recordRemittance` a currency field is a real change to a real screen, and this
phase does not make it. They refuse a foreign account exactly as Phase 133 left
them.

**It does not read the bank's rate.** The refusal for a mismatched pair is
permanent until a statement line can be matched to the payout and the rate
derived from what actually landed — which is `bookedAtFace`'s shape from Phase
129, one module over, and the obvious next step.
