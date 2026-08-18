# ADR 0025 — A firm does not put everybody on everything

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §14 ("accountant/client relationships … **granular
  overrides**"), §19 (least privilege)
- **Builds on:** [ADR 0018](0018-access-is-granted-never-claimed.md),
  [ADR 0013](0013-a-stolen-password-is-not-enough.md)

## Context

Phase 18 built practice mode and named its own largest hole in the README:

> **A practice member reaches every client of the firm.** There is no per-client
> staff assignment, so a firm that wants one junior on one client and not the
> other cannot say so.

That was the right trade at the time — Phase 18's claim was *access is granted,
never claimed*, and it was about the boundary between two organisations. Who
inside the firm does the work is a different question, and answering it badly
would have muddied the one Phase 18 was making.

It is also the question every real firm has. One client is a director's
brother-in-law; another is in a dispute with a member of staff; another is a
listed company with an independence policy. A ten-person firm with forty
clients does not put ten people on forty sets of books, and until this phase
this application had no way to write that down.

Three claims, asserted in `tests/practice.test.ts`:

1. **Access is assigned, not inherited from working at the firm.**
2. **Taking somebody off takes their access away on their next click.**
3. **The client's cap still wins, whatever the firm decides.**

## Decision 1: a mode per engagement, not a setting per firm

`practice_engagements.staffing` is `whole_firm` or `assigned_only`, per client.

A firm-wide switch would have been one column less and the wrong shape: the
firm that needs this needs it for *one* client, and forcing the strict mode on
all forty means either assigning forty clients by hand on the day of the
switch, or never switching. The default is `whole_firm`, so every engagement
that existed before this phase means exactly what it meant before it.

## Decision 2: `entitledStaff` is the one place that decides

Four things change who should be on a client's books: accepting an engagement,
somebody joining the firm, an assignment made or withdrawn, and the mode
changing. All four call `entitledStaff` and then `reconcileEngagementMemberships`.

Four call sites answering "who can open these books" separately is four chances
to answer it differently, and the answer that counts is whichever ran last —
which is not a property, it is a race. `grantAtLiveEngagements` was rewritten to
reconcile rather than grant for exactly this reason, and that rewrite is what
makes joining a firm stop meaning "reach every client" without the invitation
flow knowing that anything changed.

## Decision 3: roles narrow in one direction, and only one

An assignment may carry a `role`, which narrows what that person holds at that
client. It cannot widen: `narrowerOf(assigned ?? theirDefault, engagement.grantedRole)`
runs on every path, so the client's cap is applied last and applied always.

That is what makes it safe to store the resolved role on the membership row and
never re-derive it. A `sales` assignment on an `accountant` engagement produces
`sales`; an `owner` assignment produces `accountant`, because the client agreed
to an accountant. There is no flag that reverses the order.

## Decision 4: reconcile reads before it writes

`granted` means *newly* granted. Counting the writes instead reports "2 people
granted" for a reconcile that gave one person access and rewrote an unchanged
row for somebody who already had it.

The number on a permissions screen has to be the number of people whose access
actually changed, or the screen is worse than no screen — somebody watching it
for a change they did not expect will see one every time.

## Decision 5: the preview comes before the button

`staffingChangePreview` answers "what would this do" without doing it, and the
count is rendered beside the button rather than in the result.

"This tightens access" and "this locks four people out of a client mid-close"
are the same click, and the difference is a number. A permissions change nobody
could see coming is one somebody reverses in a panic, and a firm that has
reversed a security change once does not make it again.

## Decision 6: switching refuses to leave a live client with nobody

`setEngagementStaffing` throws rather than reconcile to zero on an `active`
engagement.

A firm that locks itself out of books it has accepted responsibility for has
not tightened its security, it has created an incident — and the way out is a
client who has to go and re-invite the firm they already engaged. The refusal
carries the fix in its message: assign somebody first.

The check is on `active` only. An engagement still pending can be staffed to
nobody, because it grants nobody anything yet, and a firm deciding who will be
on a client *before* the client says yes is the sequence a firm actually
follows.

## Decision 7: an assignment under `whole_firm` grants nothing, and is kept anyway

Naming somebody on an engagement that is open to the firm changes no
memberships. The row is written regardless.

This is what lets a firm build the list first and tighten second — which is the
only order that does not produce an outage. Tightening a client nobody has been
assigned to is a change with no preview worth reading; tightening one where the
list was assembled over a week is a change whose preview says "nobody would
lose access".

## Decision 8: a stale assignment entitles nobody, and is not deleted

Somebody removed from the firm loses every membership (Phase 18) but keeps
their assignment rows. `entitledStaff` joins against *active* members, so the
row grants nothing.

Deleting them would be a second path that removes assignments, owned by a
function that was not asked to. If they are re-hired, the firm's arrangement is
still written down — and if they are not, the row is inert.

## Decision 9: the client is told the mode, not the reason

`/settings/access` distinguishes "everybody at the firm" from "assigned to you
specifically". It does not show the firm's assignment list, or who was taken
off and when.

The client chose a firm and capped its role; picking staff is the firm's job,
and a client with a veto over which junior is on their file has hired the
junior, not the firm. What the client is entitled to know is the *shape* of the
exposure — "any of Hartley & Co's ten people can read this" and "these two can"
are different answers to the question the page exists to answer, and a list of
names alone cannot tell them apart.

## Decision 10: revocation lands on the next request, and nothing new was needed

Phase 13 made `resolveSession` re-read the membership on every request, and this
phase is what that was for. Taking somebody off a client deletes their
membership in the same transaction, so they lose the books on their next click
rather than when a session happens to expire.

No session invalidation, no token version, no cache to bust — because the
decision to re-read was taken twelve phases ago and paid for since.

## Consequences

- **Only a practice owner can staff a client.** A firm with a managing partner
  per office has no way to delegate that, and `practice_members.practice_role`
  has exactly two values. The check is in one function, which is what makes a
  third role a small change; it is still a change.
- **Nothing records why somebody was taken off.** `note` is on the assignment,
  so it dies with the row. A firm asked to demonstrate that a conflicted member
  of staff was removed on a particular date has the audit log at the client and
  nothing at the firm.
- **`whole_firm` is still the default, including for new engagements.** A firm
  that wants strict staffing everywhere sets it per client, forty times. The
  spec's "granular overrides" is what this builds; a firm-level default is not
  in it.
- **The staffing panel loads per client, on demand.** Phase 22's reasoning: a
  firm with forty clients would otherwise run forty staffing queries to render
  forty collapsed rows. The cost is a click before the answer.
- **A client cannot ask for assigned-only.** The mode is the firm's, and a
  client who wants "only these two people" has to say so out of band and trust
  the firm to set it. What they can do is cap the role and end the engagement.
- **Assignments are not carried across engagements.** A client who ends an
  engagement and re-engages the same firm starts from an empty list, because
  the assignment rows hang on the engagement id. That is deliberate — a
  relationship that stopped and restarted is a decision to re-take — and it is
  also a re-typing task nobody will enjoy.

## Follow-up

1. **A manager role at the firm**, so staffing can be delegated below the owner.
2. **A firm-level default** for new engagements, once a firm has enough clients
   for forty per-client decisions to be the annoyance.
3. **An audit trail at the firm**, not just at the client — assignments made and
   withdrawn, kept after the row is gone.
4. **Let the client ask for assigned-only** as part of accepting an engagement,
   so the cap is not the only thing they control.
