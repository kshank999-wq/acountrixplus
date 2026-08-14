# ADR 0011 — The same books, read two ways

- **Status:** Accepted
- **Date:** 2026-08-14
- **Context:** Spec §13 (cash and accrual reporting modes; recurring, adjusting, and closing entries; credits, statements, write-offs), §22 (definition of done)
- **Builds on:** [ADR 0002](0002-double-entry-ledger.md), [ADR 0009](0009-payroll-the-entry-not-the-tax.md), [ADR 0010](0010-at-least-once-and-who-decides.md)

## Context

ADR 0002 deferred cash-basis reporting explicitly, and named the reason:

> Doing cash basis correctly means looking through payment applications to the
> revenue and expense accounts on the documents they settle, which the
> `payment_applications` table was designed to make possible. It is deliberate
> scope left for Phase 2b rather than an approximation shipped as if it were
> the real thing.

Nothing about the difficulty changed. What changed is Phase 9: the tax
workpapers were built for accountants preparing small-business returns, and
most small businesses file on a cash basis. An accrual-only workpaper pack is
half a tool for exactly the people it was for.

Alongside it, the rest of §13's receivables list — credits, statements,
write-offs — and the two entry kinds §13 named and Phase 10 finally made
possible: recurring entries, and the year-end close.

## Decision 1: cash basis is a transformation of the ledger, not a second ledger

The tempting shortcut is to report the bank accounts' movements. It is wrong in
a way that looks right: every receipt lands on one line, so a cash-basis P&L
shows a single "customer receipts" figure instead of revenue split across the
accounts the invoices were raised against. Nobody can file from that.

The real thing is two edits to the accrual ledger:

```
  accrual                          cash
  ────────────────────────────     ────────────────────────────
  Invoice:  Dr AR      1080        (nothing — no document entry)
            Cr Revenue 1000
            Cr Tax        80

  Payment:  Dr Bank    1080        Dr Bank    1080
            Cr AR      1080        Cr Revenue 1000
                                   Cr Tax        80
```

1. **Remove every line of every invoice and bill entry** — the whole entry, so
   the receivable it created goes with it.
2. **Replace each payment's receivable/payable leg** with the settled document's
   other legs, scaled to how much of it this payment covered.

Everything else is untouched, and that is the quiet half of the design: a
categorized bank transaction, a payroll run, a manual entry, a remittance — all
of them already hit an expense and the bank in one entry. They are cash basis
already.

The seam is one function, `balancesForBasis`, so every report takes a basis and
needs no other change. A parallel set of cash-basis report functions would have
drifted from the accrual ones the first time either was fixed.

### The correctness argument, and where it first failed

Removing a whole entry preserves balance trivially. The replacement does too:
scale the document's non-control legs so they net to exactly what the payment's
control leg removed, and the two cancel.

**The first implementation got this wrong twice, and both are worth recording
because both looked right.**

- **Retainage was treated as a control account.** It reads like a receivable
  under another name, so removing it seemed obviously correct. But a
  retainage-release invoice has *only* control legs — `Dr Receivable`,
  `Cr Retainage Receivable` — so there was nothing left to recognize against,
  and the payment's leg was removed with nothing put back. The books stopped
  balancing on exactly one kind of company.
- **The shares were pro-rated on unsigned amounts.** That works only when a
  document's legs are all on one side. A progress billing splits its debit
  across Receivables and Retainage Receivable while crediting the full contract
  revenue, so magnitudes give shares of the right size and the wrong direction.

Both are fixed by scaling **signed** cents (`scaleSigned`) against the control
legs' net, which is balanced for any document shape rather than for the shapes
that happened to be tested. `tests/cash-basis.test.ts` now includes a
construction company with retainage for exactly this reason.

A third case was found in the browser rather than by a test: a **write-off**
posts `Dr Bad Debt / Cr Receivables` and is not an invoice, so its credit
survived and put a negative receivable on a statement that has no receivables.
The accounting answer is cleaner than the plumbing one: on a cash basis a bad
debt is a **non-event**, because the revenue was never taken into account —
which is also why a cash-basis taxpayer cannot deduct one. Write-offs are
removed entirely, and a recovery is treated as what it is, money arriving
against an invoice, so it flows through the same machinery as any payment.

### Caveats are computed, not printed

Every real cash-basis report carries caveats, and the difference between a
usable one and a misleading one is whether they are on it. `cashBasisCaveats`
derives them from the company's own data — payroll timing, unapplied payments,
sales tax — so a company with no payroll is not warned about payroll.

## Decision 2: a credit note and a write-off are opposite things

Both reduce what a customer owes without money arriving, which is why software
conflates them constantly.

| | Credit note | Write-off |
| --- | --- | --- |
| What happened | The company agreed they owe less | They owe it and will not pay |
| Revenue | Reversed — never earned | Kept — earned, then lost |
| Other side | Revenue | Bad Debt expense |
| P&L effect | Revenue down | Expense up |

A company that writes bad debt off as a credit note reports lower revenue and
no bad debt. Its margin looks unchanged and the fact that a customer stopped
paying appears nowhere. So they are two operations, neither reachable through
the other, and the UI puts them side by side with their consequences stated
rather than offering one "reduce balance" button.

Three smaller decisions follow:

- **`written_off` is its own document status**, not `paid`. Nobody paid, and a
  status saying they did erases the fact from every report that reads it.
- **Applying a credit posts no entry.** The credit note already moved the
  receivable; applying it decides *which invoice* the reduction belongs to. A
  second entry would halve the receivable twice.
- **A recovery reverses the expense rather than recognizing revenue.** The
  revenue was recognized when the invoice was raised and never taken back;
  recognizing it again would count the sale twice.

## Decision 3: what may happen unattended

Recurring entries and the year-end close are both about the ledger changing
without anybody typing, and they answer the question differently.

A **recurring entry** answers it once, when the template is written. `autoPost`
decides whether an occurrence posts or waits as a draft — Phase 10's
distinction, applied here. A monthly rent accrual is the same number every
month and safe to post; an estimate is not, and a template that posts one
unattended fills the ledger with figures nobody checked. The default is draft,
because the safe default is the one where a mistake is caught by a person.

Catch-up runs **fully in one pass**, bounded at 400 occurrences. One occurrence
per call meant a template eight months behind took eight daily worker runs to
arrive, posting January's rent in August — found in the seed output, not by a
test, and the test that now covers it asserts the occurrence *dates* rather
than just the total.

A **close** refuses to be automated at all. It refuses on a blocker with no
override, unlike Phase 9's filing where somebody might have a good reason to
prepare from imperfect figures: closing a year twice has exactly one outcome,
it is wrong, and no reason makes it right.

**Closing does not lock the period.** Locking stops entries being written;
closing writes one more — the last of the year. Conflating them would mean a
correction to last year required unlocking something unrelated to the lock.

## Consequences

- **Retainage under cash basis is approximate.** A progress billing's payment
  recognizes the contract revenue and the retainage receivable in proportion,
  which balances and is defensible, but a purist would say cash basis has no
  retainage receivable either. Doing better needs the release chained back to
  the original billing, and the honest label for now is "approximate".
- **Cash basis reads the whole ledger for the window.** No aggregate pushdown —
  a company with years of history and a wide date range will feel it. The
  accrual path still aggregates in SQL, so only the cash basis pays this.
- **The trial balance has no basis.** It is a statement about the journal, and
  the journal is kept on one basis. Offering a switch there would imply a choice
  that does not exist.
- **Credit notes are AR-only.** Spec §13 lists vendor credits too; a supplier
  credit note is the mirror image and is not built.
- **A statement is stored, not sent.** `sent_at` and `sent_to` exist and nothing
  populates them — emailing one needs the marketing module's provider, which is
  a wiring job rather than a design question.
- **Statements are not rendered through the document engine.** They are a table
  on a page, so they do not carry the company's brand the way a proposal does.
  The engine exists and this is a template away.
- **Recurring entries have fixed amounts.** No formulas, no percentage-of-account
  templates. A rent accrual is fixed; a depreciation estimate that should move
  with a balance has to be edited.
- **Closing does not roll forward opening balances.** Retained Earnings is
  updated by the entry, which is what makes the next year correct, but there is
  no separate "opening balance" concept to reconcile against.
- **A closed year is not protected from new entries.** Post into a closed year
  and the close's figures become stale — the entry lands, and nothing warns.
  Period locking is the existing control for that and the two are deliberately
  separate, but the combination is a foot-gun worth naming.

## Follow-up

1. **Warn when an entry is posted into a closed year.** Not a block — the
   locking control already exists for that — but the close froze figures that
   are now wrong, and nothing says so.
2. **Render statements through the document engine**, so a statement looks like
   the rest of what a client receives.
3. **Vendor credit notes**, the mirror of what was built here.
4. **Push the cash-basis transformation into SQL** if the read cost ever
   matters. The shape is a lateral join over payment applications; the reason
   it is in code today is that getting it *right* was the hard part, and the
   two attempts it took are the argument for keeping it legible first.
