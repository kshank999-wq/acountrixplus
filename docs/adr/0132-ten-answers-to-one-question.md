# 0132 — Ten answers to one question

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 132

---

## How this was found

By the project's own rule, applied to the project's own record. Phase 31 taught
and Phase 33 wrote down what a follow-up repeated across consecutive ADRs
usually means; Phase 130 acted on it at three. This is the same shape at three,
and unlike Phase 130's it arrives already measured:

| ADR | At | The sentence |
| --- | -- | --- |
| 0127 | eight | *the argument for a RegistryError subclass rather than an allowlist entry per registry* |
| 0128 | nine | *each new registry costs a tenth* |
| 0131 | ten | *it cost exactly what the ninth said the next one would* |

ADR 0131 also nominated a live money defect — remitting a payroll liability from
a foreign bank account posts a functional figure against a bank line the
statement will never show. That was measured too, and it is real, and it is
**not** this phase: it is named once where this is named three times, and it
would be the sixth consecutive FX phase. It is recorded again below.

## What was actually wrong

Phase 101 set a device this codebase has used eleven times: a registry of named
data where every entry carries the argument for itself, and a lookup that throws
on an undeclared key rather than returning `undefined`. Every one of those
lookups threw a bare `Error` whose sentence explains what to declare — prose, so
Phase 119's classifier read it as written for a person, so each registry bought
itself an entry in `ALLOWED_BARE_REFUSALS`.

Ten entries differing only in which registry they name. **An exception granted
ten times is not an exception; it is a category the model does not have.**

## The eleventh, which was never in the list

Measuring found `policyFor` in `retention/policy.ts`. It has thrown
`No retention policy named X` since Phase 101 and has **no allowlist entry at
all** — not because anybody argued it away, but because the sentence is a
fragment, so `audienceOf` read it as an operator's and the rule never asked.

The eleventh instance of the device was invisible to the rule about the device,
kept out by an accident of wording. And the sixth allowlist entry names
*"prompts, retention policies, record kinds and falsifiers"* as what came before
it — retention policies were never there. That is Phase 110's failure again, a
declaration argued from a fact that is not a fact, in the registry whose whole
purpose is to be trusted.

A second stale number beside it: the list's docstring said "fourteen" while the
list held **twenty-one**. True when Phase 119 wrote it, untrue from Phase 120
onward, and nobody counted — the shape Phase 126 found in
`UNCLASSIFIED_CARRIERS`. It is eleven now, and a test counts it.

## Why a class, when `Refusal` argued against classes

`Refusal`'s own prose refuses this move, and it is right to:

> Inventing twenty-four module classes to fix that would add twenty-four things
> to import and nothing to catch — the ceremony of a type system without the use
> of one.

Three things make this the opposite case, and they are the test of whether the
objection applies rather than a way around it.

- It is **one** class, not twenty-four.
- It **subtracts** ceremony. Ten allowlist entries go, and the twelfth registry
  costs nothing rather than an eleventh.
- There is something that catches it. `tests/refusal-audience.test.ts` matched
  these by file path and exact message text; it matches them by shape now. A
  type read by a scanner is a type being used — and matching by message text was
  brittle in a way that bit twice, in Phase 120 and again in Phase 131.

## A third audience, argued rather than bent

`Audience` had `person` and `operator`, and a registry refusal is neither. It is
prose, so the rules read it as a person's — correctly by their own lights and
wrongly in fact. It is not an operator's either: an operator can restart a
process or set an environment variable, and neither declares a missing entry.

Hence `maintainer`, on Phase 130's precedent for adding a value rather than
bending the nearest one. Picking the closer wrong answer is how a model stops
describing anything.

## The line that keeps the rule honest

Six sentences look like this device and are not: `Unknown bank provider "x".
Registered: mock`, and its siblings for payments, payroll, push, email and object
storage. The difference is where the key comes from.

- A **registry** key is a literal in this repository. Only a developer editing
  the source can produce an undeclared one.
- A **provider** key comes from configuration. An operator produces an unknown
  one by typing it into an environment variable, and the sentence they need
  lists what is registered.

They stay `operator`, which is what they have always been, and the test asserts
it — because a rule that swallowed them would be a worse answer than the ten
entries it replaced.

## What this does not change

**Nothing reaches a screen that did not before.** `RegistryError` extends
`Error`, not `DomainError`. An undeclared key is a defect in this repository
rather than something a person did, and ADR 0074's deny-by-default is exactly
right for it. The eleven sentences are carried through verbatim for the same
reason: each was written to tell a maintainer what to declare, and several are
quoted in tests.

**It does not fix remitting from a foreign account.** `recordRemittance` posts
its `amount_cents` — a ledger figure, measured against a ledger balance, so
genuinely the books' money — against the bank account it names, and nothing
converts. Remit from a euro account and the bank line carries a functional
figure the statement will never show. `INHERITED_CURRENCY`'s entry for
`tax_remittances` says so, ADR 0131 named it, and this is the second ADR to name
it without building it.

**It does not touch `logUnexpected`.** `RegistryError` now carries `registry` and
`key` as fields, which is the one capability the bare `Error`s never had — a log
line could say which registry and which key without parsing prose. Nothing reads
them yet. Wiring that in the same phase that added them would be a change nobody
measured.
