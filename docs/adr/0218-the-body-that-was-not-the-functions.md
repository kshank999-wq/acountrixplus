# ADR 0218 — The body that was not the function's

**Status:** accepted · **Phase:** 218 · **Spec:** §14, §7, §8

> **Written after its code**, unlike ADRs 0215–0217. The eight-shard run for
> Phases 216 and 217 had finished before this phase began, so there was no
> suite to contaminate — and the measurement wanted the scan repaired before it
> could be trusted, which is the whole subject.

## The nomination, and the question underneath it

ADR 0217 nominated **the screen that offers what it will refuse**:

> Nine acts just became stricter than the screens offering them.
> `/settings/chasing` and `/settings/statements` guard `accounting:view` while
> every act on them now needs `accounting:journal`; `/jobs/cost-codes` guards
> `jobs:view` while its one button needs `jobs:manage`. So `readonly` is still
> admitted to three screens on which nothing it can press will work. The
> measurement: for each of the 71 guards, the acts that screen offers, and
> whether any role the guard admits can perform any of them.

All three named screens already pass the right flag:

```tsx
// src/app/settings/chasing/page.tsx
if (!can(actor, 'accounting:view')) { … }
…
  canManage={can(actor, 'accounting:journal')}   // and board.tsx honours it twice
```

So does `/settings/statements`, and `/jobs/cost-codes` hands its library
`canManage={can(actor, 'jobs:manage')}`. The nomination was wrong about all
three, and wrong in a way worth keeping: it had counted the **71 refusing
guards** and taken those to be everything a page does with a permission. There
are **198** `can(actor, …)` decisions in `src/app` — 71 refusing guards, **73**
flags handed to a component, 25 reads skipped by a ternary, and 13 other shapes.
A screen does not merely admit people; it computes, per control, what that
control needs.

Which makes the real question sharper than the nominated one. The screen's flag
and the act's gate are **two independent statements of one requirement**, and
nothing in the tree compares them. To compare them you have to read a gate.

**Gates could not be read.** Three defects, and they are all one shape: *the
scan cannot read the gate and answers anyway.*

## 1. The reading that could not see a generic function

`enclosing.ts` exists because ADR 0134 found a fixed-line window leaking past a
function boundary and excusing a real defect, and its header says why it is a
module rather than fixed copies:

> A constraint beats a check (Phase 116). Four copies of a fixed function is
> four things that can drift apart again, and the next scanner makes five.

Its three readers anchor a declaration like this:

```js
/^(?:export )?(?:async )?function (\w+)\(/gm
```

The `(` must follow the name. A generic function does not oblige:

```ts
export function scoped<T extends PgTable & { companyId: PgColumn }>(
export async function runOnce<T extends Record<string, unknown>>(
export async function ask<T>(ctx: ActorContext, input: AskInput<T>)
```

`functionBody` in `gate-forms.ts` used a **different** reading —
`function\s+${symbol}\b` — which does match a generic. So it found the
declaration, handed the offset to `enclosingSpan`, and `enclosingSpan` could not
see it: it attributed the offset to the **previous** declaration and ran the span
on to the next one it recognised.

```
functionBody('src/modules/tenancy/context.ts', 'scoped')
  -> enclosingSpan(raw, 2249) = { from: 1784, to: 3382 }
```

1784 is `can`. 3382 is the end of the file. Asked for `scoped`, it returned
`can`'s body and everything after it — every gate in the rest of the file,
under one symbol's name, with nothing marking the answer as wrong.

**12 of the 2,153 exported functions in the tree are generic, and `functionBody`
returned the wrong body for every one.** Three further consequences, all silent:

- `enclosingSymbol` attributes every site inside a generic function to the
  previous function — **ADR 0134's leak, in the function written to stop it.**
- `declaresFunction` answers `false` for a generic helper, so `establishedBy`'s
  same-file walk never followed one.
- And the shape: *two readings of where a function begins, and they disagree.*
  Two answers to one question, inside the module built to be the one answer.

There is now one exported `DECLARATION`, and all four readers use it — including
`bodyAt` in `the-gate-the-scan-could-not-read.test.ts`, which was a local copy of
exactly the pair that disagreed. **That was the fifth copy ADR 0134's own note
predicted, and the next scanner was the test for the module.**

## 2. A signature is not a body

`functionBody` sliced from the declaration, so the parameter list was part of the
text being scanned for checks. `CHECK` is `/\b(?:requirePermission|can)\(/g`, and
`secondArgument` balances brackets, so:

```ts
export function requirePermission(ctx: ActorContext, permission: Permission): void {
```

answered `permissionChecksIn` with the computed check `permission: Permission`.
**The permission checker read its own declaration as a check.** Four functions,
all in `tenancy/context.ts` — and two of them, `scoped` and `assertOwnedBy`, only
because defect 1 had already handed them `can`'s body.

The body now starts at the brace that opens it, past a balanced parameter list,
so a parameter whose type is an object literal does not cut it short either.

A third classification came out of the same fix. A check whose argument is a
**bare identifier the function binds** states no permission of its own:

```ts
async function ifPermitted<T>(ctx, permission: Permission, read, fallback) {
  return can(ctx, permission) ? read() : fallback      // the caller's gate, not its own
}

if (!permissionsToRead(entityType).some((permission) => can(ctx, permission))) {
```

Those are `forwarded`, kept under their own name. Dropping them would make the
functions read as ungated, which is ADR 0134's direction; answering them is what
defect 3 did. A third name is the only reading that is neither.

## 3. The catch that guessed

```ts
    } catch {
      // An unreadable computed gate is still a gate: Phase 214 refuses on the
      // expression elsewhere, and treating it as absent here would be the
      // false positive this module exists to stop making.
      found.push('company:manage')
    }
```

The comment is right about the direction and wrong about the remedy. It **invents
a real permission**, which lands in the same array, with the same type, beside
permissions that were actually read. Nothing downstream can tell the two apart,
and one of them is wrong.

`resolveComputedGate` throws for precisely this reason, and Phase 214 wrote the
reason into the refusal itself:

> guessing would answer that question wrongly in silence, which is the defect
> Phase 214 exists to stop

**Its only caller caught the refusal and guessed.** Measured over the 329 server
actions:

| | |
|---|---|
| acts reporting `company:manage` | **34** |
| genuinely gated on it | **23** |
| told they were | **11** |

All eleven were *wholly* invented — the substitute was their entire reported
gate. Five were evidence acts on `subjectDefinition(input.subjectType).manage`,
including `uploadEvidence`, the act Phase 214 looked straight at and still did
not declare a resolver for, because the invented answer was indistinguishable
from a read one. Two were `mergeParties` and `mergePreview`, **reported as
owner-only while the code gates a customer merge on `crm:manage` and a supplier
merge on `accounting:journal`** — a manager may merge two customers and an
accountant two suppliers, and a merge is irreversible, which is exactly the kind
of act a register of gates must be right about.

### Why five read as the count

GATE_RESOLVERS' docstring says:

> Measured rather than assumed: **across all 254 audit-writing functions** there
> are exactly **five** distinct computed check expressions

True, and its scope is invisible one line later. Phase 217 built a second scan
over a different population — 329 actions and everything they reach — and the
tree holds **20** distinct computed expressions. The register covered 5 of 20,
and 8 of 34 occurrences: **the scan invented more gates than it read.**

The repair is not a better sentinel. The catch is deleted, every expression in
the tree is declared (17 entries, since four of the fifteen were never gates at
all — they were defect 2), and a test over the tree keeps it so: the next
undeclared expression stops the suite instead of being answered. Phase 214's own
pin — that the register holds *exactly* the five of the audit-writing population
— moves to a subset check, with the equality asserted where it belongs, over the
tree.

## The third question, and the fourth scan error

Neither existing function answers what a screen must ask. `establishedBy` stops
at the **first** gate; `authorityOf` unions **one file**. For the screen the
question is *if this person presses the button, will it work?*

```ts
export async function updateCustomerAction(input: unknown) {
    const before = await customerById(actor, id)   // crm:view
    await updateCustomer(actor, id, fields)        // crm:manage
```

`establishedBy` returns `['crm:view']` — true, first, and useless: a screen
reading it concludes that anybody who may read a customer may correct one.
`authorityOf` never reaches `updateCustomer`, which is in another module. So
`demandedBy` is new, and returns a **conjunction of disjunctions**, because a
literal check and a resolver's `yields` are different relations and a flat
`Permission[]` cannot tell them apart — `['accounting:journal',
'accounting:view']` is "both" for `closeShift` and "either" for a computed gate,
and read as the wrong one a bookkeeper either may or may not close a till.

It also over-collects, and this phase walked straight into the warning Phase 214
wrote down:

> a transitive scan over-collects in a way it cannot detect — it cannot tell a
> refusal that *blocks* an act from one it *tolerates*

`sendInvoice` gates on `accounting:journal` and calls `logCommunication`, which
requires `crm:manage`, so the walk concluded an accountant cannot send an
invoice. They can: the call is inside `if (row.customer.organizationId)` and
carries `.catch(() => {})`, with the trade written beside it — *"a timeline entry
is a nicety; the invoice has been sent either way."* The swallowed half can be
read off the source exactly, so it is; the **conditional** half cannot, and
`demandedBy`'s docstring says so rather than pretending otherwise. A gate on a
branch is still over-collected, and `logTimeAction` is pinned as exactly that so
the next phase does not read it as a defect.

## Eight scan errors, and what each cost

This phase's own scan was wrong eight times. On the record, because the pattern
is now unmistakable: every one was found by *looking at the finding*, never by
the property passing.

| | the error | what it produced |
|---|---|---|
| 1 | paired every flag with every act its component imports | 344 pairs, 42 "defects", all nonsense |
| 2 | matched only `{flag && (`, missing `{open && flag && (`, `{props.flag && (`, `{flag && rows.length && (` | 154 acts wrongly "behind no flag" |
| 3 | read `GATE_RESOLVERS`' yields conjunctively | two false defects in the designer |
| 4 | collapsed a component's two mountings into one record | false "blocked" rows |
| 5 | dropped the page guard | 7 of 7 of direction B |
| 6 | asked `establishedBy` where the question needed every gate | missed `updateCustomer` entirely |
| 7 | treated a `.catch`ed call as mandatory | 5 false defects on the sending acts |
| 8 | compared each enclosing flag separately rather than their conjunction | 2 false defects, `/shop` among them |

Error 8 is the one worth keeping. `shop/board.tsx` writes
`{canManage && … {canBill && <Bill it>}}` — the correct, ordinary way to put a
stricter control inside a broader region — and comparing the flags one at a time
calls the outer one a defect. The scan was about to report a defect in the file
that demonstrates the fix.

## What the measurement actually found

With a scan that reads gates and compares conjunctions, across 73 flags, 54
components and 259 act references:

- **the screen offers what the act refuses: 1**
- **the screen hides what the act allows: 0**
- acts behind no flag region where the screen admits somebody the act refuses
  and no flag names the act's permission: **2**, both over-collection or a
  guard form still unread

The one: `/crm/proposals` offered **"Invoice `<stage>`"** behind
`canManage = proposals:manage`, and `billStage` raises an invoice under
`accounting:journal`. Two of the three roles the screen admits — `manager` and
`sales` — were offered a control that refused them. The fix is a second flag, and
the name was already in the tree: `shop/page.tsx` passes
`canBill={can(actor, 'accounting:journal')}` beside its own `canManage`, for the
identical reason, because completing a repair order posts to the ledger.

## And one gate, not screen, was wrong

`src/modules/design/documents.ts` holds, thirty lines apart:

```ts
/** Exported since Phase 166, which … found that writing the answer out again —
 *  `proposals:manage`, as the first draft of `suggestLayout` did — refuses a
 *  marketer the right to reorder their own creative. One designer serves both
 *  kinds, so there has to be one answer to what it takes to edit one:
 *  two answers to one question is the defect. */
export function permissionFor(kind: string, level: 'view' | 'manage'): Permission {
  return kind === 'marketing' ? `marketing:${level}` : `proposals:${level}`
}

export async function saveAsTemplate(ctx, documentId, input) {
  requirePermission(ctx, 'proposals:manage')     // ← writes the answer out again
  …
    .values({ kind: document.kind, … })          // ← and it knows the kind
```

The comment diagnoses the defect and the function below it commits it, storing
the very `kind` it declined to gate on. `designer.tsx` is mounted by two
screens — the proposal editor (`isEditable` from `proposals:manage`) and the
creative studio (`isEditable` from `marketing:manage`) — so **a marketer in the
studio was shown *Save as template* and refused by it**, the one role the screen
admits for whom the control could never work.

The check now reads `permissionFor(document.kind, 'manage')`, below the load,
which is the order `linkAsset` uses and the order `GATE_RESOLVERS` gives the
reason for: *"resolves the subject first and then gates on it."*

This is also why the count in Phase 214's test moved from twelve recovered gates
to thirteen — and the thirteenth is **not** one the repaired reader recovered. It
is `saveAsTemplate`, which this phase moved from a literal to a computed gate. A
count that grows right after a scan is fixed invites exactly the wrong reading,
so the breakdown is pinned beside it and the thirteenth is named.

## What moves

One exported `DECLARATION` and four readers using it, the test's own copy
included. `declarationOffset` and `parameterNames` beside it. `functionBody`
anchored on the symbol and cut at the body brace. `permissionChecksIn` gains
`forwarded`. `GATE_RESOLVERS` goes from 5 entries to 17, covering every computed
expression in the tree. The catch that invented `company:manage` is deleted.
`demandedBy`, `clausesIn`, `refusalSwallowed` and `rolesSatisfying` are new. One
screen gains `canBill`; one gate stops writing its module's own answer out again.
No schema change, no migration, no new permission.

Phase 214's and Phase 217's falsifiers all still hold, and `ungatedActions()` is
unchanged at 38 — the scan got more accurate without re-baselining a single
answer it had already given.

## Nominated for Phase 219

**The flag that nothing pins to the act it guards.** This phase answered ADR
0217's question with a scan, got it wrong eight times, and the eighth error was
about to report a defect in the file that demonstrates the fix. Phase 214 already
said why, and prescribed the remedy this phase declined to build:

> The repair is two registers rather than a deeper scan, because a transitive
> scan **over-collects in a way it cannot detect.**

So: a register of the 73 flags. Each entry names the screen, the prop, the
permission, and **the act the control behind it invokes** — and the falsifier is
the one this phase ran by hand: the conjunction of the flags enclosing a control
must admit nobody the act will refuse. A register gets the conditional case
right, because an entry can say *"on a branch, and here is why that is
deliberate"*, where the scan can only guess; and it makes the two remaining C
findings decidable rather than probably-over-collection: `quoteDocumentTaxAction`
at `tax:view` on a screen admitting `readonly`, and `logTimeAction` reaching
`users:manage` on a branch.

The measurement to do first, because a nomination inherited is a nomination
unmeasured (Phase 164): how many of the 107 act references this phase could not
place in a flag region are placed by a form the span reader still misses, as
against genuinely unflagged. 107 is too large to be all defects and too large to
be all scan error, and which it is decides whether the register is 73 entries or
180.

Behind that: the twelve findings still in the column register; the CRM account
panel's missing payables side (ADR 0208); the four joins from an unscoped primary
(ADR 0198); and §11's six remaining functions.
