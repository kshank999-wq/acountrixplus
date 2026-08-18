# ADR 0035 — A document is owed in its own currency

- **Status:** Accepted
- **Date:** 2026-08-18
- **Context:** Spec §19 — financial integrity. **Multi-currency is not named anywhere in the
  spec**; this phase is a capability chosen beyond it, and the §19 citation is for the constraints
  it inherits: integer arithmetic on money, complete auditability of the rate an entry used, and
  operations that refuse rather than guess.
- **Builds on:** [ADR 0002](0002-money-as-integer-cents.md),
  [ADR 0026](0026-restriction-is-a-property-of-the-gift.md),
  [ADR 0031](0031-what-is-owed-is-owed-by-somebody.md),
  [ADR 0033](0033-a-check-nobody-runs-is-not-a-check.md)

## Context

A consultancy in Ohio invoices a client in Bremen for €4,000. Every number in
this codebase up to now has been a US cent, and that invoice is not one.

The wrong answer is to store $4,334 and forget the euros. The customer holds a
piece of paper that says €4,000; when they pay it, they pay €4,000, and whether
that arrives as $4,334 or $4,400 depends on a rate nobody controls. A system
that kept only the converted figure can never answer "what do they still owe
me" in the currency the answer has to be given in.

Five claims, asserted in `tests/fx.test.ts` (50 tests):

1. **A document is owed in its own currency**, and the ledger is only ever in
   the company's.
2. **The rate on the day is not the rate on payment day**, and the difference is
   a realised gain or loss — a real one, in a real account.
3. **Nothing converts a converted number.** The home amount is written once and
   never recomputed from a later rate.
4. **A missing rate refuses**, rather than quietly using parity.
5. **What is still owed is exposure**, reported and not posted.

## Decision 1: two amounts on the document, one in the ledger

`invoices` and `bills` each gained four columns: `currency`,
`exchange_rate_millionths`, `functional_total_cents`, `functional_balance_cents`.

The document's own `total_cents` and `balance_cents` stay in the document's
currency. Journal lines are always in the company's. So an invoice knows both
what the customer owes and what the books carry it at, and neither number is
derived from the other at read time.

Rates are **millionths** — 1.083500 is `1_083_500` — for exactly the reason
ADR 0002 gave for cents. A rate is a multiplier on money, and floating point has
no business anywhere near money. Six places is what published feeds carry.

## Decision 2: a rate is a fact with a date and a source

`exchange_rates` stores the pair, the day, the rate, and where it came from,
unique on `(company, base, quote, date)`.

A rate used to post an entry has to still be there in three years when somebody
asks why that entry says what it says. An application that fetched a rate at the
moment of posting and kept only the result can answer *what* but never *from
where* — and "the rate we used" is the one number in a foreign transaction that
nobody outside the business can check.

The lookup walks **backwards only**, to the most recent rate on or before the
date asked for. A rate published after a transaction happened is not what the
transaction happened at, and filling gaps forward would restate the past with
information nobody had.

A second rate for the same day **replaces** the first. Two rows and no rule for
choosing between them is how two entries posted on one morning end up at
different rates.

## Decision 3: a missing rate is a refusal

There is deliberately no fallback to parity. `rateFor` throws, naming the pair
and the day.

Quietly using 1.0 turns a €4,000 invoice into a $4,000 one, and nothing
downstream ever looks wrong enough for anybody to notice. A refusal that names
what it wanted is recoverable in thirty seconds; a silently wrong receivable is
found at the year end, if at all.

## Decision 4: the stored home total *is* what was posted

The first draft computed `functional_total_cents` as `convert(totalCents, rate)`
while the journal posted the sum of the converted lines. Those differ by a cent
whenever the line roundings do not sum to the total rounding — which is often.

That would have manufactured, at the moment of posting, exactly the drift Phase
31's control check exists to detect: a subledger and a ledger that disagree for
no reason anybody could ever reconstruct. So the lines are converted first and
their sum is both what posts and what is stored.

## Decision 5: one account, in other income

`7100 Foreign Exchange Gain or Loss` is one account, not two. A business wants
to know what currency did to its year as a single number; splitting gains from
losses makes somebody add them back together, and a net figure near zero is the
useful signal that a hedging policy is working.

It sits in **other income** rather than operating expenses, because currency
movement is not something the business did. It sold what it sold; the rate moved
underneath. It is installed on first use — the rule Phase 28 set for `6870` and
Phase 34 for `1060` — so a company that never invoices abroad never gets it.

## Decision 6: unrealised movement is reported, never posted

A €4,000 invoice raised at 1.0835 sits in receivables at $4,334. At 1.1000 on
month end it is *worth* $4,400 — but nobody has been paid, and the rate can be
back at 1.07 before they are.

Standards permit posting this, and most large systems do. This one does not, and
the reason is who uses it: a small business whose result is driven by a number
it does not control, has not received, and will restate next month is a small
business whose accountant spends December explaining that the profit is not
real. The exposure is worth *knowing*; booking it is a choice with consequences
somebody should make deliberately rather than discover.

So `/accounting/currencies` shows both halves at once — what has already been
realised and is in the profit and loss, and what is merely exposed and is posted
nowhere. Showing only the second would say currency movement is a reporting
matter, which is the opposite of true for anybody who has been paid.

## Decision 7: four operations refuse rather than approximate

Crediting a foreign invoice, crediting a foreign bill, applying a credit note to
one, and drawing a retainer against one all **stop**, naming the document and
saying what to do instead.

Reducing a foreign balance means posting a home-currency amount to a control
account. For a multi-line credit note that amount is the sum of the converted
lines, not the conversion of the sum — Decision 4's problem again, in a place
where the two answers are equally defensible. A retainer is worse: it is cash
already received in the company's own currency, and drawing it against a euro
invoice is a settlement at *some* rate, and which rate is an accounting decision
with a real effect on reported profit.

A **write-off is not refused**, because it converts exactly: one amount, two
lines, nothing to spread a rounded cent across. The loss is the home amount the
books were carrying, at the rate the invoice was raised at — re-converting at
today's rate would fold a currency movement into a bad debt nobody chose to
recognise.

## The twelfth check

`fx.conversions` compares every open foreign document's stored home amount
against a fresh conversion of its balance at its own rate. Ungated: currency is
not an industry, and a company with no foreign documents agrees trivially, which
is cheaper than a module nobody would switch on.

Tolerance is one cent per open document rather than zero. A part payment takes
an exact remainder out of the carried amount, and that remainder is not always
what re-converting the remaining foreign balance gives. More than a cent apart
is not rounding — it is a home amount its own rate cannot produce.

## The bug this phase's own check caught

The first draft put the "reduce the home balance too" rule inside
`applyToDocument`, the payment path.

A gift card redemption reduces an invoice balance somewhere else entirely, and
so did a credit note, a write-off, a vendor credit, and a retainer draw. Five
paths reduced the face balance and left the home balance untouched — and Phase
31's control check, now summing home amounts, reported $65.00 where $15.00 was
owed.

The check found it before any of it shipped, which is gratifying and is the
whole argument of ADR 0033. The rule now lives in `relieveFunctional`, one pure
function every path calls, and each of the five is a test.

## Consequences

- **Every existing invoice and bill is `USD` at `1_000_000`**, and
  `convert(n, RATE_ONE)` is exactly `n`. No historical figure moves.
- **Phase 31's receivables and payables checks now sum the home balance**, which
  is the only figure a control account can honestly be compared against.
- **A foreign invoice cannot be credited or written down by credit note**, only
  paid or written off. That is a real hole, named rather than approximated.
- **Nothing revalues automatically.** A business that wants unrealised movement
  in its ledger posts the journal entry the exposure report describes.
- **There is no multi-currency bank account.** Money arriving in euros is
  recorded as the home-currency amount that reached the account, so a business
  actually holding a euro balance has no place to hold it.
- **The functional currency is a company field with no way to change it**, which
  is correct — changing the currency a set of books is kept in is a migration,
  not a setting.
- **`createBill` with `taxCents > 0` posts an unbalanced entry** (debits are the
  subtotal, credits the total). Pre-existing and unreachable — no caller passes
  it — and choosing recoverable against non-recoverable input tax is an
  accounting decision outside this phase.

## Follow-up

1. **Credit notes and vendor credits in a foreign currency**, once the
   line-rounding policy is decided and written down.
2. **A rate feed**, filling `exchange_rates` on a schedule through the Phase 10
   worker. The table was shaped for it; nothing reads a feed yet.
3. **Multi-currency bank accounts**, and the translation of a held foreign
   balance at each period end.
4. **Optional posting of unrealised movement**, as a setting, for the businesses
   whose accountants want it.
5. **Currency on the invoice PDF and the statement**, which today print the
   document's own figures without naming which currency they are.
