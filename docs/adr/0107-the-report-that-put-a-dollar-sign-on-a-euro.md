# 0107 — The report that put a dollar sign on a euro

**Status:** accepted
**Date:** 2026-09-03
**Phase:** 107

---

## The defect

`arAging` selected `invoices.balance_cents` — the amount in the currency the
**customer** was invoiced in — and added those into buckets and a total.
`apAging` did the same over bills. The reports page rendered every cell through
`formatCents(...)` with no currency argument, which defaults to USD.

Phase 61 found exactly this in the statement, and named this report while
fixing that one:

> A customer invoiced €4,000 and $1,200 was told they owed **$5,200.00**: a
> number in no currency at all, with a dollar sign on it. **The aging buckets
> added the same way**, and Phase 54's net-position sentence restated the same
> figure.

It fixed the statement's buckets and left the standalone report. Measured on the
development books rather than reasoned about — Bremen Hafenbau GmbH is invoiced
€2,500.00, worth $2,708.75:

```
AR aging total       : 4979194     ← 250000 of it a euro figure in a dollar column
AR control subledger : 4940069
Bremen's aging row   : 250000      ← rendered as "$2,500.00"
```

Nineteen other modules read `functional_balance_cents` for precisely this
reason — the statement, the chase, the control-account check, the customers
screen, the export. `reports.ts` was the one that did not.

## Decision 1: aging takes the opposite answer to a statement, from the same argument

Phase 61 concluded that **a statement states a balance per currency**. That is
right for a statement: it is addressed to one customer and asks them to pay, so
the only honest figure is the one in the currency they were invoiced in.

An aging report is the other kind of document. It is internal, it spans every
customer, and it answers one question — *how much of what we are owed is going
bad* — which has an answer in exactly one currency: **the company's own**. Split
per currency it could not be summed, sorted, or compared against the balance
sheet, which is most of what it is for.

So aging takes the functional figure. The two opposite conclusions come from one
rule: *a total only means something when its terms are in one currency*, and
which currency depends on **who is being asked to act**.

## Decision 2: the row says what the other party was actually invoiced

Fixing the arithmetic alone would set a new trap. Once Bremen's row reads
`$2,708.75`, somebody can read that off the report and ring Bremen asking for
$2,708.75 — a figure Bremen has never seen and does not owe.

So a row whose documents were not all in the home currency carries them, and
`foreignNote` renders *"Invoiced €2,500.00"* beside the name. Empty for the
overwhelming majority of rows, where nothing about the report changes.

## Decision 3: unapplied credits sit beside the total, not in the buckets

ADR 0106 left this open and called closing it a separate question:

> Whether the aging report should show a "credits not yet applied" line beneath
> its total is a real question, and a different one.

They are **not** aged and **not** netted into the buckets — Phase 54 settled
that an unapplied credit has no age, because nobody has yet decided which
invoice it belongs to. But a credit note reduces the control account the moment
it is issued, so without saying anything the aging total and the balance sheet
differ by an amount neither report mentions.

The report therefore states `controlAccountCents` — what the balance sheet
should read, given this report — and a sentence explaining the difference. That
turns Phase 106's prose caveat into a figure on a page, and into a test:
`aging.controlAccountCents === receivables.subledgerCents`.

## Decision 4: the sentence agrees with itself, and I got this wrong first

Browser verification of the first draft produced:

> 1 credit note worth $600.00 has been issued and not yet applied to an invoice.
> **They already reduce** the control account … which invoice **each** belongs to.

Six things in that passage have to agree on the count — the noun, three verbs, a
pronoun, and "each" — and the first version pluralised two of them. This is
Phase 105's *"1 retainer hold"* in a longer sentence, written by the same hand
that fixed it two phases ago and left a comment in Phase 106 warning about it.

The fix is not more ternaries: interleaving them through one string is what makes
the drift possible. `creditNote` now branches **once**, on the count, and returns
two whole sentences. The test asserts every one of the six agreements, including
that the singular form contains neither `They` nor `each`.

## What this does not do

**It does not net credits into the buckets.** Stated as a decision above, not an
omission. Phase 54's argument stands.

**It does not touch `apAging`'s vendor-credit reconciliation differently from
`arAging`'s.** Both read the same `credit_notes` table by `party`, so a supplier
credit reduces the payables line the same way — verified, not assumed.

**It does not revisit `asOf` on the credits.** `unappliedCredits` filters on
`issue_date <= asOfDate`, which matches how the documents are filtered, but reads
the credit's *present* `remaining_cents` — the same present-tense caveat
`receivables-check.ts` has documented since Phase 31. A credit issued in March
and applied in June shows as unapplied on neither report today, and on both if
you ask about April. Reconstructing historical remaining balances means replaying
every application, which is a bigger machine than either report justifies.

**It does not check that the two reports agree.** The relationship is now
asserted in a test and stated on the page, but the nightly register has no
`ledger.aging_ties` check. Whether it should is a fair question: the equation is
arithmetic over figures both reports already derive from the same rows, so a
check would mostly be testing this phase's own subtraction.
