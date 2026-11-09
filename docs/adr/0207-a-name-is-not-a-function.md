# 0207 — A name is not a function

**Status:** accepted
**Date:** 2026-11-09
**Phase:** 207

---

## The nomination counted nine, and there were four

ADR 0206 nominated *"`listFinancialAccounts`' nine flagless callers, read one
at a time"*, with a good argument: a financial account is a **bank account**,
and offering a retired one on a payment, a deposit or a reconciliation is
offering to move money through something the business has closed.
`listAccounts` was the chart; this is the cash.

**There are two exported functions with that name.**

| | |
| --- | --- |
| `banking/sync.ts` | no option, **always** filters on `isActive`. Its docstring said it was *"for inbox filters and account pickers"*. Five screens import it. |
| `banking/accounts.ts` | `activeOnly` **opt-in**, and a different return shape. Four callers, one of them internal. |

Five of the nine were calling the always-filtering one and had been correct all
along. The count was wrong because it was taken **by name**, and a name is not
a function.

That is Phases 196–198's own lesson, turned on a grep. Those phases recorded
that *a scan recognises a query by a name, and every name it uses is a place
something can hide* — and the conclusion generalises further than the scan it
was written about. A name is a claim about what code does, and this codebase
had the same claim attached to two different bodies.

The sync one is `pickableFinancialAccounts` now. `pickable` is the whole claim:
every one of its callers is a picker or an inbox filter, what they must not
offer is an account the business has closed, and the name says so where it is
read rather than where it is defined.

## The one live defect of the four real callers

`accounting/payments` fed the **refund** picker with every account the company
had ever had. A refund could be paid out of a bank account the business had
closed. Fixed.

The other three were already right, which is worth stating rather than passing
over: `settings/payments` filtered `isActive` in the page (correct, and now
redundant — the filter is gone, because a screen filtering what the query
already filtered is two answers waiting to disagree), `settings/accounts` is
the management screen, and `cashTieOut` is internal.

## Flipping the default, and the two things that would have broken

`activeOnly` opt-in is the unsafe default and Phase 206 flipped the same shape
on `listServiceItems`. Doing it here was only safe because the callers were
read **first**, and two of them would have broken:

- **`cashTieOut`** ties each account's feed balance to the ledger. A retired
  account that still carries a balance still has to tie out, so excluding them
  would have turned a disagreement into silence — the opposite of what the
  function is for. It passes `includeRetired: true`.
- **`settings/accounts`** splits open from closed and carries the **Reopen**
  control. Defaulting it to live accounts would have made a closed account
  vanish from the one screen that can bring it back: **Phase 206's own defect,
  reintroduced by Phase 207's flip.**

A third thing broke and was caught by a test rather than by reading. The
existing `financial-accounts` test had two calls, one asking for live accounts
and one for all of them; a blanket rewrite of the old flag name made both of
them mean the same thing, so the assertion *"still there, and still findable"*
was testing the line above it. Asking for everything is explicit now, which is
the half of a default flip that has to be said out loud.

## What this does not do

**It does not merge the two functions.** They return different shapes — the
sync one joins `chart_accounts` for a display name — and merging them is a
change to five screens' props. Renaming makes the difference visible, which is
what was wrong; making it unnecessary is a separate question.

**It does not flip the remaining four opt-in defaults.** `listEmployees`,
`listTaxCodes`, `listCostCodes` and `subcontractorSummaries`. Each needs its
callers read to tell an **offer** from a **list**, and this phase is the second
in a row to demonstrate that guessing which is which produces a wrong number.

**It does not flip `listAccounts`.** Phase 206 fixed its four pickers at the
call sites instead, because two of its callers legitimately need the whole
chart — a name lookup for a posting on a retired account, and the §19 export.
The flip was never measured there, and after this phase that is a reason to
leave it rather than a reason to hurry.

## What moved

Nothing in any census: a rename and a flag add no queries and no columns. The
isolation count stands at **299 writes and 967 reads**, and the column census
at 30 candidates with one declared finding.

What moved is a count in an ADR, from nine to four, and the reason it was
wrong.

## Nominated for Phase 208

**`vendors.organizationId` — the supplier who is also a client.**

It is the **last declared finding** in `COLUMN_WRITERS`, and after five phases
of closing switches and defaults it is the one thing the column census still
reports as a column nothing can write. `engagement/filing.ts` spends a page on
the firm that both buys from you and sells to you — one shared inbox, a
remittance that must not land on their debt to us — and `outbound.ts` reads
this column so a supplier letter also reaches that client's CRM timeline. The
customer side is written by `crm/conversion.ts` when an opportunity is won.
There is no path at all for a supplier.

The reason it has been declared four times rather than built is real and is the
thing to decide: the vendor correction screen is driven by `VENDOR_FIELDS`, a
registry of **text fields** with a three-way `kind` that says what changing one
means. A link to a CRM record is a new *kind* of field, and `diffParty` would
render it as a uuid in the audit trail unless the registry learns that some
fields are references whose *name* is what a person reads.

Behind that: the four remaining opt-in defaults; the four joins from an
unscoped primary (ADR 0198); and §11's six remaining functions.
