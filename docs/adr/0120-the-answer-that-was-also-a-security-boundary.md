# 0120 — The answer that was also a security boundary

**Status:** accepted
**Date:** 2026-09-04
**Phase:** 120

---

## How this was found

ADR 0119 left two nominations. Both were verified before anything was written,
and one turned out worse than the ADR claimed.

**The tripwire only reads `src/modules`.** Measured across `src/app`: **17 bare
`throw new Error(...)`, and all 17 carry a person-facing sentence.** Sixteen are
in `src/app/actions/*.ts` — the very files that call `messageFor`. So Phase 119
fixed one directory and left the identical defect one directory over:

```
That was already closed by somebody else.   → "Something went wrong."
That tenancy has already ended.             → "Something went wrong."
Say what date these balances are as at.     → "Something went wrong."
You do not work at that firm.               → "Something went wrong."
```

**The 90 that stayed bare are mostly one family.** 74 of them are `X not found`
— the largest single family in the codebase. ADR 0119 called rewording them "a
different phase". That was right, but for the wrong reason.

## "Not found" is answering two questions at once

Measured across the 74: **49 sit directly after a `scoped()` query.** `scoped`
adds `company_id = ctx.companyId`, so an id belonging to another company returns
no row and falls into exactly the same branch as an id that never existed. The
message is therefore doing two jobs:

1. telling somebody their link is stale, and
2. **refusing to confirm that a record exists in another company's books.**

The second is a real security property. A message that distinguished the cases
would turn any id into an oracle for *"does this invoice exist somewhere in this
system"*. And the codebase already depends on it — this is a tenant-isolation
test, and its subject is the wording:

```ts
// tests/mobile.test.ts
await expect(revokeDevice(fixture.ctx, theirPhone.id)).rejects.toThrow(/not found/i)
```

So the wording is load-bearing, and until this phase **nothing anywhere said
so**. The obvious improvement — *"that device belongs to Kestrel Joinery"* — is
a cross-tenant disclosure, it reads like a kindness, and no rule, test or
comment would have stopped anybody writing it.

That is the defect. Not the wording: the fact that a security decision was
being carried by an unremarked string, in 49 places, with no way to notice.

## What this does

`src/modules/errors/missing.ts` declares the record kinds a lookup can fail to
find. Each one records **whether its lookup is tenant-scoped**, because that is
the fact that makes the wording load-bearing, so it is data rather than folklore.
`kindFor` throws on an undeclared key, on the Phase 101 device: a new record type
has to say what to call it before a lookup for it can fail politely.

`missing(kind)` produces one sentence, shaped to be true of all three causes and
silent about which:

```
That invoice is not on these books. It may have been removed since this page
was opened — reload and try again.
```

- **it never existed** — true, and reloading is the right advice
- **it was removed since the page was drawn** — true, and named as the likely case
- **it belongs to another company** — true, and not hinted at

It says where the reader is and what to do, which is everything they can act on,
and nothing about which case it was, which is everything they must not learn.

## The rule made testable

`DISCLOSING_WORDS` names the four phrases that would answer the withheld
question, each carrying its argument rather than merely being listed:

| Phrase | Why it is forbidden |
|---|---|
| `another company` | Naming the other side confirms the record exists |
| `belongs to` | Ownership language is still a yes, even unnamed |
| `permission` | A different answer with a different meaning: real, and you may not |
| `deleted` | A definite past tense claims to know which of the three it was |

`tests/missing-record.test.ts` holds **every declared kind** against all four, in
both singular and plural. One test compares a tenant-scoped kind's sentence
against an open one's with the noun elided, because if the two shapes differed,
**the difference would itself be the oracle**.

## The dry run caught a bug the compiler could not

The conversion was scripted. Run first against a copy of the tree, it produced:

```ts
if (!customer) missing('customer')
```

The regex started at `throw new Error(` and the replacement emitted only
`missing(...)` — **dropping the `throw`**. That constructs a `Refusal`, discards
it, and carries on with `customer` undefined. It is a valid expression statement,
so `tsc --noEmit` is clean and every type is satisfied; the failure would have
been a null dereference somewhere downstream, in 74 places.

A scripted edit is only as good as the pass that reads its output. The copy of
the tree cost a minute and was the only thing between that and the repository.

## The tripwire caught its own author

`missing.ts` was committed a step ahead of the conversion, and the 118+119 full
suite failed on exactly one test:

```
FAIL tests/refusal-audience.test.ts > leaves no person-facing sentence thrown as a bare Error
```

`kindFor`'s registry throw — *"No record kind is declared for X. A lookup has to
say what it was looking for before it can tell somebody it failed."* — reads as
prose, because it is prose, and it is addressed to whoever adds a record type
without declaring its noun. It needed an `ALLOWED_BARE_REFUSALS` entry like the
two ledger registries before it. Phase 119's rule caught the phase that came
after it, on its first run, in a file written by the person who wrote the rule.

## Verified in the browser

`/bookkeeping`, signed in to Ridgeline Construction, accepting a suggestion —
with the transaction id in the server action's body rewritten to an id that is
on nobody's books, which is what a stale link, a deleted record and another
company's id all look like from the server's side:

```
rewrote: c1675a59-8c81-4f94-9090-297ad4218d73
SCREEN SAYS: That transaction is not on these books. It may have been removed
             since this page was opened — reload and try again.
disclosing words: none
```

Before this phase, the same click produced "Something went wrong."

## What this does not do

**It does not make the tripwire read anything but `src/modules` and `src/app`.**
`src/lib` and `src/worker` are not scanned. Neither currently throws a
person-facing bare `Error`, but nothing keeps that true.

**It does not change what `scoped()` does.** The tenancy boundary is exactly
where it was; this phase only writes down what its silence means and stops the
silence from being reworded away.

**It does not settle the 16 throws left bare in `src/modules`.** They are the
operator-facing remainder — configuration, registries, invariants — and the
fourteen with an explicit argument in `ALLOWED_BARE_REFUSALS` are unchanged.

**A `missing()` sentence still cannot say what a person most wants to know**,
which is *which* record. Naming the invoice number would be safe for a stale
link and a disclosure for a cross-tenant id, and telling those apart is exactly
what this refuses to do. The reader gets the noun and nothing else, on purpose.
