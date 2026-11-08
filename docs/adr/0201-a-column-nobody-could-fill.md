# 0201 — A column nobody could fill in

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 201

---

## The nomination, and what measuring it changed

ADR 0200 nominated *"the columns with a reader and no writer, measured as a
class"*, on the grounds that Phase 200 had found **three** by accident of
writing one narrow check against one form, and that two of the three reached
every document a client sees.

The nomination held. What it got wrong was the difficulty, and in the useful
direction: it proposed building the expected set *"from the schema and the
source independently"* and comparing. The comparison is trivial. **Deciding
what counts as a writer is not**, and every time I thought I had it, the next
mechanism appeared.

## Seven mechanisms, each found by fixing the one before

| | |
| --- | --- |
| object literal in a **callback** | `.values(rows.map((r) => ({ … })))` |
| **shorthand** property | `{ companyId, transactionId }` — no colons at all |
| literal built into a **variable** | `const rows = …; .values(rows)` |
| the **nearest** declaration, not the file's first | what `declarationOf` already handled |
| the **table** held in a variable | `const table = kind === 'customer' ? customers : vendors` |
| a **spread** | `.values({ companyId, ...input })` writes every key of a type |
| a **helper's return** | `.values(decisionFor(input))` |

The first five are resolvable and are resolved. The last two are not, because a
spread means *"whatever that type has"* and resolving it needs the typechecker.

So the deliverable is a **register** rather than an assertion:
`COLUMN_WRITERS` declares, per mechanism, which candidates are written and
where. Its test asserts that every candidate is **declared or fixed**, in both
directions — an entry for a column the scan no longer reports is *removed*
rather than left to excuse it, which is ADR 0134's difference between a check
and an excuse.

### The one that was a correction to somebody else's primitive

Phase 197's `declarationOf` took a local declaration **to the end of its
line**, with a comment stating the reason: *"every one of these in this
repository is a single-line ternary"*.

It was not true any more. `payroll/sales-tax.ts` builds its rows with
`const rows = input.lines.map((line) => {`, and the keys are on the lines
below — so **four columns of `document_tax_lines` looked unwritable, two of
them `notNull`**, which would mean a table nothing could insert into. A working
application does not have one of those, which is how the false positive
announced itself.

The declaration now runs to the first newline at bracket depth zero. A
single-line ternary closes on its own line and resolves exactly as before, so
this is a generalisation rather than a second answer to one question — asserted
on synthetic source in both shapes, because on the real tree the old behaviour
and the new one both reach *a* conclusion and only one of them is right. That
is Phase 197's own lesson about its own bug, which the real tree hid.

## The measurement

**2,179 columns across 185 tables. 27 candidates. Four findings.**

Twenty-three of the twenty-seven are written through a spread or a helper's
return. Each group is declared with the file that writes it and an argument for
why nothing in the interface offers it — a push provider's message id and the
figures a bank said changed are not fields anybody types, and saying so is the
work.

### Two closed

**`organizations.sizeBand` — a segment filter that could only ever match
nothing.** Listed in `SEGMENT_FIELDS`, given a `case` in the matcher, selected
by `loadCandidates`, labelled *"Size band"* on the segment workspace, and set
by no screen. Worse than an unused column, because the interface **offered the
filter**: a marketer could build an audience on company size and get an empty
one back with nothing to say why.

It is now a field on the client form, on `createOrganization`, on
`updateOrganization`, and on `ORGANIZATION_FIELDS` as a `default` rather than a
`description` — for the same reason `lifecycleStage` is one: changing it changes
which campaigns reach somebody, not only what is written down.

**`service_items.inventoryAccountId` — a ledger decision nobody could make.**
`inventoryAccounts` chose the posting account from it, and
`reconcileInventory` collects every account any item names so the subledger
check does not cry wolf on a business that splits raw materials from finished
goods. Its own docstring said that is what such a business *does*. Only the
seed did it.

It has a picker on the inventory board now, on **creation and on change**,
because the items that need it already exist: a business splits raw materials
from finished goods after a year of counting both on 1400, and a picker only on
the create form would have closed the gap for items nobody has yet. The write
went into `inventory/service.ts` rather than staying in the server action,
which is what made it testable; the change is **not retrospective** and the
screen says so, because moving a year of postings is a journal somebody decides
on rather than a consequence of a dropdown.

### Two declared and nominated

**`memberships.permissionOverrides` — §14's granular grants, installed and
inert end to end.** Declared, read into the actor by `auth/session.ts` and
`practice/switching.ts`, parsed by `permissions/index.ts`, and *applied* by
`effectivePermissions`: a grant adds a permission and a revoke deletes one.
Nothing writes it, and the access board offers roles and practice engagements
and nothing finer. Phase 160's shape on a security capability.

Not closable by a register entry. A grant and revoke editor is a screen with
its own refusals — nobody may grant themselves what their own role lacks — and
that is a phase.

**`vendors.organizationId` — the supplier who is also a client.**
`engagement/filing.ts` spends a page on the firm that both buys from you and
sells to you, one shared inbox, a remittance that must not land on their debt
to us; `outbound.ts` reads this column so a supplier letter also reaches that
client's CRM timeline. The customer side is written by `crm/conversion.ts` when
an opportunity is won. There is no such path for a supplier, and the correction
screen is driven by `VENDOR_FIELDS`, a registry of text fields, so a link to a
CRM record is a new *kind* of field rather than one more entry.

## What this phase got wrong first, and caught

**I reported `communications.customerId` and `vendorId` as a panel empty since
Phase 93, and changed the reader.** The docstring I wrote said neither column
had ever been written, *"both inserts in this module set `organizationId`,
`contactId` and `opportunityId` and nothing else"* — which is true of that
module and irrelevant, because the writer is `...columnsFor(party)` in
`engagement/outbound.ts`, the helper Phase 93 added for exactly this. Reverted
before it shipped.

The method is *read the flagged column*. Reading only the file the reader lives
in is not reading it, and the fix I had written would have replaced a working
mechanism with a different one.

I also nearly reported `asset_links`' five subject columns as a rediscovery of
the known gap that four of the five link kinds have no attach control. They are
written by one spread of one helper, one per kind. That gap is real and is about
the interface; these columns are not it.

## What moved

The register's own three numbers are pinned as the **nineteenth** entry in
`PINNED_CLAIMS` — and the first to pin a **denominator** beside its answer,
which is Phases 196–198's lesson written into the register rather than into an
ADR: each of those found a census quoting a subset as a total, and in every case
the answer looked tidy while the question had been asked of half the tree.

The isolation census moved to **292 writes and 955 reads**: the new
`.update(serviceItems)` and the `.from(chartAccounts)` the account picker needs,
both guarded. It moved by one in each direction and five documents had to
follow, which the pinned register reported rather than a person noticing.

`RegistryError` throw sites: **42 → 43**. Fifth time that file has reported a
count somebody moved — and the first time it was checked deliberately rather
than going red, which is the habit the four before it bought.

ADR 0199's `PHASE_DELIVERABLES` entry for §14 permissions claimed *"granular
grants and revocations layered on top"*. Corrected: that was an obligation of
this phase rather than a feature of it.

## What this does not do

**It does not claim a column with a writer is reachable by a person.** The scan
cannot tell a spread from a form, and the `because` field is where the
difference is stated. Every entry was confirmed by reading the writer.

**It does not cover `src/db/seed.ts`.** The seed writes
`service_items.inventoryAccountId` and wrote it throughout the years in which
no company could — which is the opposite of reassuring, and why the scan reads
`src/modules` and `src/app` only. A column a demo company has and a real one
cannot is the exact shape this phase is about.

**It does not ask whether a writer is reachable by the right person.** A column
set only by an importer is writable by this register's rule, and whether the
screen should also offer it is a question per column that nothing here answers.

## Nominated for Phase 202

**§14's per-permission grants and revocations — the editor for
`memberships.permissionOverrides`.**

It is the sharpest of the four findings and the only one that is a security
capability: `effectivePermissions` already applies a grant and a revoke, the
spec asks for them, and the §20 register claimed them until this phase measured
it. The mechanism is complete except for anything that could use it, which is
Phase 160's shape and the cheapest kind of phase to build — a screen against a
function that already works.

Two things it has to decide rather than inherit. **Nobody may grant themselves
what their own role lacks**, or the override is a privilege escalation with an
audit trail. And a revoke on an owner is a way to lock a company out of its own
books, so the floor has to be named and refused rather than left to whoever
clicks first.

Behind that: `vendors.organizationId` and the kind of field it needs; the four
joins from an unscoped primary (ADR 0198); and §11's six remaining functions.
