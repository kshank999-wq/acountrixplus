# 0118 — The chart nobody could add to

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 118

---

## How this was found

ADR 0117 nominated two pieces of work. Before adopting either, the usual pass:
run a contradiction probe across the seeded books, and if nothing is wrong,
measure something else.

Nothing was wrong. All seven demo companies reconcile, every check in the
register comes back clean, and the constraints Phase 116 added have held. So the
measurement moved to **reachability** — Phase 49's defect class, which ADR 0049
stated as:

> `applyVendorCredit` had existed since Phase 12 with no caller anywhere in
> `src/app`, so a vendor credit with anything left on it was stranded for ever.

A function with no caller is a feature that does not exist. Counting every
occurrence of each write in `src/modules/coa/service.ts` across `src/` and
`tests/`, minus its own definition:

```
installChartOfAccounts   12 uses
listAccounts             31 uses
accountByNumber          40 uses
createAccount             0 uses
```

Zero. `createAccount` was written in **Phase 1**, doc-commented

> Creates a custom account (spec §5 allows full customization).

and in the 117 phases since, nothing has called it — not a server action, not a
route, not a test.

## What was actually missing

Not one function. **There was no chart-of-accounts screen at all.**

The chart is read as a dropdown in fourteen places — the journal, the
bookkeeping inbox, budgets, dimensions, cost codes, the drawer, the takings
import, the mobile sync route — and managed in none. `/settings/accounts`, which
sounds like the place, is the **bank** accounts screen from Phase 40.

So a business using this product could not:

- see the accounts its own balance sheet and P&L are built from,
- add one,
- retire one it had stopped using,
- or find out what an unfamiliar number on a report meant.

Spec §5 says the chart is fully customisable. It was fully installed and then
frozen.

## And `createAccount` validated nothing

Reading it before wiring it up: it took a number and a name and inserted them.
No shape, no uniqueness, no relationship between the number and the type. Two
consequences, both reachable the moment a screen existed:

- A duplicate number reached the unique index, and `messageFor`'s deny-by-default
  (ADR 0074) correctly refused to show a Postgres error to a person — so the
  screen would have said "Something went wrong" for the most ordinary mistake
  there is.
- An expense could be numbered `1050` and sit among the assets on every report
  that is sorted by number, which is all of them.

**A refusal beats a check** (ADR 0117), and a refusal that arrives after the
screen is a migration. So the refusals arrive *with* the screen.

## The bands are this project's own

`src/modules/coa/proposal.ts` declares one band per account type. They were not
copied from a textbook — they were **measured from the chart this application
installs**, and a test asserts that every standard account and every industry
pack account still falls inside its own band, so the screen can never refuse a
number the software itself uses:

| Type | Band | Measured range in the installed chart |
|---|---|---|
| asset | 1000–1999 | 1000–1510 |
| liability | 2000–2999 | 2000–2590 |
| equity | 3000–3999 | 3000–3900 |
| revenue | 4000–4999 | 4000–4990 |
| cost of sales | 5000–5999 | 5000–5450 |
| expense | 6000–6999 | 6000–6950 |
| other income | 7000–8999 | 7100–8200 |
| other expense | 9000–9999 | 9000–9200 |

Each band carries prose arguing for itself — the registry-with-prose device from
Phase 101 — and `rangeFor` **throws** on a type nobody declared a home for, so
adding a ninth account type has to answer where in the chart it belongs before an
account of it can be numbered.

Every refusal quotes that prose rather than only reporting a violation:

```
1042 is outside 6000–6999, where expenses live. The overheads: rent,
insurance, software, wages that are not on a job. An account whose number
contradicts its type is a trap for whoever inherits the books.
```

## Retiring, not deleting

`setAccountRetired` flips `is_active`, which `listAccounts({ activeOnly: true })`
and `categorizableAccounts` already read — so a retired account leaves every
picker while the reports that walk the ledger keep reporting it. Two rules:

- **A retired account keeps its number.** `taken` is every number, active or
  not: the journal entries behind it still point there, and reusing the number
  would file two different accounts' history under one heading.
- **A system account cannot be retired.** The application looks those up by
  number and posts into them without asking, so retiring one would hide an
  account that is still in use from every screen offering a choice. The same
  numbers are refused to a *new* account for the mirror-image reason.

## The browser found a defect the tests could not

Thirty-three tests passed. The first browser pass then showed this for all four
refusals:

```
add 1042 expense: Something went wrong.
add 621 expense:  Something went wrong.
add 1100 asset:   Something went wrong.
add 6100 expense: Something went wrong.
```

`ChartError extends Error`. `messageFor` denies by default — anything that is
not a `DomainError` is logged and replaced with the caller's fallback. So the
four sentences this phase exists to write were being discarded one layer above
the screen, and no test could see it, because every test calls the service
directly and asserts on the thrown message.

`ChartError extends DomainError` now. This is the same failure as the feature
itself: something correct that nothing reached.

## What this does not do

**It does not let an account be renamed or renumbered.** Renaming is safe and
obvious; renumbering is not, because every report is sorted by number and
somebody's saved view is not. Both were left out rather than half-answered.

**It does not offer a parent account.** `chart_accounts.parent_id` exists and
`createAccount` accepts it, but nothing in this system reads it — no report
rolls up by parent — so a picker for it would be a field that does nothing.
That is the Phase 49 defect from the other end, and it is worth its own phase.

**It does not stop an account being retired while it still has a balance.** The
screen shows the balance and the posting count beside every row so the decision
is informed, but a business that stops using an account mid-year has a real
balance in it and a real reason to take it out of the pickers. Refusing would
be wrong; the number is there so nobody does it by accident.

**298 deliberate refusals in `src/modules` still throw plain `Error`.** Sixty
classes extend `DomainError`; the rest are bare throws, each carrying a sentence
someone wrote for a person, each replaced with a fallback before it reaches one.
Phase 117's own `receiveStock` refusal is among them. That is measured, not
fixed, and it is the nomination for the next phase.
