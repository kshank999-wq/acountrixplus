# 0180 — What we sent this client

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 180

---

## The nomination held

ADR 0173's bullet-level pass measured eight capabilities with nothing behind
them, and this phase takes the first of them in the order I recommended: **asset
association (§8)**, ahead of the generic table block, `deliverables`,
`assumptions` and team bios, because it is the only one of the five that
answers a question rather than adding a place to type.

§8's last bullet:

> Assets can be associated with campaigns, contacts, companies, opportunities,
> or client records.

Measured before building: `assets` carries `company_id`, `kind`, `filename`,
`content_type`, `size_bytes`, dimensions, storage, `uploaded_by`,
`provenance_origin`, `ai_request_id` and `derived_from_id`. Not one column names
any of the five. The nomination needed no correcting.

What the absence costs is the question a studio exists to answer before making
the next thing: **what have we sent this client.**

## The decision this phase is mostly about

There is a precedent and it is good. Phase 20 moved receipts out of a `jsonb`
array into `document_links` — a `subject_type` enum, a `subject_id`, and
`modules/evidence/subjects.ts` registering the twelve things that may carry
evidence, with `requireSubject` proving a record exists and is the caller's.
Copying that shape was the obvious move.

Its own docstring is the argument against:

> A polymorphic reference has no foreign key, so nothing in the database stops a
> link pointing at a uuid that belongs to another company — or to nothing at
> all. The check has to live in code, and if it lives in the *caller* then every
> new screen that attaches a file is a fresh chance to forget it.

That was the right trade in Phase 20 and it is the wrong one now, for a reason
that is about this repository's own history rather than about taste. **Phases
170–172 spent three phases putting the tenant into keys** precisely so the
database would refuse what a forgotten check lets through, and **Phase 179 found
a cross-tenant check that had been broken for nine phases** — a test asserting a
constraint name that Phase 170 had replaced. Writing a thirteenth polymorphic
subject reference one phase after that would be choosing the shape this codebase
has been migrating away from, in the week it was shown why.

So: **five nullable columns, one real composite foreign key each, and a CHECK
that exactly one is set.** Every consequence inverts.

| | polymorphic | five keys |
| --- | --- | --- |
| another company's record | written; a function must refuse it | refused by the database |
| a uuid naming nothing | written | refused by the database |
| subject deleted | row survives, pointing nowhere | `ON DELETE CASCADE` |
| two subjects on one row | possible | refused by a CHECK |
| a sixth kind of subject | a row in a register | **a migration** |

The last row is the price, and it is named in the migration rather than
discovered later. §8 names five. A migration per new kind is what the database
doing the checking costs — the same bargain `retention.test.ts` states in its own
words: *"that is the price of the moment where somebody decides."*

`document_links` is left alone. Twelve polymorphic subject references with no key
is now the odd shape in this codebase rather than the precedent, and converting
it is its own phase.

## What the register is for, now that it is not for integrity

`ASSET_SUBJECTS` is deliberately smaller than `EVIDENCE_SUBJECTS`. It does not
carry the table, the id column or the company column, and it has no
`requireSubject`, because there is nothing for one to check — a second copy of a
proof the constraint is already performing is a second thing to keep in step.

What is left is what the database cannot say:

- **What to call each kind.** `customer` is labelled **Client**, because the
  industry terminology layer renames it per trade and a studio screen saying
  "Customer" to a firm that says "client" is the small wrongness §2 exists to
  stop.
- **Who may read and who may change.** `view` follows the record and `manage` is
  the studio's everywhere.

### The mapping, which is where this could have been quietly wrong

§8 says *companies* **and** *client records* as two separate things. In this
codebase those are `organizations` — the CRM's record of another business, which
may never become a client — and `customers`, the record that carries invoices and
a balance. Reading them as one thing would have produced four kinds and silently
lost a distinction the bullet draws. Every entry records the §8 word it
satisfies, and a test asserts the five words against the bullet, so the mapping
can be checked against the specification rather than against my reading of it.

### The permission asymmetry, and the thing it does that looks like a bug

`view` is the subject's own and `manage` is `marketing:manage` for all five. The
consequence, asserted because somebody will report it: a **salesperson sees the
collateral on a client and not on a campaign**, because a campaign's view
permission is `marketing:view` and `sales` does not hold it. The association is a
description of a relationship, so the relationship decides who may read it.

## Six composite keys in one phase

`asset_links` points at `assets` and at each of §8's five subjects, so six tables
gained `UNIQUE (company_id, id)` and the reference programme moved further in one
phase than in any before it: **274 → 280 references, 19 → 25 carrying the
tenant.** It came free. The capability needed the references, and the references
needed the tenant in the key because the alternative was the shape Phase 170 was
written to retire.

## Phase 179's lessons, applied deliberately

Three of them, and this is the first phase written after knowing them:

- **The policy is in the migration that creates the table.** Phase 177 added a
  tenant-scoped table and did not police it; Phase 179 found it two phases later
  with the live row-level-security check having reported the fault the whole
  time. `asset_links` is enabled, forced, policed and granted in migration 0099.
- **The counts moved in the phase that moved them.** `retention` 182 → 183 (and
  `asset_links` classified `NEVER_SWEPT` — an association is a deliberate act
  and the only record of it, since both the asset and the subject survive the
  link), `rls-bites` 168 → 169 and 162 → 163, `a-job-through-the-policies` 162 →
  163, `the-id-a-caller-hands-in` 274 → 280 and 19 → 25,
  `isolation-guards` 111 → 112, `isolation-reads` 911 → 916, `registry-error`
  35 → 37.
- **Every pinned prose claim was corrected in the same commit.** `PINNED_CLAIMS`
  caught nothing, which is the only result that means it is working: the eleven
  numbers it watches were updated before the test ran because the register names
  the files, so there was nothing to remember.

Two defects in my own tests, found by running them rather than by reading:

- A leftover `db.execute` of a nonsense statement in the cascade test.
- The role test used `readonly`, which holds **neither** `crm:view` nor
  `marketing:manage`, so it proved nothing in either direction. `sales` is the
  role the asymmetry was written for — it holds the first and not the second —
  and it was found by measuring the role matrix rather than by assuming it, which
  is the same mistake Phase 167 made about `bookkeeper`.

## The reader, so this is not a column

`listAssets` had a caller and `asset_links` would not have. The organisation row
in **CRM → Clients and prospects** now carries *"n things sent"*, counted for the
whole page in one grouped query — the same argument the page already makes about
"when did we last speak to these people": asking per row is how it ends up not
being shown at all. Opening one fetches its list, because a page that loaded
every organisation's collateral to show a number would be slower for everybody to
answer a question about one of them.

The picker leaves out what has already been sent, rather than offering a choice
the unique index would refuse.

## What this does not do

**Only the organisation screen writes.** The table and the service handle all
five kinds and the tests exercise all five, but campaigns, contacts,
opportunities and clients have no attach control yet — the organisation record is
where §8's question is actually asked, and four more panels is four screens
rather than a capability. Stated rather than implied: `assetsForSubject` has a
UI caller for one kind of five.

**No asset browser in the studio.** `subjectsForAsset` answers "where has this
file been used" and has no screen, because the studio's asset surface is a logo
picker rather than a browser, and building one is its own phase.

## Nominated for Phase 181

**The generic `table` block (§7)**, next in the order recommended. §7 names
*"tables, pricing tables"* as two things; `pricingTable` exists and a plain table
does not, so a specification table in a proposal is built from `keyValue` rows
that cannot carry a header or a third column.

Two findings from this phase go on the list behind it:

- **`document_links` is now the odd shape.** Twelve polymorphic subject
  references with no key, in the table that holds accounting evidence — which is
  a worse place for an unenforced reference than a marketing association. Its
  conversion is a migration and a register rewrite, and it would retire
  `requireSubject` rather than move it.
- **Four of five kinds have no attach control**, above.
