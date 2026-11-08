# 0202 — The switch painted on

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 202

---

## The nomination was one of four

ADR 0201 nominated the editor for `memberships.permissionOverrides` — §14's
granular grants, *"installed and inert end to end"*: declared, read into the
actor, parsed, and **applied** by `effectivePermissions`, with nothing anywhere
able to write one.

Measuring the table rather than the column found that **`memberships` was
insert-only**. Nothing in the repository updated a membership row. The three
`delete(memberships)` statements are all in `practice/service.ts`, keyed by
`practiceEngagementId`, so they remove only rows an engagement created.

| | |
| --- | --- |
| **no revocation** | `resolveSession` re-reads the membership on **every request** filtered on `isActive`, under a comment saying *"a lock that waits for a session to expire is not a lock"*. §14 asks for revocation. Nothing could set it false, so a directly-hired employee who left kept their access for ever. |
| **no promotion** | `role` is read in eight places and chosen once, at invitation. A bookkeeper who became the accountant could not be made one, and the access board printed the role as plain text. |
| **no overrides** | The nomination. |
| **no audit** | `'membership.update'` has been in `AuditAction` since Phase 3 with nothing ever writing it — `'organization.update'`'s exact shape, unwritten until Phase 78 built the service the vocabulary had anticipated. |

The revocation gap is the serious one and it is a **security** gap, not a
convenience one: §14 asks for revocation by name, the session layer implements
it on every request and explains why that matters, and there was no handle on
it.

## Why Phase 201's scan could not see three of the four

Two blind spots, and naming them is half the phase.

**A default is not always the whole answer.** Phase 201 excluded every column
carrying a default, on the argument that the database supplies it so nothing
has to. `memberships.isActive` is `boolean().notNull().default(true)`.

The distinction this phase draws is between a default that is the whole answer
and a default that is a **starting value for a state**. A `defaultRandom()`
primary key and a `defaultNow()` timestamp are the first — nothing should ever
write them, and reporting them would make a register of 195 excuses. A
`.default(true)` boolean is the second, and a state nothing can change is a
switch painted on.

Narrowed to those two, the census went **27 → 35**. Eight columns of exactly
the kind Phase 201 was built to find, which its own exclusion had hidden, and
**six of the eight are an `isActive` nothing can turn off**.

**A column written at insert is not a column that can be changed.**
`memberships.role` appears in a `.values(` and never in a `.set(`, so the scan
counts it as written. That class is **770 columns**, and almost all of it is
correctly immutable — a journal line's amount, an audit event's action, a sent
document's snapshot, with ADRs 0021 and 0042 existing to keep them that way. So
it is **not** a register: 760 entries saying "correct" would hide the ten that
are not. It is a declared, measured number, and narrowing it needs a way to say
which columns are *state* rather than *record*, which this phase does not have.

`role` was found by reading the table the nomination pointed at. That is the
third time in three phases that measuring the nomination rather than building
it changed what the phase was.

## What was built

One function, `updateMembership`, taking role, grants, revocations and standing
together — because they are one row and one decision. *"Make Sam the accountant
but take away period close"* is a single thing somebody means, and three calls
would write three audit entries, recording a moment where Sam held
`accounting:close` because the role landed before the revoke did.

### The four refusals

Each is a way to lock a company out of its own books or to widen access
invisibly, so each is a refusal with a sentence rather than a disabled button.

1. **Not your own membership.** An administrator who can edit their own row can
   revoke their own `company:manage` by typo and can grant themselves anything
   deliberately. One rule removes both.
2. **Somebody must keep `company:manage`.** Asserted over the **effective**
   permissions of every active membership after the change, so demotion,
   revocation of access and a `revoke` override all come through one predicate
   — `administratorsAfter` — rather than three guards that could drift apart.
   A rule written as *"is there another owner"* would be wrong in the direction
   that locks a company out, because a bookkeeper **granted** `company:manage`
   is an administrator and that grant is exactly the seam §14 asks for.
3. **A practice's membership is the engagement's.** The role a client granted a
   firm is *"a ceiling"*, in the access board's own words, and `endEngagement`
   deletes exactly the rows the engagement created.
4. **Not granted and revoked at once.** `effectivePermissions` resolves that
   silently — revoke wins — but a stored override saying both is not a
   statement anybody can read later.

Granting more than the role is **allowed**, and that is the point rather than
an oversight: `accounting:approve`'s own docstring justifies its existence by
*"a colleague granted `accounting:journal` as a per-membership override"* — a
second site in the codebase reasoning from a capability nothing could exercise.

### One answer to who administers people

`inviteToCompany` gated on `company:manage`. Both it and
`withdrawCompanyInvitation` are on `users:manage` now, with `updateMembership`,
so *"who may change an individual's standing on this company"* has one answer.
`users:manage` is the permission named for exactly this and was read until now
only by `timebilling`, deciding whether somebody may log another person's hours.

Only `owner` holds either permission today, so **no role's behaviour changed**.
What changed is the seam: a company can grant `users:manage` alone and get
somebody who invites, promotes and revokes without the Studio, the module
switches or the billing.

`company:manage` keeps the company's own arrangements, the engagement with a
practice included — a contract with a firm is a different question from a
person's role, and the practice side can end an engagement too.

### One list of roles

There were **three**, with no mechanical relationship: the `Role` union,
`roleEnum` in the schema, and a `MEMBER_ROLES` const in the access board.
Nothing could validate a role arriving from a form, which is what this phase
needed first. `ROLE_NAMES` is the list now and `Role` is derived from it; the
schema enum and the board's own ordering are held to it by assertion rather
than replaced, because a drizzle enum must be a literal and the board's order
— least access to most — is not the order a service wants.

### The second segment filter with no writer

`organizations.tags` is one of §10's named dimensions, with `in` and `contains`
operators of its own and a label on the segment workspace, and nothing set it —
exactly `sizeBand` one phase earlier. It was invisible to Phase 201's scan
because the column carries `.default([])`. It is on the client form now, split
from one comma-separated field, and the audience it promises returns somebody.

## What this does not do

**It does not retire the other five switches**, and reading their readers
showed they are not one finding.

Three are **enforced**: `redeemGiftCard` refuses an inactive card (*"Gift card
X is no longer valid"*), `openShift` refuses an inactive till (*"X is not in
use."*), and four queries filter an inactive practice out of the search a
client picks a firm from. The refusal is written and the state is unreachable,
so each is one change.

Two are **projections only**: `clauses.isActive` and
`bills_of_materials.isActive` are selected to be displayed and nothing filters
on either. A writer alone would hand somebody a flag they could set with no
effect — Phase 160's shape, arrived at by closing half a gap — so each is two
changes.

An earlier draft of the register claimed the recipe a work order is built from
was filtered on `bills_of_materials.isActive`. Reading the two call sites is
what corrected it, and the distinction only exists because of that.

**It does not change a role on a practice engagement.** Refusal 3 says to do
that on the engagement, and the engagement has no such editor either — ending
and re-offering is the path. Named rather than built, because the ceiling is a
thing two parties agreed to and changing it unilaterally is a different
question.

**It does not give the override editor a search.** Forty-odd permissions in a
three-column grid, each with a three-way control. That is legible for one
person's permissions and would not be for four hundred.

**It does not narrow the insert-only class.** 770 columns, measured and
declared. Most are right and this phase has no way to say which.

## What moved

`PINNED_CLAIMS`' column-writer claim: **27 → 35 candidates**, and a twentieth
entry for the insert-only number, so the limitation this phase declares cannot
drift from the prose that declares it (Phase 179's whole point).

`COLUMN_WRITERS`: the `memberships` entry is **gone**, which is the
two-direction rule working — an entry outliving its candidate is the excuse ADR
0134 names. `notification_log` and `proposal_items` each gained columns the
narrowed exclusion exposed, and five `isActive` entries were added.

Phase 201's own test file was corrected rather than relaxed: its census
assertion is 35 now, and its non-vacuity check moved from
`memberships.permissionOverrides` to `vendors.organizationId` — which is the
right reason for a non-vacuity check to need moving.

## Nominated for Phase 203

**`gift_cards.isActive` — the switch nobody can turn off that holds money.**

Of the five remaining, this is the one where the gap is cash: a card reported
lost or stolen, or one a business has agreed to refund, stays spendable for as
long as it has a balance. `redeemGiftCard` already refuses an inactive card by
name, so the whole of the gap is the writer.

It is small, and the reason to do it next is that it is one of the three
enforced switches rather than one of the two that are only displayed — the
refusal exists and nothing can reach it. Two things it has to decide rather than
inherit: whether voiding a card with a balance writes off the liability or
leaves it outstanding — a gift card is deferred revenue, so the answer is a
journal — and whether a void is reversible, which the terms a business prints
on the card may answer for them.

Behind that: the other four switches; `vendors.organizationId` and the kind of
field it needs; the four joins from an unscoped primary (ADR 0198); and §11's
six remaining functions.
