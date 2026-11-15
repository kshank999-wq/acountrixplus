# ADR 0213 — The history nobody can read

**Status:** accepted · **Phase:** 213 · **Spec:** §14, §19

## The nomination, and what measuring it did to it

ADR 0212 nominated six job-costing entity types that write audit events and are
not placed in the audit log's readable-types register — `cost_code`,
`change_order`, `sov`, `progress_billing`, `subcontractor`,
`compliance_document` — with one instruction attached: measure *"which roles can
produce each of those events, and whether they can read them"* before building.

The measurement did not confirm the list. It replaced it, on three counts, and
each one was invisible without a scan.

**`sov` does not exist.** No act anywhere writes that entity type. The
schedule-of-values event is filed under `project`.

**`project` is a second name for the table `job` was placed under.** Three acts
write a job's history — `job.status`, `budget.set`, `sov.set` — and all three
carry `projects.id` as the entity id. Two of them said `project`. So Phase 212's
placement, whose prose in the register says a job *"has a history for the first
time"*, reached the act about status and neither of the two about money. The
sentence was a third true. That is Phase 70's defect — one vocabulary for one
record — and this phase introduced it one phase earlier by placing one of two
names without checking whether there were two.

**Six was not the number.** Measured across every `recordAudit` call in `src/`
— 263 write sites, 93 entity types — **20** types had a role that could cause an
event and never read it. The nomination saw four of them, named one that cannot
happen and one that does not exist, and missed five whole families.

That is the fourth phase running where measuring an inherited nomination changed
the subject rather than confirming it. Phase 164's rule is now less a caution
than a description of how this codebase works: *a nomination inherited is a
nomination unmeasured.*

## What the register was missing

`READABLE_BY` answers *"who may be shown events about this kind of record"* on
Phase 71's rule — you may read the history of a record you may read — and a type
absent from it falls through to `audit:view`, which its own prose calls "the
strict end".

Phase 78 found that the strict end is not the safe end. Six CRM types had
written events since Phase 3, none was listed, and `sales` does not hold
`audit:view`: a salesperson could move an opportunity, send a proposal and
correct a client, then read the history of none of it. The sentence that phase
left behind is the one this phase finally measures:

> An audit entry the person who made the correction cannot see is not much of an
> audit trail.

For a hundred and thirty-five phases that stayed prose. Nothing asked the
register the converse of its own question — not *who may read this type*, but
*can the person who caused the entry read it* — so every answer it gave was
checked against nothing.

## The device, and why it is not a quota

`src/modules/source/audit-readers.ts` scans every `recordAudit` call, takes the
permissions the enclosing function requires, and reports every `(type, role)`
pair where the role can perform the act and holds none of the permissions that
would let them read the result. `blindProducers()` must be **empty**.

93 types are written and 43 are now placed, so the obvious test would have been
"place the other 50". That is ADR 0134's shape exactly: a number driven to zero,
which teaches nobody anything and excuses every site it covers. Most of the 50
are correctly silent — `user`, `device` and `push_subscription` are written by
paths with no permission gate at all, so no role produces them and no role is
blinded by them.

**An ungated site names no producer, so it blinds nobody.** That one line is
what separates a property from a quota: a type has to be placed only when
somebody is actually shut out of their own work, and correct silence passes
untouched. The assertion stays meaningful as types are added, which a count
never does.

## The false finding, kept on the record

The first version of the scan took the **nearest preceding** `requirePermission`
— one permission, the last one before the write. It reported 21 findings where
there are 20, and the extra one is worth keeping because it is a wrong reading
of the permission model rather than a parsing slip.

`parties/service.ts:setVendorOrganization` requires two:

```ts
requirePermission(ctx, 'accounting:journal')
requirePermission(ctx, 'crm:view')
```

Sequential calls are a **conjunction**. The act belongs to whoever holds both,
which is `owner` and nobody else. Read as a `crm:view` act it appeared to belong
to four more roles, none of whom can reach the code, and `vendor` acquired a
defect that cannot occur.

The same rule rescued one of the nomination's own entries: `progress_billing` is
gated on `jobs:manage` **and** `accounting:journal`, and a bookkeeper holds the
first without the second — so the role the nomination was worried about cannot
raise a progress billing at all. Everyone who can already holds `audit:view`.
Placing it would have widened nothing and narrowed nothing: a correction with
nobody on either side of it, which is what a list assembled from family
resemblance produces.

Taking the enclosing function rather than a window of lines is the other half,
and it is ADR 0134's own: a fixed window *"leaked past a function boundary and
excused a real defect"*, which is why `enclosingSpan` exists.

## An entry holds a list now

`READABLE_BY` mapped a type to one permission. The rule it implements has always
been *the history of a record you may read* — so a record that can be opened
**two ways** was mis-stated the moment it was placed, and no better choice was
available.

- A **customer** is reached through the books by an accountant
  (`accounting:view`) and through the CRM by a salesperson (`crm:view`).
  `createCustomer` and `updateCustomer` are gated on `crm:manage`, held by
  `manager` and `sales` — so the two roles that create and correct customers
  were exactly the two the entry shut out. Choosing `crm:view` instead would
  have taken customer history from the accountant who reads the receivables
  ledger. Either choice blinded somebody who may open the record.
- A **proposal** is a contract, and `billStage` raises an invoice from one under
  `accounting:journal`. An accountant was filing `proposal.stage_billed` into a
  type only the CRM could read.

So an entry names every permission that opens the record and a reader is shown
the type if they hold **any** of them. The first in the list is the primary —
what a refusal names (Phase 47), and what `permissionToRead` returns for callers
that want one. Exactly two entries hold more than one, and the test says so: a
list where a single permission would do is a way of not deciding, and the
register's value is that every entry decided.

## The half that takes something away

ADR 0212's one correct caveat. `withheldEntityTypes` is a `NOT IN` handed to the
feed, so an unplaced type is visible to every `audit:view` holder — owner,
manager, accountant — and placing it hands the type to the people who may read
that kind of record *instead*. Measured per type, as the ADR insisted:

| placement | who gains | who loses |
| --- | --- | --- |
| `bank_connection`, `import_run` → `bookkeeping:view` | bookkeeper, readonly | nobody |
| `cost_code`, `change_order`, `subcontractor`, `compliance_document`, `vehicle`, `repair_order` → `jobs:view` | bookkeeper, sales, readonly | nobody |
| `reconciliation` → `reconciliation:view` | bookkeeper, readonly | nobody |
| `ai_suggestion` → `ai:use` | bookkeeper, sales, marketing | nobody |
| `customer`, `proposal` → two doors | manager, sales / accountant | nobody |
| `customer_statement`, `pay_run` → `accounting:view` | bookkeeper, readonly | **manager** |
| `communication`, `task` → `crm:view` | sales | **accountant** |
| `campaign`, `segment`, `suppression` → `marketing:view` | marketing | **accountant** |

The five that narrow are deliberate, and all five are Phase 72's argument
restated: *the permission that guards a record guards the events about it too.*
A manager may not open a customer statement or a pay run, and the feed was
handing them the history of both; an accountant has no business in campaign
history. Showing somebody the history of records they may not open is not a
courtesy, it is the leak — which is the whole reason the register exists.

## The rows already written

The writers now say `job`. Migration `0105` moves the events filed under the old
name, so a job's history is one list rather than two.

An audit row's immutability is a promise about **what it says**, not about the
name of the drawer it sits in. The actor, the timestamp, the action and the
before/after payloads are untouched; what moves is the index. Leaving it would
have honoured the letter of that promise by permanently hiding half of what the
log recorded from the person who caused it, which is the defect this phase is
about, preserved as data.

## What moved

43 types placed of 93 written, in nine permission families. 263 audit write
sites measured, 44 of them ungated. `blindProducers()` is empty. One migration,
one entity type folded away, no new audit action, no schema change.

## What the full run found

One failure in eight shards, in `tests/enclosing-function.test.ts` — a scanner
test from Phase 140, as far from the audit log as this tree gets, which is ADR
0178's rule collecting again.

Its second assertion said that none of the twenty-one names the broken reader
invents out of prose is a function **anywhere in the codebase**. That had been
true for seventy-three phases and it was true by vocabulary luck. This phase
declared `function holds(role, permission)` in `source/audit-readers.ts`, and
`holds` is one of the twenty-one — the old reader hands it back at three
`…Cents:` sites in `fx/settlement.ts`.

Renaming the helper was the wrong repair. It would have made the measurement
pass by moving the thing measured, and the next short verb somebody picks would
reopen it.

The load-bearing claim is **per file**, because that is the shape of the check it
underwrites: the fiction assertion above it reads `row.file` and asks
`declaresFunction` about that file alone, and so do the three other registries
that ask this question — `bank-money.test.ts`, `tax-rounding.test.ts` and
`ledger-postings.test.ts`. A collision across two files costs nothing;
`declaresFunction(settlement.ts, 'holds')` is still false, so a row invented
there is still detectable as fiction. A collision **within** a file is the
dangerous one: the broken reader would name a real function at the wrong site,
`declaresFunction` would answer yes, and the registry would hold a row that is
wrong and passes — ADR 0134's check that excuses a site rather than missing it,
arriving by way of a helper named after a verb. Per file the count is zero.

A tree-wide claim that happens to be true is weaker than a narrow one that has
to be, and the only way to tell the two apart is to break the accident.

## Nominated for Phase 214

**The act with no gate.** This phase's scan found **44 write sites whose
enclosing function requires no permission at all**, and treated every one as
blinding nobody — which is what makes the property a property rather than a
quota. That treatment is correct about readers and says nothing about writers.

Some of those sites are right: a proposal accepted through a public token has no
actor to hold a permission, and a background sweep has no session. Others may
simply never have been gated. `importing/reversal.ts:revertImport` writes an
`import_run` event, undoes a committed import, and requires nothing in the
function that does it.

The measurement to do first, before deciding anything is wrong: for each of the
44, whether the act is reached through a server action that gates it upstream,
through a public token, from a worker, or not gated anywhere. Only the last
group is a finding, and the shape of the answer decides whether the fix is
permissions or a registry of deliberately open acts — the four categories are
not a defect and three of them are, so counting them as one number would repeat
the mistake this phase was built to measure.

Behind that: the twelve findings still in the column register, of which the four
`notes` columns and the two `journal_entry_id` columns are substantial; the CRM
account panel's missing payables side (ADR 0208); the four joins from an
unscoped primary (ADR 0198); and §11's six remaining functions.
