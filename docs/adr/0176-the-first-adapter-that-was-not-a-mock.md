# 0176 — The first adapter that was not a mock

**Status:** accepted
**Date:** 2026-10-07
**Phase:** 176

---

## The nomination, which was not inherited

Phase 164's rule is that *a nomination inherited is a nomination unmeasured*,
and the six phases since have spent most of their measurement correcting the one
they were handed. This one was not handed down: it came from the person who owns
the books, asking to *"start using it for my company… having it import and
reconcile directly from my bank."*

So there was nothing to falsify in a previous ADR. There was something to
falsify in this repository's own prose, and it failed:

> **There is no bank aggregator adapter.** `BankProvider` is a four-method
> interface with exactly one implementation — `MockBankProvider`.
>
> — `docs/RUNBOOK-FIRST-COMPANY.md`, written one commit ago

That was true. The deployment readiness register said the same thing, and the
spec says what it should have been:

> Secure bank and credit-card connection through an aggregation provider; use a
> provider abstraction layer so Plaid or another vendor can be replaced without
> rewriting the bookkeeping domain.
>
> — §3

The abstraction has existed since **Phase 2**. The comment on it has said
*"swapping Plaid for another aggregator means writing one new adapter"* for 174
phases, and nothing had ever tested that sentence by writing one.

## The seam held, which is the finding worth leading with

It is the claim the whole interface exists to make, so it is worth stating
precisely what was and was not touched.

**Not touched at all:** `importTransactions`, the dedup unique index,
`rules-engine`, the inbox, `createFinancialAccounts`, `numbering.ts`,
reconciliation, the ledger. A real aggregator's payload reached the inbox through
code written for a mock, unchanged.

**Touched:** `provider.ts` gained a field and a type, `registry.ts` builds
adapters differently, `sync.ts` encrypts one column. Three files, and each change
is about *carrying a credential* — which is the thing the mock could not have
asked for, because a mock has no secret.

That is a good result for an abstraction nobody had exercised. It is not a free
pass, and the rest of this document is what the exercise found.

## What a mock cannot tell you

### 1. There was nowhere to put the credential

The one that mattered. Plaid's flow is:

```
/link/token/create          -> link_token      short-lived, for the widget
(the widget)                -> public_token    short-lived, one use
/item/public_token/exchange -> access_token    durable, and the real secret
                               item_id
```

Every later call carries the `access_token`. `ExchangeResult` returned
`{ providerItemId, institutionName }`, and `bank_connections` stored
`provider_item_id`, `sync_cursor`, `institution_name` and `status`. **The durable
secret had nowhere to go even in memory**, let alone at rest.

Invisible for 174 phases for a reason that is not an oversight: the mock
genuinely needs no credential, so no test could have failed. A gap that only
appears when a second implementation exists is the gap an abstraction with one
implementation is *built* to hide.

Migration `0095` adds `credential_cipher`, nullable, holding
`modules/auth/secret-box` output — the same envelope as a TOTP seed, because §19
asks for encryption at rest and this is the most sensitive single value this
application will ever hold. Nullable rather than defaulting to `''`, because "needs
no credential" and "has an empty one" are different states and the adapter that
needs one has to tell them apart. `PlaidBankProvider` refuses the first with a
sentence naming the remedy rather than calling Plaid with `access_token: ""` and
relaying whatever Plaid says about a malformed request.

The credential travels as a `ProviderConnection` and not as a second positional
argument, which is Phase 116's device: a caller cannot pass the id of one
connection and the credential of another if the two cannot travel apart.

### 2. A registry of instances is a registry that requires every adapter to need no configuration

`registry.ts` held `registerProvider(new MockBankProvider())` and read the key
off the instance. `PlaidBankProvider`'s constructor **throws** without its
secrets — deliberately, on the mail adapters' argument that a deployment which
names a provider and has not configured it should fail where somebody is looking.

Those two facts are incompatible. Constructed at module load, that refusal fires
on *import*, in every deployment with no Plaid credentials — which is every
deployment today, and all 4,200 tests. Importing the bookkeeping module would
have thrown because of an adapter nobody selected.

So registration stores a factory and `getBankProvider` builds only what was
asked for. The consequence is better than the status quo rather than merely
equal to it: a configuration refusal now surfaces at **selection**, which is
where an operator can act on it.

### 3. The sign inversion produced a negative zero

Plaid reports **money leaving the account as positive**. This codebase's
convention is the opposite. So every amount is negated, and that line is the
highest-consequence statement in the adapter: get it wrong and every transaction
imports backwards and the first balance sheet is a mirror of the truth.

It is asserted in both directions, because a test that only checked a purchase
passes with the inversion backwards if the fixture is backwards too. That test
failed on its third assertion — `-Math.round(0 * 100)` is `-0`, so a
zero-amount transaction mapped to a negative zero. A $0 pre-authorisation is not
an invented edge case; a petrol pump and a hotel check-in both do it.

Nothing was *currently* wrong: `-0 === 0` and it serialises as `"0"`. It is
normalised anyway, on this project's own rule that **two answers to one question
is the defect** — `Object.is`, `toBe` and `Math.sign` all tell them apart, so
leaving both in circulation leaves some check downstream that is right by luck.

Worth recording as the argument for Phase 121: a check only ever seen to agree is
not a check. Asserting the sign twice is what turned a restatement into a test,
and the second direction is not even what caught it — the third assertion was,
and it existed only because the first two had made the test worth finishing.

### 4. `FetchOptions` promises date bounds that `/transactions/sync` cannot honour

`FetchOptions` offers *"inclusive ISO date bounds for a full (non-incremental)
pull"*, and the mock honours them. Plaid's sync endpoint is cursor-based and has
no date parameters at all; the date-ranged endpoint returns no cursor, so
honouring the bounds would mean giving up incremental sync.

This adapter ignores them, which is a silently ignored argument — the shape this
codebase keeps calling the dangerous one. **No caller passes either field
today**, so nothing is wrong, which is exactly when it is cheap to write down.
It is in the adapter's docstring and in an assertion, so the gap is a fact in a
test rather than a sentence in a comment.

### 5. `TransactionPage` has nowhere to say "retracted"

`/transactions/sync` returns `added`, `modified` **and `removed`**. The first two
become transactions carrying their own immutable ids, which is what
`ProviderTransaction` asks for. `removed` has nowhere to go: a transaction Plaid
retracts — a disputed authorisation that never posted — stays in the inbox.

Returning it as a transaction would be worse. It is read and dropped, visibly, in
a type that names it, so a reader can see it was read.

### 6. The deployment register argued from a fact that stopped being a fact

`DEPLOY_CHECKS`'s `bank-provider` entry opened with *"there is no real aggregator
adapter in this codebase, only the mock"*. True when Stage A wrote it one commit
earlier; false the moment one was written. Phase 110's defect, in the one
register whose entire job is to be read by somebody pointing a production
database at this repository.

Reworded, and the severity deliberately **not** changed: an adapter nobody
selected and an adapter that does not exist degrade a deployment identically.

A new entry, `plaid-credentials`, is a `silent-failure` — and the severity is the
finding rather than the entry. `bank.sync_all` catches a per-institution error
and returns it in the job result so one dead institution cannot stop the others,
which is right. It also means a deployment with `BANK_PROVIDER=plaid` and no
secrets runs a job that **succeeds**, every five minutes, importing nothing, with
the reason in a row nobody reads. A *manual* sync does surface the error, so what
fails quietly is the feed somebody stopped watching precisely because it was
automatic. It fires only when Plaid is the selected provider, because an entry
that scolded every CSV-only deployment would be noise in the register whose four
real entries depend on not being skimmed.

### 7. Stage A left the suite red and reported it green

The one finding in this document that is not about the adapter.

`tests/registry-error.test.ts` counts every `new RegistryError` in
`src/modules` and asserts the number. It expected 31 and found **33**:
`BANK_PROVIDERS`, which is this phase's, and `DEPLOY_CHECKS`, **which is Stage
A's**. Stage A added a registry, did not run this file, and was pushed with a
report of the tests it did run.

ADR 0132's device has now caught a registry six times and a stale suite once, and
the second is the more useful catch. A count that only moves when somebody
remembers to move it is a count nobody is checking; this one moved because a run
failed, which is the only reason any of the numbers before it moved either.

Stage A also left `docs/DEPLOY.md` claiming 95 migrations — a number *it* fixed
from 38 and pinned to the journal with a test, which then caught it one migration
later. That is the device working on the person who built it, one commit after
they built it.

## What this has not been run against

**Plaid.** This network cannot reach it. Every test drives a stubbed `fetch` with
payloads shaped from the documented API, so the adapter's *logic* is tested —
sign, pagination, mapping, error classification, the credential refusal — and its
*field names* are asserted against fixtures this repository wrote.

A fixture and an adapter written by the same person in the same hour agree with
each other whether or not either agrees with Plaid. Said plainly because it is
the kind of thing that is easy to imply is finished. Before this handles real
money: run it against Plaid's sandbox, which is free, and compare one real
payload against `PlaidTransaction`. `Plaid-Version` is pinned to `2020-09-14` so
that comparison stays valid.

Nothing in the product offers Plaid yet either — `BANK_PROVIDER` is unset, the
link widget is not in the UI, and `createLinkSession` has no caller outside a
test. That is Phase 49's rule (*a function with no caller is a feature that does
not exist*) and it is accepted here rather than argued away: the adapter is the
half that needed the measurement, and the widget is a screen.

## Nominated for Phase 177: the transaction that changed

`/transactions/sync` returns `modified`, and the universal case is the one every
bank does — **a pending transaction posts.** The amount changes (a tip, an FX
rate, a fuel hold settling) and so does the date. This adapter hands those
transactions over correctly. `importTransactions` then does:

```ts
.onConflictDoNothing({ target: [companyId, financialAccountId, providerTransactionId] })
```

So the update is **dropped**, and the inbox keeps the pending figure forever.
That is wrong on the books: a reconciliation against the real statement will not
close, and the difference will be the tip.

It is nominated rather than fixed because it is not a one-line change, and the
reason is the interesting part. The obvious fix — `onConflictDoUpdate` — would
silently rewrite the amount of a transaction somebody has **already categorized
and posted to the ledger**, possibly in a **closed period**. Idempotency was
built as "do nothing on conflict" when the only conflict was a repeated import,
and `modified` makes "already present" stop meaning "already correct".

The shape it needs is probably: update what is still uncategorized, and for what
has been posted, raise it as something a person decides — which is what
`modules/ledger/corrections.ts` and the period lock exist for. That is a phase,
not a line.

Two smaller findings go with it and should not displace it. `hasMore` is returned
by every adapter and read by nobody, which is self-correcting across worker ticks
because the cursor advances — so it costs latency rather than data, and a reader
would turn a first sync from "an hour of ticks" into "one job". And `removed`
needs somewhere to go on `TransactionPage` before a disputed authorisation can be
withdrawn from an inbox.
