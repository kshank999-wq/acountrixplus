# 0205 — Offered, and not offered

**Status:** accepted
**Date:** 2026-11-09
**Phase:** 205

---

## The last two of six

Phase 202 narrowed the column census's exclusion for a defaulted column — a
`defaultRandom()` key is the whole answer, a `.default(true)` boolean is a
starting value for a state — and found **six `isActive` columns nothing could
turn off**.

Reading each reader split them into two kinds, and that split decided the order
they were closed in:

| | |
| --- | --- |
| **enforced** | a refusal already written, so the whole gap was the writer. `memberships` (Phase 202), the gift card (203), the till and the practice (204). |
| **projections only** | selected to be *displayed* and filtered by nothing, so a writer alone would hand somebody a control with no effect. The clause library and the bill of materials — these two. |

ADR 0204 nominated them *filter first*. **All six are closed now.**

That split only exists because of a correction. Phase 202's register entry for
`bills_of_materials.isActive` claimed the recipe a work order is built from was
filtered on it, and nothing filters on it at all; the entry for
`cash_drawers.isActive` said the pickers were filtered where the reader
actually **refuses**. Reading the call sites fixed both, and without that the
cheap closures and the expensive ones would have looked identical.

## One phase, two mechanisms: copying against referencing

*Filter first* was right and incomplete. Measuring showed the two need the
filter in **different places**, and the reason is what a retired thing is used
for afterwards.

**A clause is copied.** A document block stores `clauseVersionId`, not a clause
id, because *"what a client was shown must not"* change — `blocks.ts`'s own
words. The wording on every proposal ever sent is reached through the version,
so retiring the clause is invisible to all of them, and there is no later moment
at which a retired clause could be acted on. **Not offering it is the whole
job**, and ADR 0021 is satisfied by the schema rather than by a rule.

So `listClauses` filters, and the option is `includeRetired` — **opt-out**.
Three screens read that list: two *offer* clauses for a document and one is the
library where you manage them. A caller who forgets the flag should get the safe
answer, and for an offer the safe answer is "only what is still approved". A
fourth picker added in two years gets it without knowing this decision exists.

That matches `listTeamMembers` in the same module, where the Studio page already
passes `{ includeRetired: true }` under a comment calling itself *"the one
screen that can restore them"*. `listServiceItems` is the odd one of the three
with its opt-in `activeOnly`, and it is left alone: its callers were written
against that flag, and changing it is a behaviour change in five screens dressed
as a tidy-up.

**A work order references.** `requirementsFor` and `completeWorkOrder` look the
recipe up by the id the order already names. Filtering *there* would cost a
half-built batch the recipe it was costed against, which is a worse outcome than
the gap being fixed. So a superseded recipe stays readable for ever, and
`createWorkOrder` refuses to **start** a run against one.

The refusal is in the service and not only in the picker, because the rule is
*"you may not start a run against this"* and a rule that holds only on the
screen that remembered to filter is not the rule. It also closed something
nobody had asked about: **nothing validated `bomId` at all** — not its
existence, not its tenant, not its state. The composite foreign key had been
doing the first two.

## Where each filter lives, and why they differ

The clause filter is in the module; the recipe filter is in the markup. That is
not inconsistency, it is the shape of the callers:

- Three different pages consume `listClauses`, two of which must not offer a
  retired clause. Relying on three screens to remember is the trap.
- One page consumes `listBoms`, and it serves **both** purposes from one prop —
  the work-order `<select>` and the recipe tab. The filter there is local,
  visible in the same file as the list it narrows, and the rule it enforces is
  in the service anyway.

## What moved

`COLUMN_WRITERS` lost both entries, which is the two-direction rule working for
the fourth phase running. The pinned census: **32 → 30 candidates**.

The register now declares **one finding**: `vendors.organizationId`. The other
twenty-nine entries are columns something writes through a spread or a helper's
return, which is what the register was built to hold. Phase 202's own test
asserting which switches are declared is at its third and final state — five
entries, then two, now **none** — and a register that empties out on a class it
opened is the outcome the two-direction rule exists to make visible.

Four audit actions: `clause.retire`, `clause.restore`, `bom.retire`,
`bom.restore`. The isolation census: **299 writes and 966 reads**.

## What this does not do

**It does not stop a draft document carrying a retired clause.** A block holds
a version id and nothing validates it against the clause's state — deliberately,
because a draft that suddenly refuses to save is hostile, and the clause was
approved when it was added. Retiring stops the offer and nothing else.

**It does not supersede a recipe *in favour of* another.** There is no
`replacedBy`, so the relationship between the old recipe and the one that
replaced it lives in their names. A chain somebody can follow is a column and a
screen.

**It does not touch `listServiceItems`' opt-in flag**, which has the same latent
shape: a caller that forgets `activeOnly` offers retired items. Five screens
read it and each would need checking, which is a phase rather than a line —
nominated below.

**It does not close `vendors.organizationId`.** The supplier who is also a
client, which `engagement/filing.ts` exists for. The correction screen is driven
by `VENDOR_FIELDS`, a registry of text fields, so a link to a CRM record is a
new *kind* of field.

## Nominated for Phase 206

**`listServiceItems`' `activeOnly`, measured across its callers.**

It is the last of the three list functions with the unsafe default, and the
reason to do it now is that this phase just argued at length about why the other
two have it the other way round. `serviceItems.isActive` has had a writer since
Phase 4 (`deactivateServiceItem`), so unlike the six switches there is no
missing control — the question is only **which screens are offering retired
items today**, and that is a count nobody has.

Two things it has to decide rather than inherit. A retired item on a **draft
invoice or proposal line** is the clause question again, and the answer should be
the same: stop the offer, leave the document. And an item retired while it still
holds **stock** is the till's question — `stockOnHand` reads every inventoried
item, so retiring one with a quantity on it would hide a balance the subledger
still carries and the Inventory account still agrees with.

Behind that: `vendors.organizationId` and the kind of field it needs; the four
joins from an unscoped primary (ADR 0198); and §11's six remaining functions.
