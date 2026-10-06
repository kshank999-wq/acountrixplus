# 0170 — The tenant in the key

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 170

---

## The nomination held, and its reasoning was wrong

ADR 0169 nominated a tenant predicate where `item_id` is written, and explained
why the phase had only contained the problem:

> **No tenant predicate on `item_id` at insert.** The foreign key cannot express
> "and it must be yours", and `createInvoice` does not check.

The first clause is false. A *single-column* key cannot express it; a
**composite** one can, because the referencing row's own `company_id` becomes
part of the reference:

```sql
FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
```

A line in company A cannot point at an item in company B, because the pair
`(A, item-of-B)` does not exist in the target. So the prevention ADR 0169
nominated was not a lookup to be written in ten places — it was a constraint,
and Phase 116's rule settles which to prefer.

Fifth consecutive phase in which the inherited nomination needed correcting, and
the second in a row where the error was mine. Worth noting what kind of error it
was this time: not an unchecked claim about the codebase, but an unchecked claim
about **PostgreSQL**. The habit of measuring the repository did not extend to
measuring the tool.

## Measured first: 271, and not one of them

Before building a mechanism, `pg_constraint`:

```
167  company-scoped tables
271  foreign keys from one tenant-scoped table to another
  0  of them carrying the tenant
```

That changes what the phase is. One unguarded reference is a bug; 271 is a
class, and a register of exceptions is the wrong instrument for 271 of anything.
It also means Phases 149 and 150 — 110 writes and 883 reads, every one guarded —
audited a different question than this one and were right to: *can this
statement be aimed at another tenant's row* is not *can this row store a
reference to one*.

## So the phase is a mechanism, two conversions, and a denominator

`src/modules/tenancy/references.ts` holds the vocabulary: four proofs, ordered
by **what each one survives**, which is the field that does the work. Three of
the four are properties of code and one is the database refusing the row —
asserted in a test rather than left in the prose, because that distinction is
the whole phase.

- **`composite-key`** survives a new writer, a moved lookup, a path nobody has
  written yet, and an engineer who has never read the file.
- **`scoped-lookup`** is `logCommunication`'s shape — *"three lookups rather
  than trusting three uuids from a form"* — correct where it is used and a
  property of the writer, so the second writer of the same column inherits none
  of it.
- **`derived`** means no caller ever names the id. Strong while it lasts, and it
  stops being true the moment somebody adds an optional parameter that overrides
  it — with no diff to the write.
- **`unproved`** is named rather than left as the default, so that a count of
  them is a number somebody can watch fall.

`invoice_lines.item_id` and `bill_lines.item_id` are converted — the two Phase
169 found and contained, chosen first because a mechanism demonstrated on the
case that motivated it is one somebody can check, and because they drive
inventory relief, where a foreign id moves the wrong stock.

`REFERENCE_ROLLOUT` carries the three stages and the test asserts the measured
pair of numbers, so adding a reference raises `total`, converting one raises
`composite`, and either way the test fails and somebody reads the register. That
is the only reason a backlog of 271 is worth writing down.

## The price, and the one thing that is not mechanical

The target needs `UNIQUE (company_id, id)` when `id` is already unique by
itself. Redundant on its face; one index per referenced table; and it buys a
guarantee no amount of application code can.

The delete rule is the part that is not a substitution. A bare
`ON DELETE SET NULL` nulls **every** column of the reference, and `company_id`
is `NOT NULL` — so deleting a catalogue item would *fail* rather than clear the
line, turning a Phase 169 decision ("deleting a catalogue entry must not be
blocked by an invoice raised three years ago") into its opposite.
`ON DELETE SET NULL (item_id)` names the column. It is PostgreSQL 15 and later,
verified against the 16.13 this runs on, and there is a test that deletes an item
and asserts the line survives with a null — because a delete rule that is wrong
is wrong only on the day somebody deletes something.

That single detail is why `REFERENCE_ROLLOUT` says the other 269 cannot be done
by search and replace: a nullable reference, a `NOT NULL` one, a self-reference
and a reference from an unscoped table each need different handling, and
discovering that sixty tables in is worse than saying it now.

## What this does not do

**It does not convert the other 269.** Two of 271, with the rest counted. The
temptation was to do a sweep, and the delete-rule detail above is the argument
against: a mechanical pass would have written `ON DELETE SET NULL` across the
lot and broken every delete that currently works.

**It does not remove any scoped lookup.** `logCommunication` keeps its three,
and `proofOf` deliberately reports `composite-key` over `scoped-lookup` when
both hold rather than calling the lookup redundant. Retiring a working guard
because a stronger one arrived is how a stronger one that turns out to be
misconfigured becomes no guard at all.

**It does not add row-level security to the mix.** Phase 160 installed RLS and
`RLS_ROLLOUT` records that it is not switched on because the application
connects as the table owner. A composite key is enforced for the owner too,
which is the specific reason it is worth having *now* rather than after that
rollout finishes.

## What is nominated next

**A full suite.** Not a phase, and it is overdue by ten: two tripwires have gone
red undetected since Phase 160 — `refusal-audience` in Phase 167 and
`isolation-guards` in Phase 169 — both of them tree-wide scans that a targeted
run cannot reach, and both found by accident rather than by the thing meant to
find them. The reference count added here is a third scan of exactly that kind,
so the argument now applies to this phase's own work.

Then **the next slice of the 269**, taken by referenced table rather than by
referencing one: every reference into `service_items` first, since the unique
index is already there and the pattern is proved.

Then the **bullet-level spec pass** over the sections `docs/SPEC-AUDIT.md`
verified only at module level, which has been nominated for three phases and
keeps losing to findings that came out of building.
