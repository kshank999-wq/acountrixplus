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

## What `mayDemand` is for, which is not nothing

The two it leaves are not noise — they are a kind of defect nothing in this tree
has had a name for:

> **The control that works until you choose the wrong option.**

`convertAction(opportunityId, createInvoice: boolean)` is the sharp one.
`createInvoice` is a checkbox on `/crm`. A manager or a salesperson can convert a
won opportunity — and with the box ticked the same button refuses them, because
raising the deposit invoice needs `accounting:journal` and scheduling the stages
needs `jobs:manage`. Nothing on the screen says the checkbox changes who may
press the button. Phase 47 at the level of a form field rather than a screen.

`logTimeAction` is the same shape and milder: an accountant may log their own
time and not somebody else's, which is deliberate and documented in the code —
*"Somebody else's timesheet needs the permission that manages people"* — but the
screen offers the person-picker to everybody it admits.

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
The `/crm` screen stops offering *create an invoice* to somebody who may not
raise one, and `/time` stops offering somebody else's timesheet to somebody who
may not manage people. ADR 0218's mechanism claim about `logTime` is corrected
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
