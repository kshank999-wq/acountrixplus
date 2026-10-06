# 0173 — Reading every bullet

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 173

---

## Why this phase and not the nominated one

ADR 0172 nominated a full suite and said nothing in the backlog was worth more.
That is still true, and the suite is running — it has been interrupted three
times by phases that needed to write to `src/` or `tests/`, which is the actual
reason it has never finished.

This phase was chosen because it is the one standing nomination that writes
**only documentation**, and documentation is not read by any test. So it runs
alongside the suite instead of displacing it. That is the whole of the
scheduling argument, and it is worth one paragraph because the alternative — a
fourth interruption immediately after an ADR arguing against interruptions —
would have made that ADR a claim nobody acts on, which is the defect this
codebase keeps finding in its own history.

## The audit's prediction, tested

`docs/SPEC-AUDIT.md` said of itself:

> The four gaps in §9 and two in §11 are therefore a floor, not a ceiling. A
> bullet-level pass over §3–§8, §10 and §12–§18 would likely find more, and it
> would be a phase of its own.

It found more: **eight capabilities with nothing behind them**, plus two
adjacent findings. Measured against the source, not reasoned about.

## Where they are, and why that is the real result

Eight of the nine rows are in **§7 and §8** — the design engine. One is in §15.

That is the finding under the findings. ADR 0152 and the audit both called §7
*"the largest unbuilt piece"* and neither said **which** parts, which made it a
label rather than a measurement: a sentence that cannot be acted on, cannot be
checked, and cannot shrink. It is now nine specific things, two of which are one
piece of work.

The other sections hold up well at bullet level, and in two places better than
the bullet asks:

- **§3's rule engine** tests five fields and **combines** them through
  `matchType: 'all' | 'any'` over a `conditions[]` array. The bullet says "or
  combinations"; the implementation is a general predicate.
- **§4's controlled reopen** is behind its own `reconciliation:reopen`
  permission rather than bundled with completion, which is the distinction the
  bullet implies and does not require.
- **§3's seven review states** exist in the spec's own order. Worth checking
  precisely because an enumerated list is the easiest thing to claim and the
  easiest to verify.

## What I was careful not to call a gap

Three things measured as absent that are not defects, recorded so a later pass
does not count them:

**§16's `Role` and `Permission`** are code constants in `modules/permissions`,
not tables. §16 is a *data model* list, and a role as an enum with a permission
array is a legitimate modelling choice for a system where roles are fixed by the
product rather than created by customers. **`AIUsage`** is served by
`ai_requests`, which §12 itself calls the usage ledger.

**§3's "bulk rule creation"** is satisfied on one reading and not the other.
`createRule({ applyToExisting: true })` creates a rule and applies it across the
existing inbox, which is the capability anybody actually wants; creating several
rules in one action does not exist. The bullet's parallel with "bulk
categorization" suggests the second reading. Recorded as an ambiguity rather than
decided, because deciding it in an audit would be the audit inventing a
requirement.

**§7's own deferral** is narrower than it is convenient to read. The section
ends *"advanced Illustrator-class path editing can be phased in after the core
proposal workflow is stable"* — which defers **path editing** and nothing else.
Guides, rulers, snapping, layers, zoom and undo/redo are layout affordances, not
vector authoring, and that sentence does not cover them. Reading it as deferring
all of bullets 1 and 2 is the generous reading and is not what it says, so the
audit now records both parts and names which one the spec defers.

## The one finding that is not a missing bullet

`bank_transactions.provider_category` is imported and **not** in `RULE_FIELDS`.

§3's rule bullet names merchant, description, amount, account and transaction
type, and all five exist — so by the letter this is not a gap. It is the gap a
user would hit first: the bank supplies its own category on every transaction,
it is stored, and a rule cannot test it. Recorded as adjacent rather than as a
§3 failure, because an audit that stretched a bullet to cover something it does
not say would be doing what Phase 164 was written to stop.

## What this does not do

**It does not fix anything.** No migration, no module, no test. A measurement
phase, and the second in a row — which is a pattern worth watching rather than
repeating a third time.

**It does not cover every section.** §12, §14 and §18 are still module-level, as
are §1, §2 and §19–§24. §12 was checked as a list by ADR 0164; §14 is a
permissions table that `modules/permissions` mirrors closely enough that a
bullet pass would mostly re-measure Phase 149's work; §18 is technology
direction, where the stack is visible in `package.json`. Said rather than
implied, which is the rule the original audit set for itself.

**It does not rank the nine.** A list of what is missing is not a plan, and
turning it into one means asking which of them a customer sending a proposal
actually hits — comments on a client link and asset association are both
plausibly ahead of vector primitives, and that is a product judgement rather
than a measurement.

## What is nominated next

**The full suite, finishing.** Third ADR in a row to nominate it. It is running
as this is written, and the honest reading of three interrupted attempts is that
it will keep being interrupted unless a phase is spent on nothing else.

Then, from the nine: **comments/questions on the client link** and **asset
association**, which are the two that are small, independent of the vector
question, and most likely to be hit by somebody using the product as it exists
today. Both are a table and a screen rather than an engine.

The vector and artboard work is a programme, not a phase, and should not be
started until somebody decides whether §7's first two bullets are wanted in full
or whether the block engine plus the deferral sentence is the actual intent.
That is a question for the person who wrote the spec, not a thing to measure.
