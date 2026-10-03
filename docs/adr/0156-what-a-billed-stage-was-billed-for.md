# 0156 — What a billed stage was billed for

**Status:** accepted
**Date:** 2026-10-03
**Phase:** 156

---

## How this was found

ADR 0155 nominated part-billing a stage and said, in its own words, that it *"is
a real request before it is a defect, so it should wait for somebody to ask."*
Taking that as instruction would have meant building a feature nobody had asked
for, so the alternative was to measure — and the obvious thing to measure was the
code Phase 155 had just shipped.

**Two defects, both introduced by Phase 155, both from one root:** a billed
stage's facts were not recorded as facts.

## Defect 1: a billed stage's amount was still being derived

`stageStates` computed every stage from the proposal's **current** total:

```ts
const priced = scheduleAmounts(proposal.totalCents, rows.map(…))
```

Its own comment argued for that — *"a proposal whose total changed cannot leave a
schedule quietly adding up to something else"* — and that is right for a stage
still to be billed and wrong for one already invoiced, whose amount is a fact.

`loadProposal` carries **no status guard**; the won/lost check lives in
`sendProposal`. So `updateProposalItems` can edit a won proposal and move
`total_cents`:

| step | consequence |
| --- | --- |
| $20,000 contract, stages 25/25/50 | stage 1 billed → invoice for $5,000 |
| items edited, total now $40,000 | stage 1 *reads* $10,000 |
| `billedSoFar` | reports $10,000 against a $5,000 invoice |
| bill the rest | $35,000 invoiced on a $40,000 contract |
| deposit recognition | debits $10,000 from `2500` against a $5,000 credit |

The last row is the serious one: **the unearned revenue liability is driven
negative**, which no report knows how to show. `recogniseDeposit` read the
derived share rather than what had been invoiced.

One figure answering two questions — *what shall I bill* and *what did I bill* —
which is the defect this project keeps naming.

## Defect 2: rewriting the schedule forgot what was billed

`setBillingSchedule` is `delete` then `insert`, with no guard. On a part-billed
contract it:

- deleted the rows holding `invoice_id`
- reinserted them null
- left the invoices in place, orphaned
- let `billStage(0)` **charge the same stage again**

Reachable from the screen Phase 155 added, which offers the Billing schedule
button on any proposal — won and part-billed included. So a double-invoice path,
not a theoretical one.

Worth saying plainly: ADR 0155 made a point of closing the double-billing hole
*between* the two progress-billing paths, and missed this one inside its own.

## The repair

The answer this codebase has already given three times — `PAIRED_COLUMNS`, Phase
153's `bank_face_cents`, Phase 129's *"a posting records the rate it used"*:
**when a stage is billed, write down what it was billed for.**

1. `proposal_schedule_stages.billed_cents`, set with `invoice_id` and null until
   then, with a CHECK for both or neither — a stage with an invoice and no figure
   is the defect; a figure with no invoice is a stage claiming to have been
   billed.
2. `stageStates` returns the stored figure for a billed stage and the derived one
   for an unbilled stage. The choice is made there, once, so no caller has to
   remember which to read.
3. `recogniseDeposit` uses the billed figure, so `2500` is relieved by exactly
   what was credited to it.
4. `scheduleMayBeReplaced` refuses a rewrite that would drop a billed stage, and
   names the stage that was invoiced.

### Why the rewrite is refused and not merged

Keeping the billed stages and replacing only the tail sounds kinder and is
ambiguous: the incoming list carries no ids, so matching it against the stored
rows means matching on label or on position, and both are wrong the moment
somebody renames a stage or inserts one in the middle. A refusal naming the
invoiced stage is a sentence somebody can act on (Phase 119); a merge is a guess
about what they meant. Appending is not special-cased for the same reason — this
cannot tell an append from a rename plus an append.

## The backfill reads the fact off the document

Every stage billed before this migration has an invoice, and that invoice's total
**is** what the stage was billed for: one line, raised by `billStage` for that
stage alone. So the backfill is not a reconstruction from today's figures, which
is Phase 127's rule; it is reading what happened off the record that recorded it.

A stage whose invoice has since been deleted keeps a null `invoice_id` from the
`ON DELETE SET NULL`, so it is skipped — correctly, because it is unbilled again
and its amount is derived once more.

## Both defects were proved before they were fixed

Phase 121's rule, applied deliberately. With the fix reverted:

- the two amount tests fail with `expected 1000000 to be 500000` — the stage
  reporting $10,000 against its $5,000 invoice, and the liability debit following
  it;
- the rewrite test fails with `promise resolved "{ stages: 1 }" instead of
  rejecting` — the schedule replaced over a billed stage.

A test written after a fix that has never been seen to fail is a test that may be
asserting the fix rather than the defect.

## What this does not do

**It does not stop a won proposal being edited.** `loadProposal` still carries no
status guard, and that is left alone deliberately: changing a won contract is a
real thing businesses do, and the damage was never the edit — it was that a
billed figure moved with it. What is still to bill follows the contract, which is
the half the derivation was right about.

**It does not reconcile the two progress-billing paths.** Still exclusive per
contract, as ADR 0155 left it.

**It does not part-bill a stage.** Still waiting for somebody to ask, as ADR 0155
said.

## What is nominated next

**The same question asked of every derived money figure beside a stored one.**
This phase found two places where a figure was recomputed from inputs that can
move after the fact was recorded, and both were in sixty lines of new code. The
registers already cover face-versus-functional (`PAIRED_COLUMNS`) and
posted-versus-current rates (Phase 129), and neither asks the more general
question: *which figures in this codebase are derived from a mutable input after
the event they describe?* That is a scan, and the two instances here are what
would make it worth writing rather than a tidy idea.
