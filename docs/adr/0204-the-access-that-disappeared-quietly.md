# 0204 — The access that disappeared quietly

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 204

---

## The nomination, and the thing beside it

ADR 0203 nominated the two remaining **enforced** switches — the ones where a
refusal is already written, so the whole gap is the writer:
`cash_drawers.isActive`, which `openShift` refuses on, and
`practices.isActive`, which four queries filter on.

Both held. What measuring the practice table added is a defect neither census
could have reported, because **both censuses are about columns** and this one
is about a write that never happens.

Three things a firm can do remove a client's access to their own books, and the
client's audit log said nothing about any of them:

| | |
| --- | --- |
| `endEngagement` | wrote its event **only** `if (party.side === 'client')`. When the accountant walked away — taking every membership the engagement granted — nothing was recorded. |
| `removePracticeMember` | deletes the memberships that person held at *every* client of the firm, and audited nothing, on either side. |
| closing a practice | would have been a third. It refuses while engagements are live instead. |

§14 asks for an *"Audit log for logins, exports, changes to transactions /
journals, reconciliations, **permissions**, and sensitive settings."* Losing
your accountant's access is a permission change on your books. The client could
see the engagement's `status` had become `ended`; what they could not see is
**when, by whom, and that it had happened at all** without going to look.

### Why it was never a decision

`recordAudit` needs a company, a person and a name, and the practice side has
no company of its own. That is the whole reason the `if` was there.

But all three are on the engagement — `companyId`, the practice member, and the
firm — and `ActorContext.viaPractice` exists for exactly this. Its own comment
says the client *"should not have to cross-reference a user list to find out
that the person who reopened December works for their accountants"*. The field
was built to produce the line **"Dana Chen (Hartley & Co)"**, and the two
actions where it matters most never produced it.

`practiceActorContext` is where that is resolved rather than worked around. Its
`role` is the engagement's `grantedRole`, not a placeholder, because that is
the role the member actually held on that company; nothing checks a permission
with it — the practice-side authority is `requirePracticeOwner` — but a context
carrying a role nobody held would be a fact invented to satisfy a type.

`removePracticeMember` writes **one event per client** whose books it touched,
because a client's audit trail is theirs: an event filed against one of twelve
companies is eleven companies with no record. The action is
`engagement.member_removed` rather than `engagement.end`, because the
engagement is still active — one person left the firm, and the firm still has
the books.

One extra column made it possible. That function selected
`{ id: practiceEngagements.id }`, which is all the delete needed and the reason
the audit could not be written: the rows removed name a person and an
engagement, and the log a client reads is keyed by company.

## The asymmetry the till settles

ADR 0203 predicted retiring a drawer would need Phase 203's shape — a decision
about where the float went, the way stopping a gift card needs one about its
balance. **It does not, and the reason is worth keeping.**

A gift card's balance is a **liability on account 2590**: making the card
unspendable without moving that figure leaves money nobody can ever settle,
which is why `closeGiftCard` refuses without a disposition. A drawer's float is
**cash in a drawer**, and `closeShift` already accounts for it — the Z-reading,
the expected figure, the over-or-short posting.

So `setDrawerActive` refuses only while a shift is open, and posts nothing. One
sentence instead of three dispositions, because the money was already somebody
else's problem and that somebody already solves it.

## Closing a firm

`practices.isActive` is read in four places, and the strongest reader is the one
that makes it the right way to close a firm rather than a flag about one:
`practicesFor` filters on it, so an inactive practice disappears from its **own
members'** list and none of them can switch into it again. The others keep it
out of the client's search, the offer path and the nightly sweep.

The asymmetry was exact: `removePracticeMember` writes
`practiceMembers.isActive = false`, so **a firm could retire its people but not
itself.**

Refused while any engagement is `active` or `pending`, with the count in the
message. A closed practice holding live engagements would be an outside firm
with access to somebody's ledger and no firm to answer for it — the client's
access board reads the firm's name through a join, and the firm would be gone
from every list that could answer. That is Phase 203's judgement again: the
thing that is owed gets dealt with before the switch moves.

### No audit row for closing one, and why that is honest here

`audit_events.companyId` is not null and a practice is not a tenant. Every
practice-side action is in that position, which is what
`practiceActorContext` exists to resolve — for actions that touch a *client's*
books. Closing a practice cannot touch any, because it is refused while any
engagement is live. So there is no company whose log it belongs in, and filing
it against an arbitrary one would be worse than not filing it. Declared rather
than papered over.

## What this phase got wrong first, and caught

The register entry for `cash_drawers.isActive` said *"`drawer/service.ts`
filters the pickers on this"*. It does not: `openShift` **refuses** on it,
which is stronger and a different mechanism. The entry for
`bills_of_materials.isActive` claimed the recipe a work order is built from was
filtered on it, and nothing filters on it at all.

Both were corrected in Phase 202 by reading the two call sites, and that
correction is what produced the distinction this phase's ordering rests on:
**enforced** switches (a refusal already written, so one change) against
**projection-only** ones (selected to be displayed with nothing filtering, so a
writer alone would hand somebody a control with no effect — two changes). The
three enforced ones went first. Had the register been left as drafted, the
cheap ones and the expensive ones would have looked identical.

## What moved

`COLUMN_WRITERS` lost both entries, because the scan no longer reports either
column — the two-direction rule working for the third phase running. The pinned
census: **34 → 32 candidates**.

The insert-only limitation went **769 → 770**, and the direction is worth a
sentence because it looks like a regression and is not: `removePracticeMember`
now returns `memberships.companyId` so it can file an audit event per client,
which *names* a column that is written at insert and never updated. **A column
enters that number by being read for the first time.**

The audit action union gained `engagement.member_removed`, `drawer.retire` and
`drawer.restore`, and `engagement.end` gained an `endedBy` on its `after` —
because *"we took our books back"* and *"they resigned"* are different facts
about the same row, and the actor's name alone does not distinguish them.

The isolation census: **297 writes and 963 reads**.

## What this does not do

**It does not audit a practice-side action that touches no client.** Adding a
practice member, creating a firm, closing one: all of them are unauditable in
a tenant-scoped log, and a practice-level audit log is a schema change and a
screen rather than a line.

**It does not notify the client.** An audit entry is a record somebody can
find; it is not a letter. A client whose accountant resigns learns it from
their access board or their log, not from their inbox, and deciding that it
should be an email is a §22 question about what this application sends.

**It does not retire the last two switches.** `clauses.isActive` and
`bills_of_materials.isActive` are **projections only** — selected to be shown
with nothing filtering on either — so each needs a filter as well as a writer.
Declared in `COLUMN_WRITERS` with which kind they are.

## Nominated for Phase 205

**The two projection-only switches, as one phase, filter first.**

`clauses.isActive` and `bills_of_materials.isActive` are the two that are left,
and they are the same job twice: a `listClauses` and a work order's recipe
lookup that select the column and ignore it. Doing them together is right
because the mistake to avoid is identical in both — shipping the writer and
leaving the filter, which is Phase 160's *installed and inert* reached by
closing half a gap, and this time with the register already saying so.

Two things each has to decide rather than inherit. A **retired clause already
on a sent proposal** must stay exactly where it is: ADR 0021 says a sent
document never changes, and clause *versions* exist precisely so approved
language cannot be rewritten underneath one — so the filter belongs on the
picker and nowhere near a document. And a **superseded bill of materials with
work orders still open** cannot simply vanish from the lookup, or a half-built
batch loses the recipe it was costed against; the filter has to be on *choosing*
a recipe, not on reading the one a work order already names.

Behind that: `vendors.organizationId` and the kind of field it needs; the four
joins from an unscoped primary (ADR 0198); and §11's six remaining functions.
