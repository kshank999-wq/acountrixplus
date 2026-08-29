# 0070 — One answer to four questions

**Status:** accepted
**Date:** Phase 70
**Supersedes:** nothing. **Amends:** ADR 0052 (a void must say why), ADR 0050 (approval withdrawal).

## The defect

This codebase keeps refactoring out the same fault: **two answers to one
question**. Phase 62 found a payment's currency in two places, Phase 65 found a
held amount worked out twice, Phase 68 found a refund kept as three records.

Phase 70 is that fault upside down: **one answer to four questions**.

By the end of Phase 69 the words **"Take it back"** appeared on three screens
meaning three different things:

| Screen | "Take it back" meant |
| --- | --- |
| Payables | withdraw a bill's approval — nothing posted, redo it in a minute |
| Payments | void a payment — money comes back onto the books |
| Receivables | confirm undoing a refund — money the other party already had |

and "Undo it" opened the third of those, so the same act had two words on one
screen. Cancelling a document said "Void", and unbanking a deposit said
"Reverse".

This is worse for the person holding the mouse than the usual defect, because
the four operations differ in exactly the way that matters: **what they move.**

## The second half: which corrections must say why

`voidPayment` has insisted on a reason since Phase 52 — *"a void with no reason
is a hole somebody has to reconstruct from dates months later."* That was right,
and for eighteen phases it was the **only** correction that insisted.
`voidDocument`, `voidDeposit`, `withdrawApproval` and Phase 69's own `voidRefund`
all took none. Same reasoning, opposite behaviour, decided by which screen
somebody happened to be on.

## Decision 1: one vocabulary, in one file

`src/modules/corrections/vocabulary.ts` names all five corrections once, each
with the verb its button uses, what the confirmation is headed, what the notice
says afterwards, and the prompt above the reason box. Nothing else in the
application writes those words.

The point is not tidiness. It is that a screen **cannot** accidentally reuse a
verb that already means something else, because the verbs live in one list where
a duplicate is visible — and a test asserts the list has no duplicates.

| Kind | Reach | Verb |
| --- | --- | --- |
| `payment.void` | moved money | Void the payment |
| `refund.void` | moved money | Undo the refund |
| `document.void` | reached somebody | Cancel the document |
| `deposit.void` | internal | Unbank the deposit |
| `approval.withdraw` | internal | Withdraw approval |

## Decision 2: the rule, stated once

> **A correction that moved money, or that reached somebody outside the
> business, must say why. One that only rearranges what is on our own screens
> need not.**

`reach` is its own field rather than a bare `reasonRequired: boolean`, so the
next correction somebody adds has to answer the question that matters instead of
copying a flag from the row above it. `mustSayWhy(kind)` is derived from it.

Requiring a reason for the two internal ones would train people to type "x" into
a box, which is worse than not asking: it produces an audit trail that looks
complete and says nothing. A reason given anyway is still kept.

## Decision 3: the rule lives at the action layer, not in five Zod schemas

Every one of the five server actions now runs `reasonFor({kind, reason})` and
throws a `DomainError` when it refuses — so the refusal reaches the browser
(Phase 12's `messageFor` surfaces only `DomainError`), and the sentence somebody
reads when stopped is the same sentence that asked them in the first place.

`voidSchema.reason` in payables went from required back to `.optional()`: the
schema had been the only place the Phase 52 rule was written, which is why it
never spread. The rule is not a shape, it is a policy.

All four correction schemas take `.nullish()` rather than `.optional()`, because
the shared panel sends a `null` for an empty box rather than dropping the key —
"no reason was given" should arrive as a value the vocabulary can judge, not as
an absence.

## Decision 4: one confirmation panel

`src/components/correction-panel.tsx` is what the five screens open. It reads the
verb, the heading and whether a reason is demanded from the vocabulary, so a
screen cannot ask for less than the action will insist on. The board that owns
the rows owns which one is open — the button sits in a row's action cell and the
panel in a row beneath it, which in a table means two different cells.

"Never mind" closes every one of them. It was "Cancel" on payments, which on a
screen full of things that can be cancelled is a fifth meaning nobody needed.

## Decision 5: withdrawing an approval gets its own audit action

Found by this phase's own test, which asked the audit trail for `bill.approve`
after a withdrawal and got the approval back.

`withdrawApproval` recorded itself under the **same** action name as
`approveBill`, distinguished only by a `withdrawn: true` flag inside the payload.
So "when was this bill approved" could not be answered by asking for
`bill.approve` — you got the withdrawal too, and had to read inside the payload
to tell which one you were holding. That is this phase's defect sitting in the
audit trail, and no amount of vocabulary on the buttons would have found it.

`bill.approval_withdraw` is now its own action, and the flag is gone.

## What this cost

The retheme in the same phase moved the workspace onto the design canvas's
palette: dark chrome over a light workspace, blue for actions on white and the
lime kept for the one place the design shouts. `.btn-primary` became
`bg-action text-action-ink` — lime at button weight on white is unreadable, and a
primary action nobody can read is worse than a less striking one.

## What this did not do

Nothing in the ledger changed. No migration. The five corrections post exactly
what they posted before; what changed is what they are called, what they ask for,
and what the audit trail can be asked.

## What the next phase might take

`voidDocument` is the only one of the five whose refusal path has no test that
crosses the action boundary — the others were exercised by Phase 68's discovery
that twenty-two payables refusals were invisible in the browser. Worth checking
the same way, since it is now the correction most likely to be refused.
