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

~~`importPayouts` is the only one of Phase 133's ten with a field saying what
currency the money is in: `payouts.currency` is what the processor said it sent.
The other nine have no such field.~~

**That was false, and it is the same error one ADR after the phase built to
catch it.** ADR 0135 said the checkable thing about a `because` is a claim tied
to a fact a scan can verify; this claim was written from memory instead.
Measured, by reading each of the nine function bodies for a currency in scope:

| path | what it already reads |
| --- | --- |
| `receiveRetainer` | `input.currency ?? functionalCurrency(…)` |
| `refundRetainer` | `retainer.currency` |
| `refundCredit` | `payment.currency` |
| `refundVendorCredit` | `note.currency` |
| `recoverWriteOff` | `writeOff.currency` |

**Five of the nine had it**, every one of them already reading it *for a rate
lookup*, and simply never handing it to the guard. `importPayouts` was one of
six that could ask, not the only one. Only four genuinely have nothing —
`receivePledge`, `receiveDeposit`, `refundDeposit`, `recordRemittance` — and for
those the paragraph above is true as written.

## Having the currency is not enough to be told it

Part 3 wired four of the five, not five, and the fifth is the interesting one.

A path may only be told what currency the money is in if, when the money and the
account agree, the figure it puts on the bank is struck at **the rate on the day
the money moved** — because that is the figure the statement will show. Letting a
path post is worthless if what it posts cannot be tied to a statement, which is
Phase 117's rule the other way round.

- `refundRetainer`, `refundCredit`, `refundVendorCredit` convert at the day's
  rate and name the difference from the carried rate as a realised gain or loss.
  `refundRetainer`'s own comment had already written the rule this phase turns
  on: *"what leaves the bank, at the rate on the day the money moves, because
  that is what the statement will say."*
- `receiveRetainer` converts at the day's rate and has **no** realised line
  because it cannot have one: arrival is the moment the rate is set, so there is
  no carried figure to differ from.
- `recoverWriteOff` posts `recovery.functionalCents` to **both** lines, at the
  write-off's carried rate. That is right for bad debt — its own comment argues
  it, and a later rate would fold a currency movement into an expense — and
  wrong for the bank. **One figure answering two questions.**

So `recoverWriteOff` keeps refusing, and `BANK_POSTINGS` records *why* rather
than leaving it looking like the other four: `withheld: 'no-day-rate'` against
their `'no-field'`. Giving it a day rate and a realised line is a real change to
a real posting and is the obvious next phase.

## The correction is a rule, not a sentence

Rewriting the paragraph would have left the next such claim unchecked, so
`askingFor` measures every declaration against the source:

- a `matched` entry whose call site passes no money currency fails — Phase 49's
  rule mirrored, a declaration nothing wires up is a claim that is false;
- a path that passes one without declaring `matched` fails;
- `withheld: 'no-field'` on a body that reads a currency fails — **the exact
  mistake above**;
- `withheld: 'no-day-rate'` on a body that reads none fails, as overstating what
  the path knows;
- a `matched` entry that never looks up a day rate fails.

`passesMoneyCurrency`, `readsMoneyCurrency` and `strikesAtDayRate` are read off
the source every run. None of them is declared.

**The scan found its own bug first.** Its paren-walker treated the apostrophe in
a comment — "at the day's rate" — as opening a string literal, ran off the end
of the function and reported *no* arguments, so two correctly wired sites read as
unwired. A scan that goes quiet on prose it did not expect is the Phase 128 /
131 / 133 failure one layer down, and it is fixed in the walker rather than by
rewording the comments.

`moneyCurrency` stays optional, and its absence still means "this path does not
know", not "assume it matches".

## A third handling, argued

`BANK_POSTINGS` gains `matched`, added rather than folded into a neighbour —
Phase 130's rule that a new enum value is argued, not bent from the nearest.

Calling this `converts` would claim the path always posts. Calling it `refuses`
would claim it never does. **Both are false half the time**, and a registry whose
value is false half the time is worse than one with a value missing.

## Two counts moved, and both were caught

Neither by inspection:

- `bank-side.test.ts` asserted ten `refuses`; nine after part 1, **five after
  part 3**, with `matched` naming its members so the move is recorded rather
  than absorbed.
- **Phase 135's own count** asserted six `refuses` + `converted`; five after
  part 1, **one after part 3** — `recoverWriteOff` alone. Its device catching
  this phase's changes twice is what it was built for.

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

**It does not tell the four what currency their money is in.** Giving
`recordRemittance` a currency field is a real change to a real screen, and this
phase does not make it. `receivePledge`, `receiveDeposit`, `refundDeposit` and
`recordRemittance` refuse a foreign account exactly as Phase 133 left them.

**It does not give `recoverWriteOff` a day rate.** It has the currency and is
still refused, because the bank line it would post is struck at the write-off's
carried rate. The reason is recorded on the entry and checked against the source
rather than left as a gap that looks like the other four.

**It does not read the bank's rate.** The refusal for a mismatched pair is
permanent until a statement line can be matched to the payout and the rate
derived from what actually landed — which is `bookedAtFace`'s shape from Phase
129, one module over, and the obvious next step.
