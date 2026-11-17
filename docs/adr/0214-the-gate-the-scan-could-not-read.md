# ADR 0214 — The gate the scan could not read

**Status:** accepted · **Phase:** 214 · **Spec:** §14, §19

## The nomination, and the sentence in it that was false

ADR 0213 nominated **the act with no gate**: *"44 write sites whose enclosing
function requires no permission at all"*, with one instruction — measure, for
each, whether it is gated upstream in a server action, reached by a public
token, run from a worker, or not gated anywhere, *"only the last group is a
finding"*.

Measured, **twelve of the forty-four do require a permission.** The nominating
sentence was not a summary of the code; it was a summary of what one regular
expression could see:

```js
/requirePermission\(\s*\w+\s*,\s*'([a-z_]+:[a-z_]+)'/
```

That pattern is wrong about **both** of the check's arguments. It wants a bare
identifier for the context and a string literal for the permission, and twelve
functions fail one or the other:

| missed because | count | example |
| --- | --- | --- |
| the permission is **computed** from the record's own kind | 8 | `requirePermission(ctx, subject.manage)` |
| the refusal is **soft** — `can` and a returned error, not a throw | 3 | `if (!can(ctx, 'marketing:manage')) return { ok: false, … }` |
| the **context** is a property access | 1 | `requirePermission(party.ctx, 'company:manage')` |

Tree-wide there are **30 computed permission checks against 795 literal ones** —
one in twenty-seven. The soft ones are all nine of the `if (!can(` checks in
`src/modules`, every one in the AI module, for a reason that is right: an
assistant explains why it will not help where a service throws.

That is the fifth phase running where measuring an inherited nomination changed
the subject rather than confirming it, and the first where the nomination's own
*numbers* were the artefact being measured.

## The four categories were the wrong four

Two of them cannot occur here and one the nomination had no name for.

- **"Gated upstream in a server action" is not a thing this codebase does.**
  `src/app` holds eleven `requirePermission` calls in three files, because the
  architecture puts business logic and its gates in `src/modules`. The category
  was a guess about a codebase this is not.
- **"Run from a worker" is empty.** The sweeps that look like background work —
  `importTransactions`, `recordRevisions`, `applyRulesToNewTransactions` — are
  reached from `syncConnection` under `bookkeeping:import`. There is no job
  runner among the forty-four.
- **The practice side has its own authority model.** `requirePracticeOwner` is
  used eight times and is not a `Permission` at all, so `blindProducers` — which
  iterates `ROLE_NAMES` — can say nothing about those acts in either direction.
- And a **tenth** form turned up while the register was being written:
  `endEngagement` gates `company:manage` if the party is the client and
  `requirePracticeOwner` if it is the practice. An either/or across two authority
  models, chosen by which side is speaking.

Nine forms, not four. ADR 0213's own closing sentence — *"the four categories are
not a defect and three of them are"* — is garbled as well as wrong; what it meant
to say is that three of the four are not defects, and the real answer is that
there were never four.

## What it cost: the property was narrower than its prose

Nothing about the *code* was unsafe. Every one of the twelve is gated. What was
wrong is the property.

`blindProducers()` skips a site whose gates are empty, on a stated reason: *an
ungated act names no producer and so blinds nobody.* For those twelve a
producing role exists and the scan — not the code — named none, so nobody had
ever asked whether those producers can read what they write.

One of them could not. All five entries in `ASSET_SUBJECTS` declare
`manage: 'marketing:manage'`; `asset` was in no entry of `READABLE_BY`, so its
history needed `audit:view`; and `marketing` holds the first and not the second.
**A marketer could attach an asset to a campaign, detach it again, and read the
history of neither act.**

That is the exact defect Phase 213 built a property to forbid, sitting inside the
gap its own reader left — ADR 0134's shape appearing in the device written to
avoid ADR 0134's shape. Phase 78's sentence, found for the third time by the
third different method.

## Why a register and not a deeper scan

The obvious repair is to follow the calls. It does not work, and the reason is
worth keeping, because it is the argument for every register in this codebase.

A transitive scan **over-collects in a way it cannot detect**: it cannot tell a
refusal that *blocks* the act from a refusal the act *tolerates*.
`transactionContext` returning `null` for a reader without `bookkeeping:view`
stops `suggestCategory` dead. Another helper returning `null` on the same check
merely omits a paragraph from a prompt. The two are identical in source and
opposite in meaning, so a scan counting both hands back confident numbers that
are wrong in both directions — and a first attempt at one here duly reported
`lastContactLine` as a caller of `adviseOnAccount`.

What a scan *can* do is check a claim somebody made. So:

- **`GATE_RESOLVERS`** maps each computed check onto the permissions it can
  yield. There are exactly **five** distinct computed expressions across all 254
  audit-writing functions, which is what makes a hand-written table honest
  rather than a sample. A set means *any one of them*: the permission is chosen
  from the record's kind, so holding the marketing key performs the act on
  marketing records. An unknown expression is **refused**, because resolving it
  to "no permission" is exactly how the twelve came to be excused.
- **`OPEN_ACTS`** declares why each of the remaining **31** functions needs no
  permission, in six categories — `self`, `token`, `bootstrap`, `internal`,
  `delegated`, `practice` — each with a consequence the source can falsify: a
  `self` act must constrain by the actor's own user id, a `token` act must have
  no `ActorContext` to gate, an `internal` act must be unreachable from
  `src/app`, a `delegated` or `practice` act must name a gatekeeper that exists
  and really refuses. That is Phase 116's rule: a scan that reports a symbol must
  be checkable.

A permission is the wrong instrument for most of the thirty-one rather than a
missing one. There is no role that may not change its own password, and inventing
`security:self` would mean an owner could revoke it and lock somebody out of
their own account.

## The second defect: a check that ran late

Found while writing the register, and a harder shape to see than a missing check.

`uploadEvidenceAction` called `storeDocument` and then `attachDocument`, and only
the second gates. So a member with no permission on the subject had the bytes put
in the object store, a `documents` row written over them and a `document.store`
audit event filed — and *then* got their refusal. **Every test of the refusal
passed, because the refusal did happen.**

`storeDocument` cannot gate on its own account: it is told the bytes and not what
they are *for*, so it has no subject whose permission to ask about. The fix is a
caller that knows both halves — `attachNewDocument` — which also takes the
decision out of `src/app`: the action names one function instead of sequencing
two, and the permission is settled before anything is written. `storeDocument` is
then genuinely `internal`, which is the checkable half of its declaration.

## What moved

263 write sites: 223 literal-gated, 8 computed-gated, 32 behind no check at all
over 31 functions, every one declared. Two new registers, 46 throwing registry
lookups. One entity type placed, `asset`, taking its history from `accountant`
and giving it to `marketing` on Phase 72's argument. One ordering fix. No schema
change, no migration, no new audit action.

## Nominated for Phase 215

**The soft refusal that is not a permission.** This phase taught the scan to read
`if (!can(ctx, 'x')) return { ok: false }` as a gate, and that is right for the
nine in the AI module. But a soft refusal and a thrown one are not
interchangeable, and nothing says which an act should use. `requirePermission`
throws a `PermissionError` with a status of 403; `can` plus a returned error
produces a sentence the caller may ignore — and the scan now treats them as
equivalent.

The measurement to do first: for each of the nine, whether the returned refusal
is **checked by every caller**. A soft refusal whose caller drops the result is a
gate in name only, and the audit scan would now be reporting the act as properly
gated. Only callers that ignore it are a finding.

Behind that: the twelve findings still in the column register, of which the four
`notes` columns and the two `journal_entry_id` columns are substantial; the CRM
account panel's missing payables side (ADR 0208); the four joins from an unscoped
primary (ADR 0198); and §11's six remaining functions.
