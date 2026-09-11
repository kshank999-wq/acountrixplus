# 0139 — The register of what is built and not wired

**Status:** accepted
**Date:** 2026-09-11
**Phase:** 139

---

## How this was found

Two things, and the second is the phase.

**The nomination did not need building.** ADRs 0136, 0137 and 0138 each named
`recoverWriteOff` as still open — three consecutive, which by Phase 31 and 33's
rule usually means it *is* the phase. Verifying it before taking it found that
**no new core is needed**: `recoverHeld` already answers exactly its question —
what arrives at the day's rate against what leaves at the carried one — and
`refundVendorCredit` is the working precedent. Three ADRs nominated it as though
something had to be built, and the piece was already there, uncalled.

**And the staging decision had a cost nobody was carrying.** The cores are now
being put in place first and hooked up in a later pass. That is a reasonable way
to stage the work, and it collides with this project's own Phase 49 rule:

> A function with no caller is a feature that does not exist.

A staged core and a forgotten one are indistinguishable. The only record that
`spends` was waiting for `applyDeposit` was prose in three files that nothing
checked — and prose nothing checks is precisely what Phase 135 found rotting in
`BANK_POSTINGS`, where **a false sentence is exactly as long as a true one**.

## What it is

A registry-with-prose (Phase 101's device) of work that is **known to be
outstanding and known to be wrong today**, and a scan that holds it to the source
in both directions:

- an entry whose target **already calls** the core is stale and must be removed
  — a backlog still listing finished work makes its remaining entries
  untrustworthy too;
- an entry with **nothing blocking it** must name the test that says it is done,
  because "wire it up" with no acceptance is a task nobody can finish.

Three entries, six targets, all measured rather than declared:

| core | target | blocked by | acceptance |
| --- | --- | --- | --- |
| `spends` | `applyDeposit` | nothing | `deposit-against-foreign-invoice` |
| `recoverHeld` | `recoverWriteOff` | nothing | `recovery-at-two-rates` |
| `mayPostToBank` | `recordRemittance`, `receivePledge`, `receiveDeposit`, `refundDeposit` | **a field** | none, argued |

Each entry carries a `liveDefect` — what is wrong in the code **today**, in a
sentence somebody can go and check — so that reading the register is reading a
list of faults rather than a list of plans.

## What it is deliberately not

**Not a list of every unwired export.** Measured: **1,349 exported functions in
`src/modules`, 293 with no caller elsewhere in `src/`.** Almost all of those are
registry lookups — `bankPostingFor`, `carrierFor`, `falsifierFor`,
`ledgerPostingFor` — and devices a test drives on purpose, which is exactly what
Phase 101's design intends. A scan that called those dead would be wrong about
nearly three hundred things.

That is why this is a declaration with prose rather than a count. The naive
version of this phase would have produced a number, and the number would have
been noise.

## The argued exception

The fourth entry names no acceptance test, and the registry permits it because
`blockedBy` is `'a field'`.

`mayPostToBank` has taken a `moneyCurrency` since Phase 136, and
`recordRemittance`, `receivePledge`, `receiveDeposit` and `refundDeposit` have
nothing to pass it. ADR 0136 called giving them one "a real change to a real
screen" and declined; that is still right — a column, a form field and a
migration come first.

**A test written against a column that does not exist would be fiction**, not a
definition of done. So `null` is the honest answer there and a failure anywhere
else.

## Why the acceptance tests are skipped, not red

A red suite nobody can fix teaches people to ignore the suite — which is exactly
what ADR 0137 said about `ledger.receivables` reporting a `fault` with no
document behind it. **A staged plan must not do to the tests what that defect did
to the nightly check.**

So both named tests are `describe.skip`, each with a banner saying it is the
acceptance test for the wiring pass, and the register asserts that: an entry
whose test is neither skipped nor labelled fails here.

## What this does not do

**It does not fix anything.** Every entry describes a defect that is still live:
`applyDeposit` still compares a euro face amount to a dollar holding,
`recoverWriteOff` still strands $41.25 on a €2,500 recovery, and four paths still
refuse a foreign bank account outright.

**It does not decide when the wiring happens.** It makes the backlog
enumerable and keeps it honest; the order is somebody's choice, not the
registry's.

**It does not cover work nobody has started.** An entry requires a core that
exists, so this is a register of *staged* work — not a roadmap.
