# ADR 0006 — One gateway, and a suggestion is never an action

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §11 (optional AI module), §12 (AI technical architecture), §14 (roles), §19 (security), §22 (definition of done), §23 (product rules), §20 (Phase 6)
- **Builds on:** [ADR 0005](0005-marketing-consent-and-engagement.md)

## Context

Spec §11 asks for seven AI capabilities. Spec §12 asks for a gateway, provider
adapters, a versioned prompt registry, permission-enforcing tool and retrieval
layers, structured outputs, human-in-the-loop approval, a usage ledger, and
per-plan quotas.

But the constraint that shapes every decision here is not in §11 or §12. It is
in §23:

> AI is optional and additive, never required for basic accounting
> functionality.

and in §22, which requires the core milestone to work with no AI provider
configured. Those are not aspirations — they are testable claims, and this
phase is where they either hold or quietly stop holding.

## The prior phase's follow-up, unresolved

ADR 0005 said the next phase touching marketing should start with the campaign
scheduler. It did not: the user asked for Phase 6, and the scheduler remains
the gap ADR 0005 described. Nothing here changes that assessment.

## Decisions

### 1. Off is the state you get by doing nothing

A company with no `ai_settings` row has AI disabled. `registerCompany` writes
no such row, so every company created by onboarding starts off, and the tests
assert it.

This is stronger than a default value in a config file. There is no code path
where forgetting to configure something leaves AI on, because "unconfigured"
and "off" are the same state.

The UI follows: when the module is off, the assistant panel and the per-row
Assistant tab are **absent, not disabled**. A permanently greyed-out button is
not additive — it is a promotion for a feature you declined.

### 2. Every call goes through one function

`ask()` in `modules/ai/gateway.ts` is the only thing in the codebase that
reaches a provider. Its order is the design:

1. **Permission** — `ai:use`, or the call never happens.
2. **Gate** — module on, capability on, ceiling unspent, rate limit unbroken.
3. **Prompt** — resolved from the registry, with its version.
4. **Provider** — the only step that leaves the building.
5. **Validate** — Zod, against the same contract the JSON Schema declared.
6. **Meter** — a ledger row, on every path including the blocked ones.

Steps 1–2 precede step 4 so a blocked call costs nothing; a ceiling enforced
after the spend is not a ceiling. Step 6 runs even when nothing was sent,
because "why did nothing happen" is a question the usage ledger should answer.

`meter()` never throws. Losing a ledger row is a smaller failure than losing
the answer a user was waiting for.

### 3. A suggestion is a row, not an action

Model output lands in `ai_suggestions` with a status. **Accepting it calls the
same service a human uses** — `categorize`, `createRule` — under that person's
own `ActorContext`.

The consequence is the point: the audit log records
`transaction.categorize` by the person, exactly as if they had used the
dropdown, plus an `ai_suggestion.accept` event recording that a machine
proposed it. The ledger cannot tell the difference, because there is no
difference — a person decided either way.

Ordering is load-bearing: the real write happens **first**, and the suggestion
is marked accepted only after it succeeds. Marking first would leave a
suggestion recorded as applied against a change that never landed.

Rejections are recorded rather than deleted. They are the more interesting
half — the evidence for whether a prompt version is worth keeping.

### 4. The model may only choose from what it was given

`suggestCategory` looks the returned account id up in the list it supplied and
treats an unknown id as no answer. Without that check, a returned uuid is a
route to writing an arbitrary value into a journal line. The same rule applies
to anomaly findings and reconciliation suggestions: ids not in the input are
dropped.

Validation happens twice on the rule path — once when the payload is stored,
again when it is read back out of JSONB to create a rule that will categorize
transactions unattended.

### 5. Retrieval is gated on the permission the human would need

`modules/ai/retrieval.ts` checks `bookkeeping:view`, `crm:view`,
`reports:view` before reading. **AI must never become a way to read something
you could not read yourself** — a salesperson asking an assistant about cash
flow gets nothing, exactly as they would from the reports page.

The checks return empty rather than throwing, so an insight assembled from
five sources produces an answer from the four the user may see.

### 6. Prompts are versioned data, and rolling back is one press

Built-in prompts ship in code with explicit versions. A company may write its
own; a company version wins, and every ledger row records the key and version
that answered it. Saving never overwrites — it appends and activates, so the
version it replaced is still there. Activating `null` returns to the built-in.

Same shape as the clause library, for the same reason: you cannot compare
against a version you overwrote.

### 7. Cost is metered in millionths of a dollar

Money everywhere else in this codebase is integer cents. AI cost is not: a
single call can cost a small fraction of one, and rounding every call up to a
cent would overstate a month by more than the usage itself.

So `ai_requests.cost_micros` is millionths of a dollar, and it is documented
as a **meter, not an accounting figure**. Prices are quoted per million
tokens, which makes `tokens × pricePerMillion ÷ 1,000,000` exact for
whole-dollar prices. No float reaches a stored value.

### 8. The mock provider computes real answers

The default adapter answers from heuristics — a category from the merchant
name, a duplicate from same-merchant-same-amount within three days, an outlier
from a merchant's own median, insights from actual receivable and
concentration figures.

This is not convenience. Because the mock returns output of the same *shape* a
model does, everything downstream — schema validation, the suggestion queue,
the approval flow, metering, tenancy — is exercised end to end by the tests. A
stub returning `{}` would have left all of it untested.

It is deterministic, so a test asserts on behaviour rather than on whatever a
model happened to say.

### 9. Provider credentials never leave the server, and a missing one degrades

The Anthropic SDK is loaded through a **dynamic import inside `complete()`**,
so an unconfigured deployment does not so much as parse a vendor SDK. The key
is read from the environment, never returned by a route, never written to the
ledger, and provider error messages are truncated before storage.

`getAiProvider` falls back to the mock when the selected adapter reports itself
unconfigured, and the admin page says so plainly. A company that switched to a
real provider and has not set the key yet gets heuristic suggestions and a
visible warning — not a broken bookkeeping inbox.

## Consequences

- **No tool-calling loop.** Spec §12's "tool/function layer exposes only
  approved application operations" is implemented as the suggestion queue plus
  permission-gated retrieval, not as a model invoking functions directly. That
  is a deliberate narrowing: every consequential action in this product is one
  a person should confirm anyway, so a loop that executes on the model's
  judgement would have to be gated back down to the same approval step. When a
  genuinely low-stakes automation appears, the tool layer is the thing to
  build, and the suggestion queue is the model to keep.
- **No response caching.** §12 asks for "caching where safe". The `cache_hit`
  column exists and nothing sets it. Safe caching needs a key over the prompt
  *and* the underlying records, and getting that wrong serves a stale
  suggestion about a transaction that has since changed.
- **Quotas are per company, not per plan.** §12 says "per-plan quotas"; there
  is no billing plan model yet, so the ceiling is a per-company number an owner
  sets. When plans exist, the ceiling becomes a plan default this overrides.
- **Cost is an estimate.** Prices are a table in the adapter. A price change
  leaves historic rows at the figure computed at the time, which is right for a
  usage record and wrong for an invoice — this is not billing.
- **No evaluation harness.** Prompt versions can be created and rolled back,
  but "testing" in §12's phrase is served only by the acceptance rate. A/B
  running two versions against the same input is not built.
- **No streaming.** Every capability is a single structured response. The
  drafting assistants are the ones a user waits on, and they are the ones where
  streaming would help.
- **The mock's heuristics are not a model.** They are good enough to
  demonstrate and to test the machinery, and deliberately readable so nobody
  mistakes them for one. A company that enables the module and leaves the
  provider on `mock` gets keyword matching, and the admin page names the model
  as `mock-heuristic-v1` so that is visible.

## Follow-up

Two things are worth doing before more capabilities:

1. **The campaign scheduler**, still outstanding from ADR 0005 and still the
   one gap that changes behaviour rather than adding surface.
2. **An evaluation harness for prompts.** The acceptance rate already tells you
   *that* a version got worse; nothing tells you *before* you ship it. The test
   of whether this ADR's registry was designed right is whether such a harness
   can be built without changing how prompts resolve — if it needs a third
   resolution path, the registry is in the wrong shape.
