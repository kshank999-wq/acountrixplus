# 0135 — When one function is declared in two registries

**Status:** accepted
**Date:** 2026-09-10
**Phase:** 135

---

## How this was found

Not from an ADR's nomination this time. Checking the banked list after Phase 134
shipped turned up a defect **Phase 134 itself introduced**.

It made `importPayouts` convert, and updated that site's entry in
`LEDGER_POSTINGS` — `domestic` became `converted`. It left the same function's
entry in `BANK_POSTINGS` saying:

> "this is the path closest to being able to convert — **and it still does
> not**, because nothing compares the payout's currency to the account's."

One declaration says the figure is converted. The other's argument says it is
not. Both describe the same function, and they had been contradicting each other
for a phase.

## Why nothing noticed

The only assertion on that prose was `because.length > 140`.

**A false sentence is exactly as long as a true one.** Twenty-four registry files
in this repository carry `because` prose, and the great majority of the
assertions on it are length checks. That is not a scandal on its own — most of a
`because` is an argument, and an argument is not something a machine evaluates —
but it means a registry entry can rot without any test noticing, and this one
did.

The first framing of this phase was "prose length is not a check". Measuring
killed it: there are **32** non-length assertions on `because` across the suite.
Most are on *computed* prose — `integrity/reach.ts`, `duplicates.ts` — which is
naturally checkable. The one precedent on a hand-written registry is
`ledger-postings.test.ts`, which requires an exemption's prose to name the
expression it exempts. Prose tied to a fact a scan can verify.

## What is actually checkable

Measured: **fourteen symbols are declared in two registries**, every one of them
in `BANK_POSTINGS` and `LEDGER_POSTINGS` together — and nothing had ever put the
two descriptions side by side.

| | `handling` | `basis` | count |
| --- | --- | --- | --- |
| the feed and what is built on it | `converts` | `converted` | 4 |
| a face figure and a foreign account | `refuses` | `domestic` | 4 |
| a converted figure, an account it cannot take | `refuses` | `converted` | 6 |

The two registries answer different questions and **must not** be required to
match:

- `basis` — is the **figure** the company's own money?
- `handling` — can the path cope with the **account** being foreign?

A path can post a converted figure and still refuse a foreign account, and six do.
But the implication in the other direction is real:

> **`converts` ⟹ `converted`.** A path that converts *for the account* is by
> definition producing a figure in the company's own money.

All four satisfy it. Declaring it means a future `converts` + `domestic` pair
fails here instead of being two answers to one question nobody compared. The
**equivalence is not claimed**, and the test says so in as many words, because
the six `refuses` + `converted` rows are correct and somebody tidying this up
would otherwise "fix" them.

## And what the prose may not do

The rest is Phase 134's actual defect: prose in one registry denying what the
other declares. `DENIALS` is three phrases, each with prose arguing why it is
safe to read as a denial — a registry rather than a regex in a test, because it
is doing something delicate: deciding that a sentence a person wrote means the
opposite of a declaration beside it.

It is deliberately small. A phrase that fires on prose merely *describing* the
old behaviour makes the check unusable, and an unusable check gets deleted
rather than fixed. `did not convert` is history, which a `because` is often
right to recount; `would not convert` is a hypothetical. Only the present tense
is a denial.

## The check caught its own correction

Two things happened on first run, and both are the point of the phase.

**It caught the live defect** and named it: *"LEDGER_POSTINGS declares
importPayouts `converted`, and its BANK_POSTINGS entry argues the opposite."*
Not a check only ever seen to agree (Phase 121).

**Then it caught the fix.** The corrected entry *quotes* the sentence it is
correcting, and the denial fired on the quotation. That is not a nuisance to
route around: registries here recount their own history constantly —
"**Corrected in Phase 128**", "this said X, which is false" — and a check that
cannot tell a quotation from a claim makes the honest entry the failing one,
which is exactly how a check gets deleted instead of fixed. Reading past
quotations is the fix, and it has a test of its own.

## What this does not do

**It does not check prose in general, and cannot.** Three phrases against one
declaration is the whole of it. The broader question — whether a `because` is
*true* — stays unanswerable, and pretending otherwise would produce a check
nobody trusts.

**It does not reach the other twenty-two registries.** The overlap that exists
today is `BANK_POSTINGS` × `LEDGER_POSTINGS`. Nothing else in the repository
declares the same key twice, so there is nothing else to compare; if a third
registry ever describes these functions, this is where it gets compared.

**It does not settle a foreign payout into a foreign account.** Still Phase 133's
refusal, and now the honest reason `importPayouts` remains `refuses` while its
figure is `converted` — which is what the corrected prose says.
