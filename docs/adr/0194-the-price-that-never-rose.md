# 0194 — The price that never rose

**Status:** accepted
**Date:** 2026-11-07
**Phase:** 194

---

## The nomination, and what it was testing

ADR 0193 nominated the audit itself. `docs/SPEC-AUDIT.md` was written in Phase
173, its bullet-level pass covered **§1–§11 only**, and §12 onward had never
been measured below the section heading. Three §7 rows re-opened since — the
comments/questions row, the artboard row, the vector row — had each turned out
wrong, and all three in the same direction.

So the hypothesis was that the rest would be wrong too, and the file's own
closing sentences were the thing to test: *"the other sections hold up"*, with
§12–§18 predicted to *"would likely find more"*.

## The hypothesis was wrong, which is the result

Measured bullet by bullet, §12–§19 largely holds.

§13's eleven are built — fixed assets and depreciation included, although §13
makes them optional. §14's roles and six requirements have `user_mfa`,
`sessions`, `devices`, `login_attempts`, `audit_events` and practice mode
behind them. §15's five are `service_items`, `clauses`, `team_members` and the
brand kit. §16's thirty-four entities all resolve. §18's seven include a real
outbox and server-side PDF. §19's nine are in place.

**That is worth saying plainly rather than hurrying past.** Twenty phases of
re-measurement had taught this process to expect every unmeasured claim to be
stale, and the one time the prediction was written down — *"§12–§18 would
likely find more"* — it was wrong. A measurement that confirms is still a
measurement; the alternative was to keep nominating against §12–§19 on a
suspicion nobody had checked.

Three things did come out of it.

## The number: a price increase that was cancelled

`claude-sonnet-5` was priced at **$3 / $15** per million tokens with a $0.30
cache read. The published price is **$2 / $10 with a $0.20 cache read**, and
the pricing page says exactly why the other figure exists:

> The $2/$10 per million input/output token pricing for Claude Sonnet 5,
> announced at launch as introductory pricing through August 31, 2026, is now
> the standard price. The previously scheduled increase to $3/$15 per million
> input/output tokens on September 1, 2026 **will not occur**.

So the table encoded an increase that never happened. Every Sonnet request
this application metered recorded a cost estimate half again as large as the
real one — in the ledger §12 asks for *"for billing and monitoring"*, which is
the one number in that module whose only job is to be right.

Nothing errored and nothing looked wrong, because **a price is a constant
nobody re-reads**. That is the same sentence as Phase 192's about a build
nobody runs and Phase 193's about a function nobody calls, and it is the third
consecutive phase where the defect was something correct-looking that no step
in the loop ever asked about again.

Verified against the live pricing page rather than against a cached table —
including the skill's own, which happened to agree. Changing a price on the
strength of a table that might itself be stale is the error this phase is
about, one level up.

## The one I nearly got wrong

§12 asks for *"caching where safe"*. `provider.ts` prices a cache read, the
gateway records it, the usage ledger carries it — and
`cache_read_input_tokens` has never been anything but zero, because nothing
sets `cache_control`.

That is Phase 160's shape exactly: a capability installed and inert, one line
from working. I was a few minutes from writing that line.

**It would have cached nothing.** Prompt caching needs a stable prefix of at
least the model's minimum — 1024 tokens on this family — and below it the
request *silently does not cache*. Measured:

| | tokens |
| --- | --- |
| every system prompt in `prompts.ts` | 230–631 |
| the minimum for `claude-opus-5` | 1024 |

The retrieval context is no help either: it renders into the **user** message
and differs per request, so there is no stable prefix there to cache.

So the pricing path is correct, correctly reads zero, and starts paying the
day a prompt grows past the threshold. The no-op would have been
indistinguishable from the absence — same zero, plus a line of code implying
otherwise — and the next person to measure would have found it and believed
the feature was on.

What is recorded instead is **a test that fails when a system prompt passes
1024 tokens**, naming the file to change. Phase 185's lesson inverted: there, a
limitation declared in a docstring survived sixty phases because a sentence
cannot notice it has stopped being true. This one can.

### And the tool layer, which is a decision rather than a gap

§12's *"Tool/function layer exposes only approved application operations to
AI; enforce the same permissions as the human user"* has nothing behind it: no
tool registry, no `tool_use`, no `tool_choice`.

Recorded as a decision. Every consequential AI action here goes through a
structured suggestion that a human applies — which is §12's **own next
bullet**, and which is strictly more restrictive than a tool layer: the AI has
no reach at all rather than a scoped one. Building tool-calling would add a
path around the approval gate in order to satisfy a bullet whose intent the
current design already exceeds.

If that changes — if some AI action genuinely needs to execute without a
human — the tool layer is the right way to build it, and this paragraph is the
thing to re-read first.

## What keeps the audit honest now

The table count was the only number in the file that had moved: **181 → 185**.
Small, and pinned in `PINNED_CLAIMS` for what it stands for. A section marked
*"done — 181 tables"* reads as a section somebody counted, and the count is
the only part of that sentence a machine can keep honest.

That register's own pinned length moved 13 → 14 and the test named it, which
is the mechanism working on itself. There is a pleasing detail in its
docstring: the register was assembled in Phase 179 by reading three
operational documents and **missing `docs/SPEC-AUDIT.md`**. Fifteen phases
later the fourteenth claim is a second entry in that same file.

One modelling choice is recorded alongside §16's three, so nobody counts it as
a gap later: **§17's "Reporting/Analytics Service" has no module of its own.**
Sales analytics is `crm/analytics.ts`, the financial reports are `ledger/*` —
reporting lives inside the domain that owns the data, which is defensible and
arguably better than a reporting service reaching into everything.

## What this does not do

**It does not make the audit self-measuring.** One number is pinned; the prose
around it is not, and could not be — "all 12 have a module" is a judgement
about what counts as a module, and `PINNED_CLAIMS` measures integers. The
honest position is that this file needs re-reading by a person every so often,
and that Phase 173, Phase 188, Phase 191, Phase 193 and this phase are what
that looks like.

**It does not re-measure §1–§11.** Phase 173 did those bullet by bullet and
Phases 188–193 re-opened the §7 rows one at a time. §20–§24 are process and
assignment sections with nothing to measure.

**No caching, and no tool layer**, for the reasons above — both recorded where
somebody will meet them rather than in this document alone.

## Nominated for Phase 195

**The §9 and §11 gap rows, re-measured.**

This audit has two more "below" sections that were written in Phase 173 and
patched once: §9's *"four real gaps (all four built in Phase 168)"* and §11's
*"seven of seven AI capabilities (was five)"*. Both were re-opened once,
neither has been checked since, and both are the shape — a list in a cell,
amended in place — that this process has now found wrong four times out of
five in §7.

The §11 row is the more interesting of the two: it was revised *upward* from
five to seven, which is the one direction a stale row has not yet been wrong
in here, and the revision happened before the AI module grew its retrieval,
provenance and settings layers. Whether "seven of seven" is still the right
denominator is the question, and §12's tool-layer decision above bears
directly on it.

Behind that: §20's *"Phases 0–8 all have shipped work"*, which is the last
unmeasured sentence in the file.
