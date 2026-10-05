# 0157 — The row a pledge receipt needed

**Status:** accepted
**Date:** 2026-10-03
**Phase:** 157

---

## How this was found, and the nomination that did not survive

ADR 0156 nominated *"the same question asked of every derived money figure beside
a stored one"* — a scan for figures recomputed from a mutable input after the
event they describe — on the grounds that Phase 156 had found two in sixty lines
of new code.

Measured across every stored ratio in the schema, asking whether the row that
records an event also stores the figure its ratio produced:

| row | ratio | product stored beside it |
| --- | --- | --- |
| `appointments` | `commission_bp` | `practitioner_cents` ✓ |
| `progress_billing_lines` | `percent_complete_bp` | all four figures ✓ |
| `document_tax_lines` | `rate_bp` | `taxable_cents`, `tax_cents` ✓ |
| `fixed_assets` | `declining_factor_bp` | `cost_cents` ✓ |
| `repair_orders` | `tolerance_bp` | `authorised_cents` ✓ |
| `proposal_schedule_stages` | `percent_bp` | `billed_cents` — Phase 156 |

The population is **one**, and it was already fixed. `progress_billing_lines` is
stricter than Phase 156's repair — it copies the *base* onto the line too, so
editing a schedule of values cannot move a filed application.

A scan for a rule nothing violates is Phase 121's *"a check only ever seen to
agree is not a check"*, which this project has refused before. So the nomination
is recorded as checked and withdrawn rather than quietly replaced, and the phase
went to the oldest live defect on a register instead.

## What this closes

`PENDING_WIRING` carried `mayPostToBank` from Phase 139 and was down to one
target. Phase 153 cleared three of its four by adding columns and said in those
words why this one could not go with them:

> A pledge is received in instalments — `received_cents` accumulates and the
> function refuses more than is outstanding — so each receipt has its own day and
> its own rate, and there is no row for a receipt to carry them on. Phase 129's
> rule is that a posting records the rate it used; a single
> `exchange_rate_millionths` on `contributions` would be right for the first
> instalment and quietly wrong for the second.

That is why `a row` was argued as a blocker distinct from `a field` rather than
bending the nearest (Phase 130). Four phases later, this is the row.

The live defect: `receivePledge` refused a foreign bank account outright, so a
fund banking in euros had to record a donor's receipt against a home-currency
account the money did not go into, or not record it at all.

## The third origin, found by wiring a declaration nobody had acted on

`BANK_MONEY_SITES` declared this site `already-carried`, arguing the receivable
was *"relieved at what it has been carried at"* while the bank took what arrived
— which implies a difference between the two.

**`contributions` has no currency column.** A pledge's `amount_cents` is the
books' own money, so a €600 receipt worth $660 relieves $660 of a dollar
receivable, exactly. There is no second rate to differ from.

So `origin` conflated two questions. It asked *does the balance pre-exist?*;
what decides whether a difference arises is *does the balance carry its own
rate?*

```
site               pre-exists   carries a rate   difference
receiveDeposit     no           —                impossible
refundDeposit      yes          yes              realised
recordRemittance   yes          yes              realised
receivePledge      yes          NO               none
```

Three cases, two values. `carried-in-home-money` is the third, argued rather than
bent, and `bankMoneyStands` requires that such a site does **not** reach
`ensureFxAccount` — the same measurable half as `created-here`, for a different
reason.

Worth stating plainly: passing `already-carried` with `carriedCents` set to the
converted figure would have produced **the right numbers by accident**. That is
exactly the coincidence a registry exists to stop somebody relying on, and it is
the second time a Phase 153 declaration written for an unwired site has turned
out wrong when somebody wired it — the first being the three `refuses-foreign`
grounds that phase had to move itself.

## No backfill, as a statement

`contributions.received_cents` holds what has arrived on existing pledges and is
a sum with no instalments behind it: nobody recorded which days or amounts made
it up. Inventing one receipt for the whole would assert a date and a rate that
nothing recorded, which is Phase 127's rule.

So `received_cents` stays the running total it has always been and the receipts
explain it from here on. The retention entry says the same thing from the other
end: sweeping these rows would leave that total with nothing behind it, which is
precisely the state this migration declined to create.

## Two registers emptied, and the opposite call on each

**`PENDING_WIRING` is empty**, for the first time since Phase 139 built it with
seven entries over eleven targets. They left one at a time — five in the wiring
pass, three in Phase 153, this one here — each with a sentence saying what was in
the way. The register is kept: `wiringStateFor` still refuses a stale entry, a
missing core and an unblocked entry with no acceptance test, and the situation it
was built for is how this project works. `pending-wiring.test.ts` asserts the
emptiness and holds every rule against a fixture written in the test, so the
rules are still checked on a day when nothing is outstanding.

**`BANK_POSTINGS` has no `refuses` left.** Phase 133 found ten paths posting into
a bank account's ledger account without asking what currency the money was in.
Twenty-four phases later every one of them asks.

That leaves two values with no users, and they get **opposite** treatment,
because what matters is which way a value points:

- **Kept:** `Withheld` and the `refuses-foreign` ground. Both *indict* or argue
  from a refusal — "this path has the currency and still may not pass it", "this
  figure is the books' money because the path declines". The gate still refuses a
  euro payment into a dollar account, and the next core built before the field it
  needs should find the vocabulary already there. An empty indictment is a form
  ready for use.
- **Removed, in Phase 153:** the `converts-here` ground. That one *excused* a
  site, and an unused excuse is a label waiting to be misapplied.

The rule this settles, which Phase 147 stated too broadly: a declared value with
no users should be deleted when it excuses and kept when it accuses.

## What this does not do

**It does not give a pledge its own currency.** `contributions.amount_cents` is
still the books' money, and that is the model: a charity promising £50,000
promises £50,000, and what arrives in euros is weighed against it. A pledge
denominated in a foreign currency would be a different thing, with a carried rate
and a realised difference on each receipt — that is `already-carried`, and it is
a feature request rather than a defect.

**It does not reconstruct history.** Above.

**It does not add a screen.** `receivePledge` is reached from the funds module's
existing contribution form, which now passes a currency when the account is
foreign. No new surface.

## What is nominated next

**Spec §19's row-level security**, which has been declared outstanding since
Phases 149 and 150 and is the last thing on the spec audit that is a stated
requirement rather than a feature. Those phases measured tenant isolation on both
sides — 110 writes and 878 reads, every one guarded — and said in both ADRs that
RLS is a *second* layer and a migration, not a substitute for the first.

It is the only remaining item with a spec section behind it, now that
`PENDING_WIRING` is empty and the money registers hold nothing known-wrong.

> **Corrected by Phase 164.** This ADR also listed "§9 geography analytics" as
> outstanding, and ADR 0158 repeated it. It was false: `breakdownBy` has taken a
> `'region'` dimension, joined from `organizations.region`, for longer than
> either claim. The mistake was grepping the specification's vocabulary —
> nothing matches `geograph` because the code says `region`. See
> `docs/SPEC-AUDIT.md`.
