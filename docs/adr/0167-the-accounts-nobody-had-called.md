# 0167 — The accounts nobody had called

**Status:** accepted
**Date:** 2026-10-05
**Phase:** 167

---

## The nomination, and the part of it that was wrong

ADR 0166 nominated §11's last unimplemented capability, the **AI Strategic
Account Assistant**, and said it had *"`modules/marketing/segments`'
strategic-account segmentation to read from."*

Measured: `segments.ts` has `isStrategicAccount` as a **segment field** — a
boolean you can filter a marketing audience on. It is not relationship data and
there is nothing in it to summarize. The data this capability needs is somewhere
neither ADR 0165 nor 0166 mentioned: `engagement/communications.ts`,
`engagement/timeline.ts`, `opportunity_activities`, `proposals`, and invoices
reached through `customers.organization_id`.

Sixth phase running in which the inherited nomination needed correcting, and the
error was the same shape as the others: a claim about what the code contains,
written while reasoning about what the feature would need.

## What reading §11's sentence found

> Summarize relationship history, identify neglected high-value prospects,
> recommend next actions, and draft personalized outreach.

**Three of those four want a model and one does not.**

Identifying a neglected high-value account is `max(occurred_at)` against a
cadence, a sum of invoices, and a pipeline weighted by probability. That is
arithmetic a database does exactly and a language model approximates.

Handing it to the model would have done two specific harms. It would have made
the one part of this capability that can be **checked** into the part that
cannot — nothing can test that a model noticed an account. And it would have put
it behind the module §11 opens by saying the core product must work without:

> The core accounting product must remain fully functional without AI.

So `crm/attention.ts` is pure — no database, no clock, no gateway — and
`crm/accounts.ts` measures its inputs. `ai/accounts.ts` is the other three
verbs. With the module off, the list is still there and the button is simply
absent.

## The rule that shaped the registry

**A ground that fires on every row is not a finding.**

A `lead` nobody has phoned is not neglected; that is what a lead *is*. Flag
every one and the attention list becomes the organization table with extra
steps, which is exactly how a list teaches people to stop opening it.

So every ground declares the accounts it applies to, and `appliesTo` is held to
a floor by the same test that holds `because` — because the scope is the part of
a ground most likely to be wrong and the part a reader cannot infer from the
predicate. Writing that test caught `overdue-follow-up` with a nine-word scope
that argued nothing.

`lead` and `vendor` therefore have **no cadence at all**, which is a null in the
table rather than a large number: a large number would say "we expect to contact
vendors eventually", and we do not.

## Two numbers that needed arguing rather than choosing

**The strategic override tightens a cadence and never invents one.**
`is_strategic_account` is a separate column from the lifecycle stage, and the
schema says why — an existing client can also be strategic. So a strategic
active client takes the tighter of the two cadences. A strategic *vendor* still
takes none: marking a supplier strategic is a statement about the supply, not a
commitment to court them.

**What is at stake is a `max`, never a sum.** Adding realised revenue to the
weighted pipeline double-counts the commonest open opportunity there is — a
renewal of the revenue already in the first figure. A list that ranked a
renewing client above a genuinely larger prospect would be ranking by
bookkeeping accident. `max` makes no claim about whether the pipeline is
incremental; it answers the question the ranking needs, which is how much it
would cost to get this one wrong.

And the ranking puts **severity before money**. §11 asks for the *neglected*
accounts; the money is the tie-break, not the question. Ranked by stake alone, a
strategic target nobody has ever called sits below a large client who is a week
late.

## `asOf` is a parameter all the way down

Nothing in the core or the service reads the clock. A function that reads the
clock cannot be asked what the list looked like last Tuesday, and a test of a
cadence that has to wait is a test nobody runs. There is a test that asserts the
same account is on the list today and was not on it the day before the cadence
elapsed — which is the check having been seen to disagree as well as agree
(Phase 121).

## The ground that looked impossible, and the path that produces it

Writing the test for `unowned` found it never fired: `createOrganization`
defaults `owner_id` to whoever created the record, so every account entered by
hand has an owner. A ground that cannot fire is a declaration with no fact
behind it, which is Phase 110's defect.

Measured instead of assumed, and `intake.ts` is the path. A website lead has **no
acting user**, so the organization is inserted with no owner, an opportunity is
opened at `new_inquiry`, and the arrival is recorded as an *opportunity
activity* rather than a communication — so nobody has spoken to them either.

Which means the accounts most likely to be both unowned and uncontacted are the
ones that **arrived by themselves and asked to be sold to**. That is §11's
"neglected high-value prospect" almost exactly, it is the case nothing in the
product surfaced before this phase, and the test for it now goes through
`submitLead` rather than through a fixture that could not have found it.

`unowned` is also the only ground here that is a fact rather than a duration, so
it never resolves itself, and it is the one finding that blocks acting on the
others: every other item on the list is addressed to somebody.

## The migration is one enum value, and that is the decision

The obvious shape for this phase would have been a table — an
`account_attention` row per organization, refreshed on a schedule.

Measured against what the finding is, that is wrong. Every figure the list needs
already exists and is already authoritative somewhere else. A stored score would
be a second answer to a question six tables already answer, stale the moment
somebody logs a call — and two answers to one question is the defect this
codebase has found more often than any other.

So nothing is persisted but the usage ledger row for the assistant's call.
`'strategic_account'` arrives in `ai_feature` now rather than in Phase 165
because Phase 157's rule is that an unused declaration is kept when it accuses
and deleted when it excuses, and until something could write it the value would
have done neither.

## The prompt forbids re-deriving the findings

The one failure that would make this assistant worse than nothing is hedging a
measured fact — "it may have been some time since contact" written over a fact
that says nobody has ever called. So the first rule in the system prompt is that
the findings arrived measured and are not to be re-derived, contradicted or
softened, and the third is not to invent history: when the timeline is thin, the
thin record *is* the finding, and a confident narrative built from three rows is
worse than an honest sentence.

`adviseOnAccount` also refuses **before the gateway** when the account is not on
the attention list at all. An assistant asked for a strategy on a healthy
relationship has nothing to say worth a provider call, and the honest answer is
one the list already gives for free.

## Two other things the tests measured

The permission test first used a `bookkeeper` and resolved to `[]` instead of
throwing: a bookkeeper **does** hold `crm:view`, because they see who a
transaction was with. The role that proves the check is one that does not, so it
uses `readonly`.

And `factsForAccount` deliberately measures through the same path as the list
rather than running a narrower query of its own. A per-account figure computed
differently from the list's figure is two answers to one question, and the one a
person would act on is whichever screen they happened to open.

## A tripwire that had been red for six phases

The targeted run for this phase failed on `tests/refusal-audience.test.ts`, in
nothing this phase wrote. `withTenant`'s refusal of a nested tenant scope for a
*different* company — Phase 161 — is a bare `throw new Error` with a sentence
the audience heuristic reads as a person's. It has been failing since Phase 161,
and **nothing caught it, because no full suite has completed since Phase 160.**

Worth recording plainly rather than fixing quietly. Six phases have ended with a
suite stopped partway and targeted tests run on the files each phase touched,
which is fast and finds what a phase broke in its own neighbourhood. It cannot
find what a phase broke in a tripwire that reads the whole tree, and a tripwire
is the one kind of test that exists to be read by nobody until it fires.

The fix is the **twelfth** entry in `ALLOWED_BARE_REFUSALS` — the first added
since Phase 132 removed ten. A nested scope for a different tenant is a
cross-tenant bug by construction, so nobody at a keyboard caused it and nobody
at a keyboard can fix it; showing it would also put two company ids on a screen,
which is the leak ADR 0074 denies by default.

It was added rather than reshaped. Rewriting the sentence as a log fragment would
have made the heuristic right about it by making the message worse, and Phase 145
settled that direction: the sentence is the thing that has to be true. It reads
as prose because it is explaining the trap to whoever comes next, which is
exactly the false positive this list exists for.

## What this does not do

**No `apply`.** An outreach draft is text somebody edits and sends; a
recommendation is a sentence somebody acts on. Nothing is written to an
artifact, which is why — unlike Phase 166 — there is no provenance column here.
A draft that is never stored on a document has nothing to disclose on one, and
adding the column anyway would be a declaration with no artifact behind it.

**No cadence configuration.** `CONTACT_CADENCE_DAYS` is declared in code with
its reasoning attached. Making it a settings row before anybody has disagreed
with a number would be building the argument's resolution before the argument.

## What is nominated next

**§9's four analytics gaps**, which are the last items in ADR 0164's measured
audit: average proposal size, average time to decision, and `breakdownBy` over
the service/product and time-period dimensions. §11 is now complete — seven
capabilities, seven prompts, counted rather than claimed.

Then a **bullet-level pass over the spec sections `docs/SPEC-AUDIT.md` verified
only at module level** — §3–§8, §10, §12–§18. On this phase's evidence that pass
is worth more than it sounds: §11's module-level tick was right and its
sentence-level reading moved where half the capability belongs.
