# ADR 0217 — The permission that only promises to look

**Status:** accepted · **Phase:** 217 · **Spec:** §14, §13, §19

> **Written before its code**, like ADRs 0215 and 0216 and for the same reason:
> the full eight-shard run for Phase 216 is going, and writing to `src/` or
> `tests/` while it runs contaminates it. The measurement below was taken
> against `d450398`. The implementation is staged and lands next.

## The nomination was the wrong question, and measuring it is what showed that

ADR 0216 nominated **the page guard that guards nothing**: 70 page-level
`if (!can(actor, 'x'))` guards in `src/app` against eleven `requirePermission`
calls in three action files, with the measurement to be "for each page guard, the
actions that page invokes, and whether the module function behind each
establishes that page's permission — reusing `establishedByImplication`, because
a page gated on `accounting:view` calling an act gated on `accounting:journal` is
safe and the reverse is not."

Three things about that are wrong, and the third is the phase.

**The figures are wrong.** There are **71** such guards, not 70 — one is in
`api/pdf/version/[id]/route.ts`, which is a route handler rather than a page, and
`payroll/workpapers/page.tsx` has two. And `src/app` holds **8**
`requirePermission` calls, not eleven:

```
operations.ts  5      security.ts  1      inventory.ts  2      = 8 calls
operations.ts  6      security.ts  2      inventory.ts  3      = 11 occurrences
```

The difference is three `import { requirePermission } from '@/modules/tenancy/context'`
lines. Phase 214 counted a bare symbol and three of its eleven hits were the
import that makes the symbol available. The figure is repeated in ADR 0214, in
ADR 0216, twice in `README.md` and in `SPEC-AUDIT.md`, and it is corrected in all
of them by this phase. It changes no argument — gates live in modules, and eight
makes that case more strongly than eleven — but a number cited as evidence has to
be the number.

**The population is wrong.** The comparison "71 page guards against 8 action
checks" implies the endpoints are the thing being counted. They are not. There
are **329 exported server actions in 44 files** under `src/app/actions`. Resolving
each one's gate through Phase 214's `permissionChecksIn` and `resolveComputedGate`
and following calls: **290 establish a permission and 39 do not.** The 39 are 4
pre-authentication, 4 bearing a public share token, 13 self-acts, 15 on the
practice side under `requirePracticeOwner`, 2 that compute on client-supplied
input and touch no company data — and **one** with no permission anywhere in its
chain.

Those are the figures after this phase's scan was fixed four times. The first
version reported **47**, and the four it was wrong about are set out below,
because three of them are named as defects in a draft of this document and the
cause is the same each time.

**And the relation is wrong**, which is the part worth a phase. The nomination
asked whether an action's gate is at least as strict as its page's. Consider what
that question returns for the page it names:

| page | its guard | the act behind it | what the act required |
| --- | --- | --- | --- |
| `/settings/chasing` | `accounting:view` | sends a dunning email to every overdue customer | `accounting:journal`, inside a loop, inside a catch |
| `/settings/statements` | `accounting:view` | saves and emails a statement to every customer | `accounting:view`, in its callees |
| `/jobs/cost-codes` | `jobs:view` | creates cost-code records | nothing |

Gating `runChases` on `accounting:view` would make the action agree with its page
exactly, satisfy the nominated property, and still let a **read-only** user send
dunning letters to every overdue customer — because `readonly` holds
`accounting:view`. **A page guard is a statement about who may look at a screen.
It is not a specification of what the act behind it may do**, and measuring an act
against one asks the act to be as strict as a sentence that was never about
strictness. Phase 121's shape: the check would have been seen to agree, and
agreement was the wrong outcome.

The middle row is the one to sit with. `saveStatement` and `sendStatement` each
required `accounting:view`, so the run did not fail part-way for a read-only
user: **it completed**, saving and emailing every statement due. There was a
gate. Every caller reached it. It threw a `PermissionError` naming its
permission. Phase 214's question, Phase 215's and Phase 216's are all answered
yes, and the company's customers got letters from the one role defined as unable
to change anything.

## The question none of the last three phases asks

Phase 214 asked **is there a gate?** Phase 215 asked **can the refusal say why?**
Phase 216 asked **did the caller establish the permission?**

```ts
export async function sendStatement(ctx: ActorContext, statementId: string) {
  requirePermission(ctx, 'accounting:view')
  …  // emails the statement to the customer
}
```

That passes all three. There is a gate; it throws a `PermissionError` that names
the permission; every caller reaches it before the send. It is also wrong, and
the question that says so is one this codebase has never asked:

> **Is it the right permission?**

`accounting:view` is a promise. Five permissions in the table are built out of
the word *view*, and the role named `readonly` is defined as holding nothing
else:

```ts
readonly: ['bookkeeping:view', 'reconciliation:view', 'accounting:view',
           'reports:view', 'jobs:view'],
```

So the property needs no new vocabulary and no judgement about which permission
outranks which:

> **A permission that a view-only role holds must not be the only gate on an act
> that writes or sends.**

Which roles are view-only is computed from `ROLE_PERMISSIONS` rather than listed
— today exactly one, `readonly` — so the oracle moves when the role table moves.
That is Phase 216's arm 2 again, used as a definition this time rather than as an
implication.

## What it found

**Ten acts in `src/modules` are gated only on a permission `readonly` holds and
write or send.** The detector reads writes in a function's own body only, so it
under-collects, which is the safe direction for a claim of this kind. Seven are
defects:

| act | its gate | what it does |
| --- | --- | --- |
| `receivables/statements.ts::saveStatement` | `accounting:view` | writes a statement record |
| `receivables/statement-send.ts::sendStatement` | `accounting:view` | emails the statement to the customer |
| `receivables/statement-send.ts::statementLinkFor` | `accounting:view` | mints a public share token for it |
| `payables/remittance-send.ts::sendRemittance` | `accounting:view` | emails a remittance advice to a vendor |
| `payables/remittance-send.ts::remittanceLinkFor` | `accounting:view` | mints a public share token for a payment |
| `payables/pay-runs.ts::adviseRun` | `accounting:view` | advises every vendor in a pay run |
| `receivables/service.ts::createVendor` | `accounting:view` | creates a supplier |

Three are correct and are declared rather than changed: `updateTime`,
`deleteTime` and `submitTime` are self-acts, and `loadOwnEditable` escalates with
`requirePermission(ctx, 'users:manage')` for somebody else's timesheet. The scan
could not see that, for a reason this phase has to own; see below.

Two more belong with them, found by the ungated scan rather than this one:

- **`exporter/service.ts::readinessFor`** is gated — `assemble` requires
  `reports:view` — and that is the mislabelled kind rather than the missing kind,
  because `readonly` holds `reports:view` and this hands back the whole
  accountant package and an exception report on the books. In the same file,
  `exportForAccountant` and `exportHistory` both require `reports:financial`. A
  permission to export the books, the same to see *that* an export happened, and
  a view permission to assemble them. The write detector did not flag it because
  it does not write; the role did.
- **`jobs/cost-codes.ts::installDefaultCostCodes`** is the one act in the whole
  329 with no permission anywhere in its chain that is not a self-act, a
  token-bearing act, a bootstrap act, or on the practice side. It creates
  cost-code rows; `createCostCode` and `updateCostCode` below it require
  `jobs:manage`; the page offering it guards `jobs:view`, which `readonly` holds.

And one the scan accused and the code acquitted: **`segmentSummary`** reaches
`evaluateSegment`, which requires `marketing:view`. It is gated by delegation,
and it is in this document only because a draft had it as a defect.

**`createVendor` is the one to read twice.** Sixty lines above it in the same
file, `createCustomer` requires `crm:manage`. `createVendor` requires
`accounting:view`, and its own comment says:

> `/** As on the customer side. See \`createCustomer\` (Phase 47). */`

The comment claims a parity the gate does not have, and `readonly` holds
`accounting:view` and not `crm:manage` — so the gap between the comment and the
code is exactly the gap between not being able to create a customer and being
able to create a supplier.

**`statement-run.ts` is the sharpest single file.** In one file:

- `updateStatementPolicy` — `accounting:journal`, to change *when* statements go out
- `recentStatementSends` — `accounting:view`, to read the log of *what was sent*
- `saveStatement` / `sendStatement` — `accounting:view`, to write one and send it
- `runStatements` — **nothing**, to do the whole run

A permission is required to see what was sent and none to send it. And because
`saveStatement` and `sendStatement` both settle for `accounting:view`, a
read-only user's run does not fail part-way: **it completes**, saving and sending
every statement due. The role whose entire definition is that it changes nothing
emails the company's customers.

## The refusal reported as a delivery failure

`runChases` is different and worse-shaped. `sendInvoice` *does* require
`accounting:journal` — *"The same permission that raises one. Somebody trusted to
create a debt is trusted to ask for it."* But the gate is reached inside the loop,
through a `catch` that was written for a different kind of failure:

```ts
if (!preview.policy.enabled) return base      // no gate reached
…
for (const row of preview.due) {
  try {
    const result = await sendInvoice(ctx, row.invoice.id)
    …
  } catch (error) {
    failed++
    // Logged rather than rethrown: one bad address is not a reason to leave
    // the rest of the day's chases unsent.
    logUnexpected(error, `chasing invoice ${row.invoice.number}`)
    notes.push(`${row.invoice.number}: ${…error.message}`)
  }
}
```

That comment is right about a bad address and wrong about a `PermissionError`. A
read-only user pressing *run now* gets `0 sent, 12 could not be sent` with twelve
notes reading *"Missing required permission: accounting:journal"* — Phase 47's
defect, since "could not be sent" tells you to go and check the addresses. The
act attempts every send and reports itself as having run.

And both sweeps return before the loop twice — when the policy is off and when
nothing is due — so on most days the gate is **never reached at all** and a
reader is told *"Nothing was due today."* That is Phase 216 exactly, one module
over: nothing due is an answer only if you were allowed to look.

The fix is therefore not "add the gate the callee already has". It is a gate at
the **top of the act**, before the policy read, so that the answer is one
refusal instead of N delivery failures and the early returns cannot answer for
books the reader may not see.

**The worker is free.** `systemActor` is `owner`, and deliberately: *"a lesser
role would mean a nightly job quietly doing less than the code it replaced …
What actually limits a job is which handlers exist, and that is decided in source
at registration time rather than at runtime by a role."* The scaffolding that
makes module gates safe under scheduled work already existed; these two modules
never used it.

## Four false positives, two causes, and both are this phase's own scan

**Cause one: the scan read only each function's own body**, so a gate one hop
down in a private helper in the same file was invisible.

1. `planImportAction` looked ungated. Its gates are behind `buildPlan`, a helper
   declared in the action file, and all five of `planAccountImport`,
   `planContactImport`, `planTrialBalanceImport`, `planOpenDocumentImport` and
   `planStatementImport` require a permission.
2. `rejectSuggestion` looked ungated. `decide` requires `ai:use`.
3. `deleteTime`, `updateTime` and `submitTime` looked mislabelled.
   `loadOwnEditable` requires `users:manage` for anybody else's entry — *"somebody
   else's timesheet needs the permission that manages people."*

**Cause two, and the serious one: the scan matched only `@/modules/...`
imports.** This codebase imports a sibling file in the same module relatively —
`import { transactionContext } from './retrieval'` — and a gate's commonest
home is a sibling file. Reading one of the two import forms moved the count from
47 to 39 and silently cleared four acts: `suggestCategoryAction`,
`exportReadinessAction`, `runChasesNowAction` and `runStatementsNowAction`. **A
draft of this document asserted three of those as having no gate at all.** They
each have one; what is wrong with them is where it sits and which permission it
names, which is a different and smaller claim than the one I was about to
publish.

This is ADR 0134's shape twice more — a scan whose window stops short of the
thing it is deciding about — and both are false *positives*, which Phase 126 puts
on the worse side: an entry that excuses a site reads exactly like one that
describes it, and a finding that overstates reads exactly like one that holds.
The repair is to follow functions declared in the same file (checkable with
`declaresFunction` and `functionBody`) and to read both import forms. The seven
sites above are the test cases, and the register's falsifier is what keeps them
so: the count is asserted against the register, so a scan that regresses to
reading one import form fails rather than quietly growing the register.

The methodological point is Phase 164's, and it arrived from the inside this
time. *A nomination inherited is a nomination unmeasured* — and so is a
measurement whose instrument has not been falsified. The instrument here was
wrong four times, and what caught it each time was reading the code the scan had
just accused.

## The over-collection, measured rather than feared

Phase 214 argued a register beats a transitive scan because a transitive scan
over-collects in a way it cannot detect. This phase has the figures.

The per-file sibling relation alone — *an exported `ActorContext` function with
no gate, in a file whose other exports do gate* — collects **98** sites across
130 files, and the great majority are internal helpers (`billsByIds`,
`accountsByIds`, `requireFund`, `assertPeriodOpen`, `trialBalance`) reached only
from gated callers. Intersected with import-reachability from a server action,
Phase 214's own device, it collects **15**. Of those 15, two are defects
(`readinessFor`, `installDefaultCostCodes`) and thirteen are forms already
declared — four AI acts establishing through `transactionContext`, `recordAudit`
called by every act after its own gate, three self-acts in
`mobile/notifications.ts`, and so on. 98 → 15 → 2, and the step that did the work
is the one that asks whether anything outside the module can call it.

It also misses `runChases`, because its gating sibling is in `chase-policy.ts`
rather than in `chase-run.ts`. The per-file relation is the argument for *which*
permission a fix should use — it is already written three lines away — and not
the thing that finds the sites. What finds them is the action-level scan.

## What moves

**Nine gates corrected to the permission the act's own file or sibling already
names**, so not one of them is a judgement call: `accounting:journal` for the
statement and remittance acts, by `sendInvoice`'s precedent that sending a demand
for money needs what raising one needs; `crm:manage` for `createVendor`, by its
own comment; `reports:financial` for `readinessFor`, by `exportForAccountant`;
`jobs:manage` for `installDefaultCostCodes`, by `createCostCode`. **Two sweeps
gated at the top** rather than inside a loop inside a catch, so the answer is one
refusal instead of N delivery failures and the early returns cannot answer for
books the reader may not see.

One register of the 39 server actions that establish no permission, with a
category and a reason each. One falsifier for the new property — no permission a
view-only role holds may be the only gate on an act that writes or sends — and
one for the register. The scan follows same-file helpers and both import forms,
with the seven sites it was wrong about as its test cases. Four documents
corrected from eleven to eight. No schema change, no migration, no new
permission, and one role that no longer sends mail.

## Nominated for Phase 218

**The screen that offers what it will refuse.** If a page guard is not a
specification of what an act may do, what is it for? It decides what a person is
*shown*, and this phase has not checked that against what they may *do* in the
direction that is now obviously live: there are 71 guards, and nine acts behind
them just became stricter than the screen that offers them. `/settings/chasing`
and `/settings/statements` guard `accounting:view` and every act on them now
needs `accounting:journal`; `/jobs/cost-codes` guards `jobs:view` and its one
button needs `jobs:manage`. So `readonly` is still admitted to three screens on
which nothing it can press will work.

That is Phase 47 at the scale of a whole screen — a page that tells you to do the
one thing that cannot work — and the measurement is the one the nomination for
*this* phase should have been: for each of the 71 guards, the acts that screen
offers, and whether any role the guard admits can perform any of them. The
answer is a list of screens, not of endpoints, and the repair is a page guard
that names what the screen is *for* rather than what it displays. Note what has
changed: the page-to-act mapping that was the wrong instrument for asking "is
this endpoint safe" is the right one for asking "is this screen honest", because
over-collection is harmless when the finding is "this person sees a button they
cannot press".

Behind that: the twelve findings still in the column register; the CRM account
panel's missing payables side (ADR 0208); the four joins from an unscoped primary
(ADR 0198); and §11's six remaining functions.

Behind that: the twelve findings still in the column register; the CRM account
panel's missing payables side (ADR 0208); the four joins from an unscoped primary
(ADR 0198); and §11's six remaining functions.
