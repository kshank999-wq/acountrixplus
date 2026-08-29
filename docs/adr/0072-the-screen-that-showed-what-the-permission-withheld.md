# 0072 — The screen that showed what the permission withheld

**Status:** accepted
**Date:** Phase 72
**Amends:** ADR 0071 (the record nobody could read), ADR 0045 (party changes), ADR 0068 (1099 vendors).

## The defect

Phase 71 gave the audit log a reader without asking what was in it.

Three modules had already decided, independently, that certain values must
never reach that table — reasoning carefully about a reader who did not exist:

- `payroll/service` records an employee without their rate: *"Never the rate:
  an audit log is read by more people than a payroll record should be."*
- `payroll/vendor-reporting` records **whether** a tax identifier was set
  rather than what it was, *"because recording what it was would put a tax
  number in a table read by everyone with `audit:view`."*

Meanwhile other writers put exactly those kinds of value in freely, because
there was nothing to worry about. `payroll.post` carries a run's gross, net
and employer cost. `receivables/service` writes a supplier's tax identifier
verbatim on every edit that touches the field.

Then Phase 71 built the screen.

## Why it matters more than it looks

```
manager has audit:view  : True
manager has payroll:view: False
```

Phase 9 wrote that gap deliberately and said so: *"No payroll. A manager who
needs it gets it as an explicit grant, so the decision to show one colleague
another's pay is always deliberate."*

Phase 71's activity screen showed that manager every payroll event on the
books. For a business with three people on the payroll, a run's gross is a
short step from one person's pay — and the permission model had already
decided they should not be taking that step.

## Decision 1: the log keeps everything; a reader is shown only what they may know

Redaction belongs to the **reader**, not the writer.

Scrubbing the writers would lose facts an investigation needs, and would do
nothing about the rows already written. Deciding at the point of reading fixes
both, and means a module recording an event does not have to anticipate every
future screen — which is the thing the two careful modules were each trying to
do alone, and the reason they disagreed with everybody else.

## Decision 2: one registry, not two

Phase 71's `READABLE_BY` answered "who may see this entity type" for a single
record's history. Phase 72 needs the same answer for the company-wide feed.

Two tables answering one question is the defect this codebase keeps removing,
so the registry moved into `audit/visibility.ts` and both callers read it.
Payroll and tax entity types joined it:

| Entity type | Needs |
| --- | --- |
| `bank_transaction`, `categorization_rule` | `bookkeeping:view` |
| `invoice`, `bill`, `payment`, `vendor`, … | `accounting:view` |
| `payroll_run`, `employee` | `payroll:view` |
| `tax_code`, `tax_filing`, `tax_remittance` | `tax:view` |
| anything unplaced | `audit:view` |

## Decision 3: the feed filters in SQL, not after it

`withheldEntityTypes` turns what a reader holds into a `NOT IN`, applied
inside the query.

Filtering after the fact would apply `limit` first, so somebody would get a
short page of what they may see rather than a full one — and a short page
reads as *"not much happened"*, which is a lie told by omission.

## Decision 4: a secret value reads as "set", not as asterisks

`taxId` is on a list of values the log may keep and a screen may never print.
Redacted at the reader, which also covers every row written before anybody
noticed — and at the writer too, so new rows do not carry what the old ones
should not have.

It renders as **"set"**. Not `••••`: a mask shaped like the value tells
somebody how long it was, and a reader shown asterisks reasonably assumes the
real thing is one click away. The auditable fact is that the identifier
changed and by whom; somebody investigating a 1099 needs to know it was
replaced on the 3rd, not what it was replaced with.

## What the tests found

Two of my own assertions were wrong, and both were the test rather than the
code:

1. A manager's feed showed no `vendor` events either — because a manager does
   not hold `accounting:view`. That is the rule working, not failing, and the
   test now uses a bank transaction as its control.
2. Phase 71's "keeps a field that was emptied" test used `taxId` as its
   example, which this phase makes secret. It now uses an email, and the
   redaction has a test of its own.

## What this did not do

No migration; the ledger is untouched. The log records exactly what it
recorded before, minus one field's value. What changed is who is shown which
parts of it.

## What the next phase might take

The rate is still absent from `employee.create` and the *value* of a tax
identifier is now absent from `vendor.update`, but nothing stops the next
person adding a field to a payload that should not be in one. A test that
walks every `recordAudit` call and fails on a key in `NEVER_SHOWN` would make
the rule enforceable rather than remembered — the difficulty being that the
payloads are built at runtime, so it wants a lint rule or a wrapper rather
than a unit test.
