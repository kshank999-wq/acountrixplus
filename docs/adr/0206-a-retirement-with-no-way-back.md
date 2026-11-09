# 0206 — A retirement with no way back

**Status:** accepted
**Date:** 2026-11-09
**Phase:** 206

---

## The nomination was wrong twice, and measuring it found two real things

ADR 0205 nominated `listServiceItems`' `activeOnly` — the last of this
module's three list functions with the **unsafe default**, where a caller who
forgets the flag offers retired items. It asked *which screens are offering
retired items today*, and it gave two reasons the answer might matter.

Both reasons measured false:

- **No screen was offering retired items.** All three screens that offer items
  passed the flag, and the Studio deliberately did not because it is the
  library. The trap was real; the live defect was not there.
- **Retiring an item with stock hides nothing.** `stockOnHand` filters on
  `isInventoried` and **not** on `isActive`, so a retired item keeps its lots,
  its value and its line in the reconciliation. That is the right answer rather
  than a lucky one — stopping something being *sold* is a different act from
  writing off what is left of it, which is Phase 203's distinction and it
  already held here.

ADR 0205 also gave a reason for *declining* to flip the default: *"a behaviour
change in five screens dressed as a tidy-up"*. Four callers, and no behaviour
change — since every offer-site already passed the flag, flipping the sense
leaves each asking for what it asked for before. So Phase 206 does it, and the
measurement is what licensed it.

Two real findings came out of looking.

## One: a writer in one direction

`deactivateServiceItem` has existed since **Phase 4** and set `isActive` to
false only. Nothing anywhere set it true, so an item retired by mistake — or a
service a business started offering again — was gone from every picker for
ever. It wrote no audit event either, which made it the only one of the
Studio's four libraries whose retirement left no trace: brand kits, clauses and
team members all record both directions.

**This is a third shape, and no census asks about it.** Phases 201–205 measured
columns with a reader and no writer. Phase 203 measured the mirror — columns
written and never read — and declined it, because `.select()` with no projection
makes that scan unsound. A column with a writer that only ever moves one way is
read *and* written, so it is invisible to both, and it looks identical to a
working control until somebody wants to undo it.

`setServiceItemActive` takes the direction from the caller and audits it.
`deactivateServiceItem` stays as the name four phases of callers use — a call
through rather than a second implementation, because the one thing the old
signature cannot express is putting an item back.

## Two: four pickers offering retired chart accounts

Asking the nomination's question of the right denominator found that
`listServiceItems` was **one of seven** list functions with the `activeOnly`
opt-in default, not the last one. And the chart of accounts had four callers
feeding a `<select>` with no flag at all:

| | |
| --- | --- |
| `drawers` | *"Where it lands"* on a till pay-out |
| `takings` | the account a day's takings are categorised into |
| `budgets` | the account a plan is set against |
| `billing` | the account a recurring invoice line earns into |

A retired chart account offered for a **posting** is worse than a retired
service item offered on a line. And `account.retire`'s own docstring has said
since Phase 118 that retiring *"takes it out of every picker"*. **It did not,
for four of them, for eighty-eight phases** — and the reason is in the same
sentence: the flag is opt-in, so the claim was about what callers remember
rather than about what the function does.

The four are fixed. The docstring keeps its sentence with the correction
attached rather than being quietly reworded, on Phase 185's rule: a claim that
was wrong that long is worth more as a record than as tidy prose.

### Not a filter everywhere

Two callers of `listAccounts` correctly take the whole chart, and filtering
either would be the opposite defect:

- `dimensions` builds a **name lookup**, so a posting on a retired account
  still reads with its name.
- the §19 portability export must carry the whole chart.

The difference is **offering against displaying**, which is the same
distinction Phase 205 drew between a picker and a library, one level out.

### How it was found

A blanket assertion in this phase's own test — *"nothing still passes the old
flag name"* — went red on `listFinancialAccounts(actor, { activeOnly: true })`
on the invoices page. A different function with the same unsafe default, caught
by an over-broad check.

That is worth recording rather than tidying away. The assertion was wrong and
the thing it found was right, which is the second time in this run of phases
that an imprecise check has been more useful than the precise one it replaced.

## What this does not do

**It does not flip the other six defaults.** `listAccounts`,
`listFinancialAccounts`, `listEmployees`, `listTaxCodes`, `listCostCodes` and
`subcontractorSummaries` all still take `activeOnly` opt-in. Each one's
flagless callers have to be read to tell an **offer** from a **list**, and
there are nine for `listFinancialAccounts` alone. Declared with the count and
nominated rather than guessed at.

**It does not refuse retiring an item with stock on it.** Measured as harmless
above, and the business reason stands: a shop that stops selling something
still owns what is in the stockroom.

**It does not touch the pickers for the five functions it did not measure.**
Only `listAccounts`' were read, because that is the one a blanket search
pointed at.

## What moved

The isolation census: **299 writes and 967 reads**, and the *split* moved
without the total — `deactivateServiceItem` had been writing through a
hand-rolled `and(eq(id), eq(companyId))` since Phase 4, and going through the
new function put it on `scoped()`. One write crossed from `explicit-company` to
`scoped-write`. Both are guarded; what changed is which word says so.

Two audit actions: `service_item.retire` and `service_item.restore`. The column
census did not move — this phase's defects are not about columns, which is the
point of the first finding.

## Nominated for Phase 207

**`listFinancialAccounts`' nine flagless callers, read one at a time.**

It is the sharpest of the five remaining opt-in defaults, because a financial
account is a **bank account**: offering a retired one on a payment, a deposit
or a reconciliation is offering to move money through something the business
has closed. `listAccounts` was the chart and this is the cash.

Nine callers, and the work is reading each to tell an offer from a list —
`settings/accounts` is plainly the management screen and must keep them all,
and `reconcile`, `payments`, `funds`, `bookkeeping`, `properties` and
`settings/payments` each need a look. The count is the deliverable as much as
the fixes: *"takes it out of every picker"* is the claim that was false here
twice now, and it should be measured rather than asserted a third time.

Behind that: the other four opt-in defaults; `vendors.organizationId`; the
four joins from an unscoped primary (ADR 0198); and §11's six remaining
functions.
