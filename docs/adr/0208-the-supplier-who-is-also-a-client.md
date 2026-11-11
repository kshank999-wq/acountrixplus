# 0208 — The supplier who is also a client

**Status:** accepted
**Date:** 2026-11-11
**Phase:** 208

---

## The column one module existed for and nothing could write

ADR 0207 nominated **`vendors.organizationId`** — the last declared finding in
`COLUMN_WRITERS`, and after five phases of closing switches and defaults the
one thing the column census still reported as a column nothing could write.

The nomination measured true in every part but one, and the exception is the
whole phase.

`organizations` is this application's single party record, and customer and
vendor are **accounting roles** it plays. The schema says why in its own words:
*"a firm you both buy from and sell to is one organization with two accounting
roles, not two conflicting rows"*. `customers.organizationId` and
`vendors.organizationId` are the two pointers that make that true.

`engagement/filing.ts` is 163 lines about exactly that firm. One shared inbox
can be a contact, a customer **and** a supplier at once, so resolving an
address gives candidates rather than an answer, and picking by precedence would
file a **remittance advice on a customer's record** — our own payment advice
stored against somebody's debt to us, where the next person to open that
customer reads it as something we sent them about what they owe.
`KIND_CONCERNS` writes the answer down exhaustively: a remittance is payables
and belongs to the supplier. And `columnsFor` carries the organisation along
*"whenever the party has one"*, so the letter also appears on that client's CRM
timeline, *"which is where somebody who has both will look first"*.

**For a vendor the party never had one.** `crm/conversion.ts` writes the
customer side when an opportunity is won — twice over, by link and by adopting
an unlinked namesake. `createVendor` has no such input and `updateVendor` has
no such field. So the one case the module exists for was the one case it could
not serve, for 207 phases, and the sentence in `columnsFor`'s own docstring was
true of customers and contacts and false of vendors.

## Why five ADRs declared it rather than closing it

ADRs 0201 through 0207 each carried the same reason forward:

> the vendor correction screen is driven by `VENDOR_FIELDS`, a registry of
> **text fields** with a three-way `kind` that says what changing one means. A
> link to a CRM record is a new *kind* of field, and `diffParty` would render
> it as a uuid in the audit trail unless the registry learns that some fields
> are references whose *name* is what a person reads.

Every clause of that is true. `VENDOR_FIELDS` is a registry of text fields;
`diffParty` does `String(value)`; and the audit trail is not decoration —
changing a vendor's payment details is the commonest invoice-fraud vector a
small business meets, which is why every field carries before and after.

**The conclusion does not follow, and measuring the nomination is what showed
it: the customer side is not a field either.** `CUSTOMER_FIELDS` has no
`organizationId` entry at all. The link on that side is written by an **act** —
winning an opportunity — and the fields registry knows nothing about it.

And the people board already carries an act beside the correction form.
`mergeParties` (Phase 96) takes two record ids, shows what would move before
anybody commits, refuses a blank reason with Phase 70's own prompt, and writes
both records' history. Putting two records of one business together is the same
shape as recognising that one business is on both sides of the books.

So `setVendorOrganization` is an act. `VENDOR_FIELDS` learns nothing, the
registry that was the stated obstacle is untouched, and the audit entry carries
the organisation's **name** — which answers the uuid worry by not having the
problem rather than by solving it.

That is the finding worth more than the fix: **the obstacle was in the
framing, and it survived five ADRs because each one inherited the sentence
rather than the measurement.** Phase 164's rule — *a nomination inherited is a
nomination unmeasured* — has been about counts and premises for seven phases.
This is the first time it has been about a declared *reason*.

## The four refusals

Each argued from something the code already does rather than from tidiness.

- **An unknown vendor, or an unknown client.** Both read under `scoped()`.
- **A supplier already linked elsewhere.** Repointing is refused. The link
  decides which client's timeline this supplier's letters land on, and a
  remittance already filed against the old organisation **stays filed there** —
  `communications` records what was true when the letter went (ADR 0021's rule
  one table over). Moving the link would leave one firm's payment advice on
  another firm's record with nothing saying it had moved. The refusal names the
  client it is linked to, because *"already linked"* alone is a refusal nobody
  can act on (Phase 47).
- **A client already linked to another supplier.** The customer side has read
  this as one-per-organisation since Phase 45, which found two customer records
  for one client splitting their aging, their statement and their balance, with
  no screen on which anybody could see it had happened. Two supplier rows for
  one client would split that client's payables the same way. The refusal names
  both escapes: unlink the other, or put the two records together.

**The undo ships in the same phase**, on Phase 206's own finding. A writer that
only ever moves one way is invisible to the column census *and* to its mirror,
because the column is read and written — and it is indistinguishable from a
working control until somebody wants it back. `deactivateServiceItem` was that
for 202 phases. `null` unlinks, and the log has its own word for it:
`vendor.link_organization` and `vendor.unlink_organization`.

Both permissions are asked for, and the role table makes that a real case
rather than a hypothetical one. `accounting:journal` because this is an edit to
a supplier, which decides where money goes. `crm:view` because the other end is
a CRM record. An **accountant** has the first and not the second, so the role
most likely to be editing a supplier is refused — naming a client by trying ids
is what `crm:view` exists to prevent — and **sales** has the second and not the
first. The board hides the picker *and the linked client's name* from a reader
without `crm:view`, by taking its client list as a list **or null**: an empty
list would have hidden the control and still printed the name.

## What this does not do

**It does not set the organisation's `lifecycleStage` to `'vendor'`.** A
lifecycle stage holds one value, so writing `'vendor'` over `'active_client'`
would delete the more important half of precisely the fact being recorded. That
a single stage cannot say *both* is the reason the link column exists at all,
and `'vendor'` stays what §6 lists for a firm that only sells to us.

**It does not merge the two pointers.** `customers.organizationId` is written
by conversion and adoption; this one by an explicit act. They could share a
mechanism and the argument for it is not made here: a supplier relationship is
not *won*, so there is no event to hang it on, and inventing one would be the
customer side's shape forced onto a case that does not have it.

**It does not give the CRM account panel a payables side.** `crm/accounts.ts`
builds its facts from customers, opportunities and tasks. The link now exists,
so what a client's own panel should say about what we buy from them is a
question that can finally be asked — and it is a screen rather than a column.

## What moved

**The column census is at 29 candidates and no findings** — the first time
since Phase 201 built it that the register has nothing open. Its `unwritable`
verdict is kept with no entry carrying it, on Phase 157's rule that an unused
declaration stays when it *accuses*: a register with no word for a finding
cannot report the next one, and the five phases this one took are the argument
for leaving both the verdict and its section heading where they are.

The isolation census: **301 writes and 972 reads**, two writes and five reads
added, every one `scoped()`. The five reads are all refusals rather than
lookups, which is most of what this function is.

Two audit actions. `columnsScanned` is unchanged at 185 tables and 2,179
columns, and `insertOnlyColumns` at 770.

### Three more places one number lived

The register's candidate count was asserted in **four** test files. Phases 204,
205 and 207 each spent a full-suite run discovering one of them; this phase
found the remaining three at once, because closing the last finding moved every
count at the same time.

They have one home now — `tests/a-column-nobody-could-fill.test.ts`, which owns
the register because Phase 201 built it there. Phase 205's file keeps the two
columns Phase 205 closed, Phase 202's keeps the exclusion's two directions, and
the new file keeps its own column and the kept vocabulary. The fix is the one
Phase 207 settled on for `OPT_IN_CANDIDATES`: not *remember to update both*,
which is what failed four times, but *there is only one*.

Both of Phase 202's files survive the removal without weakening, which is the
test that the total was not doing their work.

### A number in prose nothing read, found in a test

`tests/audit-story.test.ts` has said since Phase 71 that *"there are 224 audit
actions and words have been decided for five of them; the other 219 are handed
back"*. Measured while adding two: **257 actions and seven named.** Thirty-three
actions had been added without the sentence moving, and the named count had
been wrong by two since Phase 97 connected `party.merge`.

That is Phase 179's finding — a number in prose that nothing reads goes stale
while the claim around it stays true — in a **test** rather than in a document,
where `PINNED_CLAIMS` does not reach. The numerator is asserted now:
`namedActions()` is exported and the seven are listed, so adding a mapping
without saying so goes red. The denominator stays prose with its reason stated
(Phase 185), because `AuditAction` is a type and counting its members means
parsing the source.

## Nominated for Phase 209

**The four remaining `activeOnly` opt-in defaults, read one at a time.**

`listEmployees`, `listTaxCodes`, `listCostCodes` and `subcontractorSummaries`.
`listAccounts` keeps its flag deliberately, because two of its callers need the
whole chart — Phase 206 fixed its four pickers at the call sites instead, and
Phase 207 declined to flip it on the grounds that the flip had never been
measured there.

It is nominated with the warning its own two predecessors earned: **guessing
which callers are offers and which are lists has produced a wrong number
twice**, nine for four in Phase 207 and seven for six in Phase 206. The
deliverable is the reading, and `listEmployees` is the one to start with,
because an employee who has left appearing in a payroll run picker is the same
class of defect as a closed bank account on a refund.

Behind that: the CRM account panel's missing payables side, which this phase
makes askable; the four joins from an unscoped primary (ADR 0198); and §11's
six remaining functions.
