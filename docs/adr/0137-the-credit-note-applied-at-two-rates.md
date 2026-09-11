# 0137 — The credit note applied at two rates

**Status:** accepted
**Date:** 2026-09-11
**Phase:** 137

---

## How this was found

ADR 0136 nominated `recoverWriteOff` — it has the money's currency and posts its
bank line at the write-off's carried rate, so it needs a day rate and a realised
line before it can be told what currency the money is in.

Verifying that nomination before adopting it found something worse in the way,
which is what happened to Phase 114 as well and is becoming the reliable shape of
a phase.

ADR 0136 said `recoverWriteOff` was **the only** path relieving a carried balance
that never reaches `ensureFxAccount`. Measured across every caller of
`relieveFunctional`, `recoveryFunctional`, `settleHeld` and `recoverHeld` —
**eleven functions, and six have no realised line.** That is the fourth
consecutive ADR whose "only one" claim was wrong, and the habit now has a name:
a count asserted from memory is not a measurement.

Most of the six are right to have none. Two are not.

## The defect

Applying a credit note reduces **two** balances carried at **two** rates for one
face amount, and posts nothing. The argument for posting nothing is written above
the function:

> "No journal entry is posted here: the credit note's own entry already moved the
> receivable, and this is an allocation between the two."

**True of the face amounts and false of the functional ones.** Measured, on a
€1,000 invoice raised at 1.10 and a €1,000 credit note issued at 1.0835:

```
INVOICE  face 100000 functional 110000 rate 1100000
NOTE     face 100000 functional 108350 rate 1083500
BEFORE  subledger 1650 ledger 1650 agrees true
AFTER   subledger    0 ledger 1650 agrees false
STRANDED 1650
```

€1,000 invoiced, €1,000 credited, the customer owes nothing — and **$16.50 stays
in Accounts Receivable permanently.**

The part that makes it worse than a wrong number: `ledger.receivables` is a
`fault`, and it catches this. So a business running foreign credit notes is told
every night that its books are broken, and **cannot clear it** — the invoice is
settled, the note is spent, and there is no document left to point at. A check
that fires correctly on a defect nothing can fix is worse than one that stays
quiet, because it teaches people to ignore the checks.

## This is Phase 114's defect, where its fix did not reach

ADR 0114 — "The credit spent at a rate it was never carried at" — found exactly
this and repaired it. Its comment is still in `customer-credit.ts`:

> "Two balances are being moved and they are carried at **two different rates**
> … `settleHeld` is the rule Phase 68 wrote for exactly this, and `refundCredit`
> a few hundred lines below has used it since — while this function converted
> both sides at the invoice's rate and posted no difference at all."

It fixed the path that spends a **held payment**. The two that spend a **credit
note** — `applyCreditWithin` on an invoice, `applyVendorCreditWithin` on a bill —
were never looked at.

Part of why is worth recording: **there are two functions called `applyCredit`**,
in two modules, doing two different things. Phase 114 repaired one of them. A
search for the name finds the repaired one first, and it looks done.

The rates need not be different currencies to differ. A euro invoice in June and
a euro credit note in July are one currency at two rates, which is the ordinary
case and not the exotic one.

## What `meets` decides, and what it does not

It does **not** compute the gap twice. `relieveFunctional` on each document
already produced the figure that document gives up, and `meets` takes the
difference between the two — never a fresh conversion of the face amount at some
third rate, which would be Phase 116's `fx.conversions` defect all over again.

What it decides is **where the difference goes**, and that is a genuinely
different question from the one Phase 114 faced. There, held money and the
receivable are two different accounts, so the entry has a side to land on. Here
**both documents sit in the same control account**, so the difference is between
that control account and the exchange account.

And which way round is not symmetric:

| | invoice / receivable | bill / payable |
| --- | --- | --- |
| document worth more than the credit | **loss**, credit AR | **gain**, debit AP |
| credit worth more than the document | gain, debit AR | loss, credit AP |

The same rate movement that loses money on something owed to us **makes** money
on something we owe, because the debt got cheaper before it was settled. So
`meets` is told which control account it is in rather than assuming, and both
directions have a test.

## What the old comment was right about

Posting the *amount* again would halve the receivable twice, and that refusal
stays. Only the difference is posted, the entry is two lines, and it is dated the
day the credit was applied rather than the day either document was raised —
Phase 113's rule, which is what keeps a July application out of a closed March.

`source` is `adjusting`, not `payment`: no money moved. This is the books
agreeing with themselves about what two documents were worth.

## The registry caught the new sites before the tests did

`LEDGER_POSTINGS` failed the moment the entries were written, naming all seven
new `debitCents` / `creditCents` expressions and refusing to let them post
without a declared `basis`. That is Phase 127's device doing exactly what it was
built for, on a phase that had nothing to do with it.

Two measured counts moved with it: **112 posting sites in 37 functions → 120 in
39.** Four sites apiece rather than two, because each line is written on both a
debit and a credit branch.

## What this does not do

**It does not give `recoverWriteOff` its day rate.** ADR 0136's nomination stands
and is still the next obvious thing: it has `writeOff.currency`, its bank line is
struck at the write-off's carried rate, and $41.25 on a €2,500 recovery has
nowhere to be named.

**It does not touch the other four without a realised line.** `writeOffInvoice`
moves one carried figure to bad debt and has no second rate; `redeemGiftCard` and
`reduceDocumentBalance` likewise. They were measured, not assumed, and they are
right as they are.

**It does not add a check that two control accounts agree after an application.**
`ledger.receivables` and `ledger.payables` already do, nightly, and they were
right the whole time — they were the thing reporting the defect. What was missing
was not a check but an entry.
