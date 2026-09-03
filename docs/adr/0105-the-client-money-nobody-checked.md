# 0105 — The client money nobody checked

**Status:** accepted
**Date:** Phase 105
**Amends:** ADR 0033 (the integrity register), ADR 0015 (retainers), and ADR
0104, one of whose claims was not true of the code it described.

## The defect

The integrity register checks every other kind of money the company holds for
somebody else:

| check | compares |
| --- | --- |
| `appointments.gift_cards` | Σ card balances against **2590** |
| `properties.deposits` | Σ deposit movements against **2580** |
| `receivables.customer_credit` | Σ unapplied receipts against **2520** |
| `appointments.payouts` | Σ delivered visits against **2320** |

There is no check for **retainers**. `grep -i retainer src/modules/integrity/`
returns nothing.

A retainer is a client's money, taken before the work is done, sitting in the
firm's bank account. It is the same shape of obligation as a gift card and a
tenant deposit and, in most jurisdictions where professionals take money on
account, the one with the strictest rules about being able to show it.

The register's own words on the sibling checks make the omission awkward.
`properties.deposits`:

> A landlord who cannot show that the deposits they hold match the liability on
> their balance sheet has a problem no report will fix, and in most places a
> legal one.

And `receivables.customer_credit`, which is the one that stings:

> Added with the account rather than after it, because Phase 48 found a clearing
> account with no check on it and $28,700 in it that nothing in the application
> could clear. **Once is enough to learn that.**

That lesson was written down in Phase 53. Retainers were built in Phase 15 with
their own liability account and never got one, so the codebase is carrying a
counterexample to its own stated rule.

## Decision 1: the account is usually shared, and that changes the check

`retainerAccount` resolves `2550 Client Retainers Held`, **or `2500 Unearned
Revenue` where the pack did not install it.** That fallback is not a rare edge
case. Of the seven companies in the development database, **one has 2550 and six
do not** — so for most companies, retainers land in an account that also holds
every other kind of deferred revenue.

A naive "Σ retainers equals the account" check would therefore be wrong six
times out of seven the moment a company had any other unearned revenue, and a
check that cries wolf is a check people turn off. So the check asks which
account it got and makes a different claim about each:

- **Dedicated (`2550`):** nothing else posts there, so the two must be *equal*.
  A difference means one half of a paired write happened without the other.
- **Shared (`2500`):** equality cannot be claimed. What can be claimed, and is,
  is that **the retainers do not exceed the account** — because unearned revenue
  cannot legitimately be negative, so client money exceeding all deferred revenue
  means the ledger half is missing.

Both are `fault`. The weaker claim is still one that nothing legitimate can
break, which is the line this register draws between a fault and a position.

## Decision 2: a weakened check says so, out loud

A check that quietly downgrades what it asserts is worse than one that is
absent, because the screen shows a tick either way and the reader has no way to
know which question was answered.

So the finding names the account it compared against and, in the shared case,
says in as many words that it could only check the weaker thing and that
installing `2550` would let it check the stronger one. That turns a limitation
into an instruction — the same move `banking.shared_ledger_accounts` makes when
it reports that two bank accounts point at one ledger account and that the
cash tie-out is therefore looser than it looks.

## Decision 3: the comparison is in the company's own money

A retainer carries the currency the money arrived in (Phase 66) and a
`functional_remaining_cents` that has been maintained since. The ledger is in
the company's own currency. So the check sums `functional_remaining_cents`, not
`remaining_cents` — summing the second across a firm holding both euros and
dollars would produce the number Phase 65 was named for eliminating, this time
inside a check whose whole purpose is to notice when numbers disagree.

## Decision 4: ADR 0104 claimed a test it did not have

ADR 0104 said, of the export manifest:

> That makes the manifest figure the one that should tie to the liability
> account in `journal.csv` … and a test asserts exactly that correspondence
> rather than trusting it.

The test asserts the manifest ties to **the table the manifest was computed
from**, which is nearly a tautology and says nothing about the ledger. The
sentence is corrected there, and the claim it made is what this phase actually
builds — in the integrity register, which is where ADR 0104 itself said
reconciliation belongs.

## What this does not do

**It does not install `2550` for the six companies that lack it.** Adding an
account to a live chart is a decision about somebody's books, and the check now
says plainly that installing it buys a stronger guarantee. Making that change on
their behalf during a nightly job is not this register's business — it reports,
it does not post.

**It does not check credit notes against a ledger account.** A credit note's
remaining balance reduces receivables rather than sitting in a liability
account of its own, so the corresponding assertion is about `1100` and is
already partly covered by `ledger.receivables`. Whether that check should also
account for open credits is a real question and a different one.
