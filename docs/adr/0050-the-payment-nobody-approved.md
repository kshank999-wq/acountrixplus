# ADR 0050 — The payment nobody approved

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §14, §19. One person could create a supplier, enter a
  bill to it, and pay it — and nothing recorded who entered the bill.
- **Builds on:** [ADR 0041](0041-the-document-you-raise-yourself.md),
  [ADR 0045](0045-the-record-you-can-never-fix.md),
  [ADR 0047](0047-the-supplier-reference-is-not-our-number.md),
  [ADR 0049](0049-what-you-owe-and-choosing-what-to-pay.md)

## Context

Phases 45, 41 and 49 each added a step, and together they closed a loop nobody
had looked at whole:

1. **Create a supplier** (Phase 45) — `accounting:journal`.
2. **Enter a bill to it** (Phase 41) — `accounting:journal`.
3. **Pay it** (Phase 49) — `accounting:journal`.

One permission, three steps, one person, and Phase 49 turned the last step into
a single click across a whole batch. That is the fictitious-supplier fraud, and
it is the control most small-business theft actually exploits — not a clever
exploit, just nobody looking.

The record could not have caught it either. `bills` carried a `created_at` and
nothing about **who**. An auditor asking "who entered this?" had no column to
read, and there was nowhere in the schema for a second person's agreement to
appear even if somebody had given it.

## Decision 1: the two-person rule is what actually separates entering from approving

The obvious design is to split it by permission — a bookkeeper enters, an
accountant approves — and it does not work here. **A bookkeeper cannot enter a
bill at all:** `createBill` requires `accounting:journal`, which that role does
not have. Everybody who *can* enter a bill is already senior enough to approve
one. Splitting by role alone would have shipped a control that constrains
nobody.

So the rule that bites is **not the bill you entered yourself**. `mayApprove`
compares `bill.enteredBy` with the actor and refuses the match, and
`createBill` now stamps `entered_by` so there is something to compare.

`accounting:approve` still exists as its own permission, because entering and
approving should be separately grantable — the seam is for a company that
widens things, where a colleague granted `accounting:journal` as a
per-membership override to enter supplier bills does not thereby gain the power
to clear them. It is a seam, not today's enforcement, and the code says so
rather than implying more than it does.

## Decision 2: off by default, with a threshold the company sets

The costly wrong answer here is not "an unapproved bill sat for a day" — that
is a delay. It is **making a business that does not want this unable to pay
anybody**. A sole trader is their own bookkeeper and their own approver, and a
system that ships this switched on has shipped a feature most of its users must
immediately disable.

So `payables_settings` starts absent, `payablesPolicy` reads that as off, and
three decisions are separate:

- **enabled** — whether any of this applies.
- **thresholdCents** — bills at or above this need approving; zero means every
  bill. A threshold rather than all-or-nothing because the point is *attention*,
  and attention is finite: a rule that stops the week for a small parking
  receipt is a rule somebody approves without reading, which is worse than no
  rule at all.
- **twoPersonRule** — whether the approver may be the person who entered it.
  Separate from the threshold on purpose: "somebody must approve the big ones"
  and "it may not be the same somebody" are two different decisions, and a
  two-person business may want the first without being able to honour the
  second.

Switching the control **off** needs `accounting:approve`, not the lesser
permission. Somebody who can disable approvals is not subject to them.

## Decision 3: a pay run holds back rather than refusing

Somebody ticking eight bills of which one needs approving gets the seven paid
and is told about the eighth. Refusing the lot teaches them to switch approvals
off, which is the opposite of what the control is for.

`splitByApproval` divides the chosen set; `describeHeld` writes the sentence.
The screen disables the checkbox on a bill that is waiting, so the total on the
button and the money that leaves agree — but the server splits again regardless,
because `payRunAction` takes bill ids from the wire and a screen is not a guard.

## Decision 4: nothing is backfilled

A bill entered before this phase has no honest answer to "who entered it".
Inventing one — the owner, say — would put a name against a decision that person
may never have made. So `entered_by` stays null on historical bills, and the
two-person rule **stands aside** when it has nothing to compare rather than
refusing: otherwise every pre-existing bill would be unapprovable for ever.

The same applies to an approval already given: it still reads as given even if
the policy is later switched off, because it happened.

## Decision 5: an approval cannot be withdrawn after the money has gone

An approval is a statement that money may leave. Once it has left, withdrawing
the statement changes nothing on the bank and leaves a paid bill reading as
though it was never authorised — a worse record than the truth. `withdrawApproval`
refuses once `balanceCents !== totalCents` and says to void the payment instead.

## What the browser found

Two defects, both in the first three clicks.

**The first save wrote a threshold of zero.** `updatePayablesPolicy` used
`APPROVAL_OFF` as the baseline for a company that had never decided anything —
and `APPROVAL_OFF.thresholdCents` is zero, because nothing reads it while the
control is off. So ticking "Require approval" and nothing else made **every**
bill need a second person, including a $4 parking receipt: precisely the failure
the module's own comments warn about, and a silent override of the $1,000 the
schema had chosen as its default. `APPROVAL_OFF` is the right answer for a
*read* and the wrong seed for a *write*, so `STARTING_POLICY` is now a separate
constant and the service picks between them on whether a row exists.

**The switches snapped back when pressed.** Both checkboxes were bound to the
server value alone, so for the second between the action returning and
`router.refresh()` landing they read as not having worked. Playwright failed on
it outright — *"clicking the checkbox did not change its state"* — and a person
does what I did: clicks again, turning the control straight back off. They are
now held locally and re-synced from the server, so a refused save still corrects
itself.

## Consequences

- `bills` carries `entered_by`, `approved_by`, `approved_at`.
- `payables_settings` holds one row per company, absent until somebody decides.
- `accounting:approve` joins the permission list, granted to accountant and
  owner.
- `bill.approve` and `payables.policy` join the audit actions, so switching the
  control off is itself visible afterwards.
- A pay run may pay less than was ticked, and says so.

## What this does not do

It does not stop somebody with `accounting:journal` **and** `accounting:approve`
entering a bill, waiting, and approving it themselves — nothing here can, short
of a second human. It stops it happening in one motion, records who did each
half, and makes the gap visible on the screen and in the audit log. That is what
a segregation control is: not a wall, a witness.

It also does not touch invoices, journal entries, payroll runs or counter
takings. Money leaves by more doors than accounts payable, and each of those is
its own decision about what a second pair of eyes is worth.
