# ADR 0219 — The gate that is only sometimes a gate

**Status:** accepted · **Phase:** 219 · **Spec:** §14

## The nomination, and why its shape was wrong

ADR 0218 nominated **the flag that nothing pins to the act it guards**: a
register of the 73 flags, each entry naming the screen, the prop, the permission
and the act behind the control. It asked for one measurement first — how many of
the 107 act references it could not place in a flag region are a span form still
unread, as against genuinely unflagged — and guessed the register at *"73 entries
or 180"*.

Measured: **236**.

And the 107 break down like this:

| | |
|---|---|
| mounted behind a flag — `{canManage && <NewFund …/>}`, body declared elsewhere | **35** |
| called in a handler whose control is behind a flag | **8+** |
| the prop renamed on the way into a local component | 2 |
| no guard the reader can find | 62 |

Sampling the 62 settles it. `jobs/[id]/status.tsx` calls `setJobStatusAction`
at line 60, inside an async handler, and guards the control at lines 93 and 100.
`crm/pipeline-board.tsx` calls `changeStageAction` at lines 91 and 100 and guards
at 141, 151 and 212. **React separates the call from the control by design**, so
lexical enclosure of the call site places a reference only when the author
happened to write the call inline in the JSX. The relation's coverage tracks
*coding style*, not guarding — which is why ADR 0218's scan was wrong eight
times, and why a deeper scan is not the answer.

But a register of 236 entries is not a register either. Phase 101's device
requires every entry to argue for itself, and 230 of those entries would say the
same thing: *this component offers this act behind the flag that is the act's own
permission.* That is boilerplate wearing a register's clothes.

## The property that needs no spans

Every relation ADR 0218 tried had to decide **which** flag guards a control, and
every one of its eight errors came from getting that wrong. So do not decide it.
The strictest guard a screen can possibly be applying is the conjunction of
**all** its flags:

> If even all of a component's flags together admit somebody the act refuses,
> then no arrangement of those flags guards that control.

No span is read, so a missed guard form cannot produce a false positive — the
direction Phase 126 says matters. Run over all 236 pairs it yields **two**
candidates, and both turn out to be the same thing:

```
convertAction   needs [[accounting:journal],[crm:manage],[jobs:manage],[jobs:view]]
                /crm/page.tsx strands manager, sales
logTimeAction   needs [[accounting:view],[users:manage]]
                /time/page.tsx strands accountant
```

Neither is a defect. `convertWonOpportunity` gates on `crm:manage` at the top and
reaches the other three only here:

```ts
  if (opts.createInvoice && winningProposal) {
    if (scheduled.length > 0) {
      sovStageCount    = await scheduleOnJob(ctx, …)      // jobs:manage, jobs:view
      depositInvoiceId = await depositInvoice(ctx, …)     // accounting:journal
```

And `logTime` reaches `users:manage` here:

```ts
  if (userId !== ctx.userId) requirePermission(ctx, 'users:manage')
```

**That single limitation — a check that applies on some paths and not others —
is the only thing left between this tree and a clean answer to ADR 0217's
question.** It produced both remaining candidates, and ADR 0218 could not decide
`logTimeAction` at all: it pinned it in a test as *"a known over-collection"*,
which is an admission, not an answer.

## Two questions, one function

`demandedBy` conflates *what the caller must hold for this to work at all* with
*what it might come to need*. They are different questions and both are real:

- **`willDemand`** — checks on **every** path. What the button needs to work.
- **`mayDemand`** — checks on **some** path. What it might need, given choices.

Conditionality is readable from the source exactly, the way `refusalSwallowed`
was: a call or check nested inside `if`, `else`, `catch`, `for`, `while`,
`switch`, a ternary or a short-circuit is conditional; one at statement level is
not.

Measured over the 329 server actions: `willDemand` and `mayDemand` differ for
**27**, and **5** acts have no unconditional gate at all.

With `willDemand`, the screen property over all 236 pairs returns **zero**.
That is ADR 0217's question, finally answered, by a property that cannot
false-positive on a form the span reader cannot see.

## Conditionality is a property of the call, not of the act

The draft of this ADR said `createInvoice` was *"a checkbox on `/crm`"* and
called the category *"the control that works until you choose the wrong
option."* Both were wrong, and reading the call site is what showed it:

```ts
  const result = await convertAction(id, true)
```

Hard-coded, with a Phase 49 comment above it explaining why. So from this screen
the branch is **always** taken: `mayDemand` *is* `willDemand` for this call site,
and `willDemand` understates what the button needs.

The other one is the exact opposite. `/time/board.tsx` calls `logTimeAction`
with no `userId` at all, so `if (userId !== ctx.userId)` can never fire from that
screen and `users:manage` is unreachable there. The same conditional gate is dead
code from one screen and unconditional from another.

**That is the finding: neither `willDemand` nor `mayDemand` answers a screen's
question on its own, because conditionality belongs to the call.** For the two
acts here the arguments are literals and the answer is readable exactly — which
is why this phase reads them rather than guessing, and why the register below
names which argument selects each conditional gate.

## What the `/crm` call actually does

The invoice branch is **outside** the transaction that created the customer and
the project:

```ts
  const result = await db.transaction(async (tx) => { … })   // committed
  …
  if (opts.createInvoice && winningProposal) {
    const scheduled = await scheduleForProposal(ctx, …)
    if (scheduled.length > 0) {
      sovStageCount    = await scheduleOnJob(ctx, …)   // jobs:manage
      depositInvoiceId = await depositInvoice(ctx, …)  // accounting:journal
```

So a salesperson presses **Create client & job** on a won opportunity whose
proposal has a billing schedule — the ordinary path — and:

1. the transaction commits: customer, project, audit event;
2. `scheduleOnJob` throws `Missing required permission: jobs:manage`;
3. the screen reports a failure;
4. the client and the job exist.

A **manager** holds `jobs:manage` and not `accounting:journal`, so they get one
step further and fail at `depositInvoice` — *after* the schedule of values has
been written. And pressing the button again reaches
`if (opportunity.convertedCustomerId && opportunity.convertedProjectId)` and
answers **"This opportunity was already converted."** The user is told the
conversion failed, and then told it already happened.

This is Phase 214's defect — *"a check that ran late: `uploadEvidenceAction`
stored the bytes, the row and the audit event and then refused, so every test of
the refusal passed because the refusal did happen"* — found again by a different
route, and this time with two contradictory messages to the same person.

The fix is not a stricter gate on the button. A salesperson converting a won deal
into a client and a job is the feature; raising the invoice is not theirs. So the
billing half **degrades and says so**, which is Phase 216's rule applied to a
write rather than a read: do the part this person may do, and never let the
omission pass for nothing having been omitted. `convertWonOpportunity` already
returns `depositInvoiceId` and `sovStageCount`, and `convertAction` already
composes a sentence from them.

## Two scan errors, both in the conditionality reader

On the record, as in the last two phases, because both were found by checking a
finding against the code and neither by the property passing or failing.

**1. The statement boundary assumed semicolons.** The first reading scanned back
for a ternary with `/\?[^;]*$/`. **This codebase writes no semicolons**, so the
scan-back never terminated and everything after the first `?` anywhere in a
function read as conditional. It put 17 acts in the conditional-only bucket,
`postEntryAction` among them — posting a journal entry, apparently gated only on
a branch. A statement is now a *logical line*: lines folded in while the previous
one ends on an operator or an open bracket. 17 → 5.

**2. A braceless `if` opens no brace.** The enclosing-block reader counts
unclosed `{`, so `if (userId !== ctx.userId) requirePermission(ctx, 'users:manage')`
was invisible and `logTimeAction` read as demanding `users:manage` of everybody.
**This also corrects ADR 0218**, which said `logTime` reaches `users:manage`
*"via `loadOwnEditable`, on a branch"*. The conclusion was right and the mechanism
was wrong: `loadOwnEditable` is not on `logTime`'s path at all; the check is
`logTime`'s own one-line `if`. The claim is corrected there and in the test that
pinned it.

## The five whose only gate is conditional

A register, and this one is register-sized because it is a register of
**exceptions** — the shape this codebase already uses for `OPEN_ACTS`,
`OPEN_ENDPOINTS` and `DEGRADING_READS` — rather than of every case.

| act | why its gate is conditional |
|---|---|
| `recordHistoryAction` | `historyFor` refuses with `if (!permissionsToRead(t).some(…)) requirePermission(…)` — the check *is* the branch, and it fires for everyone it should |
| `planImportAction` | the gate follows the import's kind; five kinds, five gates, one per branch |
| `commitImportAction` | the same, on the committing half |
| `respondToEngagementAction` | authorised by `requirePracticeOwner`, with `company:manage` on the client's side of the branch (Phase 214's `practice` category) |
| `endEngagementAction` | the same pair, which ADR 0214 already measured as a tenth gate form |

`conditionalGate()` throws for an act that is not declared, so the sixth one stops
the suite rather than being read as ungated.

## What moves

`statementAt` and `conditionalAt` join `enclosing.ts`, so there is still one
reader of the shape of a function. `willDemand` and `mayDemand` replace
`demandedBy`'s single answer. `CONDITIONAL_GATES` declares the five.
`convertWonOpportunity` stops raising the schedule and the deposit for somebody
who may not, and says what it did not do, instead of committing half a
conversion and then refusing. ADR 0218's mechanism claim about `logTime` is corrected
where it was made. No schema change, no migration, no new permission.

## Nominated for Phase 220

**The option that changes the answer.** This phase found `mayDemand` by looking
for over-collection and discovered it names a real category: a control whose
permission depends on an argument the screen supplies. Two were found among the
236 (page, component, act) pairs, both from a boolean. The measurement nobody has
done: across the 329 acts, how many take an argument that selects between gates —
`createInvoice`, an import `kind`, a document `kind`, a party `side` — and for how
many of those does the screen let one person choose an option the gate will
refuse them? `GATE_RESOLVERS` already names the expressions; what it does not say
is **which argument** each resolves from, and whether that argument is a user's
choice or a property of the record. A gate computed from the record is a fact;
a gate computed from a checkbox is a question the screen asked and did not check
the answer to.

Behind that: the twelve findings still in the column register; the CRM account
panel's missing payables side (ADR 0208); the four joins from an unscoped primary
(ADR 0198); and §11's six remaining functions.
