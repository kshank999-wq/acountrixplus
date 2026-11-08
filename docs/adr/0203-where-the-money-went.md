# 0203 — Where the money went

**Status:** accepted
**Date:** 2026-11-08
**Phase:** 203

---

## The nomination, and the half of it that was missing

ADR 0202 nominated `gift_cards.isActive` out of six switches nothing could
turn off, on the grounds that it was one of the three *enforced* ones —
`redeemGiftCard` refuses an inactive card by name, *"Gift card X is no longer
valid"* — and the only one where the thing nobody could switch off is **money**.

That held. What measuring added is that the nomination was the second half of a
screen with no first half: **there was no list of gift cards anywhere.**

`giftCardPosition` returned four totals. `sellGiftCard` wrote a row. Between
them, nothing showed a card's code, its balance, or who bought it — the only
place a card's own figures appeared was the §19 portability export. A business
could not answer *"what is on GC-1004?"* except by attempting a redemption
against a completed appointment and reading the refusal.

So a void control had nothing to point at, and the phase is the list and the
stop together.

## The claim: a card that cannot be spent and a balance still owed cannot both be true

A card holds a liability on account 2590, and `giftCardPosition` reconciles the
sum of card balances against the ledger balance of that account — two
separately computed things, which is what makes it a reconciliation rather than
a restatement.

That leaves exactly three dishonest ways to build this and one honest one:

| | |
| --- | --- |
| flip the flag, leave the balance | 2590 keeps a liability nobody can ever settle. The reconciliation goes on agreeing and the balance sheet is wrong. |
| zero the balance, post nothing | the subledger moves and the ledger does not, so the check cries wolf — on books a person deliberately changed. |
| zero both, choose the account silently | somebody's money lands in income because a default said so. |

The honest one is to **refuse**. `closeGiftCard` will not stop a card with
anything left on it unless the caller says where the balance went, and the
sentence it throws is the feature rather than an error path:

> There is 50.00 left on GC-1001. Say where it goes — refunded to the customer,
> or written off to income — because a card that cannot be spent and a balance
> the business still owes cannot both be true.

A card with nothing left on it needs no disposition and posts nothing. There is
no money to place, and stopping a spent code is housekeeping.

### Refund, and the column that was waiting for it

```
  Dr Gift Cards Outstanding    what was left
      Cr wherever it goes out                what was left
```

The default destination is the card's own `depositAccountId` — *"where the
money went when it was sold"*, in the schema's words. **That column was written
by `sellGiftCard` and read by nothing**, which is Phase 49's shape mirrored:
a writer with no reader. Giving the money back to the account it was taken into
is both the obvious answer and the one the column was recorded for.

### Write-off, and ADR 0029

ADR 0029 refuses breakage: *"Recognising the revenue on an unused card requires
a judgement about how many never come back, and a wrong judgement books revenue
that has to be given back."*

That is an argument against an **estimate across many cards**, and it still
holds — nothing here sweeps, ages or expires anything. A write-off is one card
a person decided about, by name, with the account named and the decision in the
audit trail.

The default is `8100 Other Income` rather than `4700 Service Revenue`, because
no service was given. And the account is **refused unless it is income**: a
balance released from 2590 onto another balance-sheet account is a liability
that disappeared with nothing to show for it, which is the one outcome a
write-off must not be able to produce by accident.

### A lost card is reprinted, not destroyed

The common thing that happens to a gift card is that somebody loses it, and
what the business wants is the old number dead and the customer's money intact.
That is **one card with a new number on it**, not a card destroyed and another
sold — which would post a sale that never happened and inflate what the
business took.

So `reissueGiftCard` updates `code` and touches nothing else. No journal: 2590
owes exactly what it owed, the subledger did not move either, and the
redemptions already filed against the card keep pointing at it because they
reference its id. The card stays **active**, because a reissue is not a disposal
and leaves nothing to decide about the money.

`code` was written at insert and never updated — one of the 770 columns Phase
202 measured as insert-only and could not report, since the scan counts a
column written at insert as written. It is one of the few in that class that
genuinely was not immutable, and the only way to tell is still to read.

## What this phase learned about its own method

**The mirror census cannot be built from the same predicate.** Phases 201–202
ask *which columns does something read that nothing writes*, and
`depositAccountId` is the opposite — so it was invisible to them and was found
by reading. The obvious next move is to invert the scan, and it does not work:

`writerCandidates` uses *"named outside the schema"* as the test for **read**,
where it is an **inclusion** criterion. Missing a read loses a candidate, so the
scan under-reports and never invents. Inverted, the same predicate becomes an
**exclusion** criterion, and a single `.select()` with no projection reads every
column of a table while naming none. `recentRequests` in `ai/settings.ts` is one
of those, so every column of `ai_requests` looks unread.

Measured, the mirror reports **683 columns**. That is the size of the error, not
a finding, and it is recorded so a later phase does not ship it as one.

## What moved

`COLUMN_WRITERS` lost its `gift_cards` entry, because the scan no longer
reports the column — the two-direction rule working for the second phase
running. The pinned census: **35 → 34 candidates**, and the insert-only
limitation **770 → 769**, both corrected in Phases 201's and 202's own test
files rather than relaxed.

The audit action union gained `'giftcard.reissue'` and `'giftcard.close'`, and
**`'giftcard.sell'`** — selling was the only one of the four movements of 2590
missing from the log while redeeming had been in it since Phase 29. An
asymmetry rather than a decision.

The board's own prose said *"nothing legitimately moves 2590 except selling and
spending a card, and both do it in the same transaction as the balance"*. True
when written and false the moment a refund and a write-off existed. It names
all four now, and a test asserts the four names in the file that makes the
claim — the cheapest available substitute for pinning a sentence with no figure
in it.

The isolation census: **296 writes and 960 reads**.

## What this does not do

**It does not expire a card, age one, or estimate breakage.** ADR 0029 stands.
Every release of a balance here is one card, named, by a person, to an account
they chose.

**It does not reverse a close.** A refund or a write-off is a posted journal
entry, and undoing one is a reversing entry — which the ledger already supports
and which should go through `journal.reverse` rather than through a gift-card
screen that quietly un-writes an entry. `reissueGiftCard` refuses a closed card
for the same reason: it would put a balance back without the entry that taking
one away needed.

**It does not show a customer their cards.** `purchaserCustomerId` is written by
`sellGiftCard` and read by this list's left join and the portability export —
so the card knows the customer and the customer's own screen still does not
know the card.

**It does not touch the other four switches.** Two are enforced
(`cash_drawers.isActive`, `practices.isActive`) and two are projections only
(`clauses.isActive`, `bills_of_materials.isActive`), each declared in
`COLUMN_WRITERS` with which kind it is, because a writer for a projection-only
flag would be a control with no effect.

## Nominated for Phase 204

**`cash_drawers.isActive` and `practices.isActive` — the two remaining enforced
switches.**

They are this phase's shape with the money taken out, which is the argument for
doing them together and quickly rather than one each: `openShift` already
refuses an inactive till and four queries already filter an inactive practice
out of a client's search for a firm, so in both cases the whole gap is the
writer and the refusal is written.

The one thing each has to decide rather than inherit. A till with an **open
shift** cannot be retired without saying what happens to the float in it, which
is this phase's refusal again in a smaller form. And a practice is a
platform-level row with people on it: deactivating one must say what happens to
the engagements it holds, because ending those is what removes its staff's
memberships — and a practice that disappears while its engagements stay active
is an outside firm with access and no visible owner.

Behind that: the two projection-only switches, each two changes rather than one;
`vendors.organizationId` and the kind of field it needs; the four joins from an
unscoped primary (ADR 0198); and §11's six remaining functions.
