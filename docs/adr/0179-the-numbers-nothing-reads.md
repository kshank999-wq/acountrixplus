# 0179 — The numbers nothing reads

**Status:** accepted
**Date:** 2026-10-07
**Phase:** 179

---

## The nomination held, and it held against the person who wrote it

ADR 0178 nominated a clean full run rather than a feature, on this argument:

> Three phases have now found a tree-wide tripwire red for a reason nobody had
> seen: `refusal-audience` in Phase 167 (red since 161), `isolation-guards` in
> Phase 169 (red since 166), `registry-error` in Phase 176 (red since Stage A,
> one commit earlier). Every one was found by a count, and every one had been red
> for multiple phases, because **a scan that counts the whole tree cannot be
> checked by running the tests near the code that changed.**

That prediction came true on Phases 177 and 178 — the two phases written between
making it and acting on it — **three times.** Each targeted run in those phases
included `isolation-guards`, `registry-error`, `money-division`,
`refusal-audience` and `public-writes`, and reported them green. None of them
included the three that were red.

## The first thing the run found was that it could not run

No full suite had completed in this session, and the reason recorded in four
previous phases — that the next phase kept needing to write to `src/` — was
wrong. **Postgres dies.** The container restarts, the database goes with it, and
a single `vitest` process holding 4,200 tests loses everything before the
restart: the last attempt reached 288 tests over 25 minutes and ended with no
summary at all, because the thing it was talking to had gone.

So the run was sharded — `vitest run --shard=n/8`, with the database brought back
between shards. A death now costs one shard and names it. That is the whole
reason this phase has a result and the four before it did not, and it is worth
recording as a fact about the environment rather than a fact about discipline.

## What was red, and for how long

| | Says | Is | Written |
| --- | --- | --- | --- |
| `retention.test.ts` | `TABLE_COUNT = 181` | 182 | Phase 158 |
| `the-id-a-caller-hands-in.test.ts` | 273 references, 18 composite | 274, 19 | Phase 174 |
| `rls-bites.test.ts` | 167 tenant tables, 161 policed | 168, 162 | Phase 160 |
| `isolation-reads.test.ts` | 883 reads | 911 | Phase 158 |
| `one-name-and-two-references.test.ts` | `invoice_lines_item_id_service_items_id_fk` | `invoice_lines_item_tenant_fk` | Phase 169 |
| `money-comparison.test.ts` | 21 comparison sites, all declared | 22, one undeclared | Phase 152 |
| `money-on-screen.test.ts` | 27 unclassified amounts | 29 | Phase 153 |

The first three went red in Phase 177, on its one new table — a table is a row in
`retention`'s count, a `company_id` in `rls-bites`'s coverage set, and a
composite foreign key in the reference total, so **one migration moved three
numbers and nobody moved any of them.**

The fourth is older. `isolation-reads`'s 883 was last written in **Phase 158**
and the measured figure is 911: twenty phases added twenty-eight reads from
company-scoped tables and the number did not move once. The honest limit on that
sentence is that git says when the line was last edited, not when it first became
wrong, and attributing it to a phase would need a bisect this phase did not run.

What makes it survivable is the half that passed. The same scan asserts that
**every** read it finds stands on a guard, and all 911 do. Twenty phases of reads
were written correctly and counted wrongly.

**The fifth is the one to sit with.** Phase 169 asserted the name of the
constraint that refuses a cross-tenant catalogue item. **Phase 170 replaced that
constraint** — single-column `invoice_lines_item_id_service_items_id_fk` became
composite `invoice_lines_item_tenant_fk`, which is the whole point of that phase
— and did not run the test one phase older that named it. It has been red for
nine phases and nine pushes, including every phase that cited Phase 170's
composite-key device as settled work.

That one is not a count. It is a test asserting a thing that no longer exists,
which means for nine phases nothing has been checking that `invoice_lines`
refuses another company's item by the route Phase 169 built to check it. Phase
170's own test covers the same ground, so the guarantee held; the check on it did
not.

**The sixth is mine, from two phases ago.** `money-comparison` does not only
count — it asserts that every comparison of two money amounts in the source has a
**declared comparability**, and it found one that does not:

```
src/modules/banking/revision-service.ts:523 heldRevisions
  — revision.previousAmountCents !== revision.amountCents
```

Phase 177 wrote that line. It happens to be sound — both operands come off one
`bank_transaction_revisions` row, which is exactly what `same-row` means and *"one
row has one currency, so there is nothing to ask"* — but soundness that nobody
declared is soundness nobody can check, which is the entire argument of ADR 0144.
It is declared now, and the declaration is the fix rather than the code.

`money-on-screen`'s 27 becoming 29 is the panel from Phases 177 and 178: two more
amounts rendered, two more to classify.

So of the seven files: four are counts, one is a stale constraint name, one is an
undeclared comparison, and **one is a security gap.** Every single one is a
tree-wide scan, and not one of them was in any targeted run between Phase 169 and
this phase.

### The tripwire that was built for this

`rls-bites.test.ts` says what it is for:

> Coverage is asserted against the **schema source** rather than against the
> catalogue the migration looped over, so a table added later fails here instead
> of quietly going unprotected.

`bank_transaction_revisions` carries a `company_id` and had no policy. Six tables
carry one and are deliberately unpoliced, and every one of them is unpoliced for
the same reason: it is read **in order to decide who the caller is**, strictly
before any tenant can be set — `memberships`, `security_policies`, `devices`,
`practice_engagements`, and the two queue tables Phase 162 exempted.

And this is not only a coverage count. The same file observes a **real restricted
connection** and asserts that nothing is wrong with it:

```
expect(observed.enabledCount).toBe(observed.tenantTableCount)   // 161 vs 162
```

So the live row-level-security self-check — the one `RLS_BYPASSES` exists to
drive, the one a deployment would run to answer "is the second layer actually
on" — has been reporting a fault on this database since Phase 177, and the only
thing standing between that and a wrong answer in a questionnaire was that
nobody ran it.

A bank transaction's revision log is none of those. It is read after the tenant
is known, it carries one company's figures, and what it holds is the audit trail
for amounts in that company's books. Migration 0098 puts it behind the predicate
with `bank_transactions` itself, and grants the privileges
`ALTER DEFAULT PRIVILEGES` would have given — because the tripwire's own comment
says why both are needed: *"granted is automated and protected is not,
deliberately: they are opposite defaults and only one of them is safe to let a
later migration inherit."*

The second layer is still inert, and `RLS_ROLLOUT` still says so. This closes no
live hole today; it closes the one that opens the day the application connects as
`accountrix_app`, which is the entire argument for installing policies before
they are needed.

### And a retention decision nobody made

`retention.test.ts` is blunt about its own crudeness:

> So the crude one, which works: the number is written down, and adding a table
> fails here. Yes, that means a one-line edit on every migration. **That is the
> price of the moment where somebody decides.**

Phase 177 added a table and skipped the moment. The decision:
`bank_transaction_revisions` goes in `NEVER_SWEPT`, because it is evidence rather
than traffic. Sweeping it would leave a transaction carrying −4420 with no record
that the bank moved it from −4000, and would delete a dismissed revision's note —
the only written explanation of a deliberate disagreement with the bank. That is
the state the `contribution_receipts` entry names: *a total with nothing behind
it.* `bank_transactions` itself is never swept, and an explanation must not be
swept before the thing it explains.

## The run, completed

Eight shards, 242 files, **4,437 tests — the first complete pass in this
session.** 4,427 passed and 10 failed, in the seven files above. Nothing else
failed anywhere.

| shard | tests | failed |
| --- | --- | --- |
| 1 | 617 | — |
| 2 | 609 | 1 |
| 3 | 567 | 2 |
| 4 | 520 | 3 |
| 5 | 546 | — |
| 6 | 487 | 4 |
| 7 | 507 | — |
| 8 | 584 | — |

## Two the run found that the audit had not

**`money-on-screen`'s unclassified remainder**, 27 against a measured 29. The
two are `crm/proposals/proposal-list.tsx:Service` (Phase 168) and
`accounting/invoices/board.tsx:SellableItem` (Phase 169) — both catalogue shapes
carrying a `unitPriceCents` and no currency, both the same character as the
twenty-seven before them, because `service_items` has no currency column and a
catalogue price is the company's own money by construction.

The number was last set in **Phase 144**, whose title is *"run it, and fix what
it caught — including four of its own claims."* Its own docstring says *"it may
shrink; it must never grow without somebody saying why"* — and growing turns out
to be invisible to any run that does not reach the file.

**And the one worth the whole phase.** `one-name-and-two-references.test.ts`
ended, in Phase 169, by asserting that a line naming another company's catalogue
item was **accepted**:

> It is accepted, which is the honest finding: the key proves the row exists and
> says nothing about whose it is. A tenant predicate on the insert is the
> remaining gap and is nominated rather than claimed.

**Phase 170 took up that nomination and closed the gap** — the composite key
`invoice_lines_item_tenant_fk` is what it built — and left this test asserting
the absence of the protection it had just added. From Phase 170 the insert threw,
nothing caught it, and the test *errored* rather than failing a comparison. Nine
phases, nine pushes.

Reworking it found two more things:

- **The unmatched-item label is now unreachable.** `serviceRevenue` groups a line
  whose `item_id` joins nothing under *"Not in this company's catalogue"*, and
  since Phase 170 nothing can produce that: `company_id` is `NOT NULL` on
  `invoice_lines`, so a non-null `item_id` always has both halves of the key and
  is always checked, and `ON DELETE SET NULL` nulls a deleted one. Kept on Phase
  157's rule — an unused declaration is kept when it **accuses** and deleted when
  it excuses, and this one accuses: if that label ever appears, a cross-tenant
  reference got stored and the key did not stop it.
- **The scoping it was really testing needed a reachable route.** The Phase 169
  defect was a join on `id` alone leaking another tenant's product name onto this
  company's dashboard. That property still has to hold, so it is now asserted
  from the other end — the other company invoices *its own* item, and this
  company's report must not contain it, with the mirror assertion that it does
  appear on theirs. A report returning nothing for everybody would have passed
  the first half alone.

## The audit, and the pattern it found

Alongside the run, every number stated in prose was checked against the thing it
is about. The result is not ambiguous:

```
deploy-migration-count          says  98   is  98   ok
runbook-table-count             says 181   is 182
runbook-policed-tables          says 163   is 162
deploy-policed-tables           says 163   is 162
readme-owner-table-count        says 181   is 182
rls-owner-table-count           says 181   is 182
rls-bypass-owner-table-count    says 181   is 182
rls-policed-table-count         says 163   is 162
rls-auditor-policy-count        says 163   is 162
rls-bites-owner-table-count     says 181   is 182
references-rollout-total        says 271   is 274
```

**Ten of eleven wrong, and the one that was right is the one Stage A had already
pinned with a test of its own.**

Every count a test reads was right: 111 writes, 883 reads, 34 registries, and —
once the three failures above are fixed — 182 tables, 274 references, 162 policed
tables. Every count only prose held had drifted. One mechanism, applied to nine
numbers and not to eleven others, and the difference between the two groups is
total.

The worst of them is `docs/DEPLOY.md`, in a paragraph that ends *"if you are
answering a security questionnaire from `pg_policies`, read this paragraph
first."* Somebody will copy that number into an answer.

## The remedy, which is Stage A's generalised

Stage A found `docs/DEPLOY.md` claiming 38 migrations against a journal of 95 —
wrong for 57 migrations — and wrote the right remedy and too narrow a one:

> Fixing it again in a year is not the remedy; the remedy is that the number is
> in a place something reads.

One test, for one number. `PINNED_CLAIMS` is that test for the rest: twelve
entries, each naming where a claim is, a pattern that recognises it, and the fact
to measure it against. The entry holds the **pattern**, never the number, so a
migration that adds a table fails the test and the sentence gets corrected rather
than the assertion getting moved.

Three details earn their place:

- **A pattern must match exactly once.** Zero matches is a pin that stopped
  pinning — somebody reflowed the paragraph and the check went green forever,
  which is Phase 160's shape inside the test written to prevent it. Two matches
  cannot say which number drifted. Both are failures with their own sentence, and
  both have a test.
- **Prose is read with its wrapping collapsed.** Newlines, Markdown wrapping,
  JSDoc `*` margins and the `' +` seam of a split string literal all become
  single spaces. Without that, five of the twelve claims could not be matched at
  all, and a reflowed paragraph would silently stop being checked.
- **The entry argues what a reader *does* with the number.** "This should be
  right" is not an argument; everything should be right. A count nobody acts on
  is not worth a test, and a count somebody copies into a security questionnaire
  is worth two.

## What it does not pin, declared rather than omitted

One entry carries no measure: the sentence in `isolation.ts` reading *"531 of the
867 reads, against 27 of the 109 writes"* — four numbers, all four drifted, the
measured figures being 542 of 883 and 28 of 111.

It cannot be pinned from here because the scans that count writes and reads live
**inside** `tests/isolation-guards.test.ts` and `tests/isolation-reads.test.ts`,
so nothing outside those files can ask for the number. It is declared with
`measure: null` and named by a test of its own, on Phase 139's rule that a staged
core gets a register and an acceptance test saying what is not wired — because
the alternative is a register that looks complete and covers eleven of twelve,
which is this phase's own subject one level up.

## The eleventh finding, which the verification run found in the fix

The suite was re-run after the fixes, and shard 7 failed:

```
a-job-through-the-policies.test.ts
  "leaves them unpoliced in the database, and the count at 161"
  expected 162 to be 161
```

That is this phase's own subject, committed inside the phase. The audit **read
that file** while measuring the policed count — it was one of the two tests cited
as evidence that 161 was the measured figure — and then migration 0098 moved the
figure to 162 and nobody came back to it. The number was used as a source and not
updated as a consequence.

Re-running found a second one in the same sweep: `docs/SPEC-AUDIT.md` still said
*"installed, forced on 161 tables"*, and said it next to *"110 writes and 883
reads"*. **That document was never audited at all**, because the audit read three
operational documents — README, DEPLOY, RUNBOOK — and this is the fourth. It is
the one that answers "is tenant isolation done" with a *partial* and then says
precisely how partial.

So `PINNED_CLAIMS` has thirteen entries, not twelve, and the thirteenth is there
as much for the omission as for the number: **a register assembled by grepping
the documents somebody thought of is this phase's own defect one level up.** The
pinning now covers it, which is the only part of this that does not depend on
somebody remembering.

Two lessons worth separating, because they point opposite ways:

- Running the suite again after fixing it was not ceremony. Reasoning that the
  fixes were obviously sufficient would have shipped two of them wrong.
- The audit's *method* was the weaker half of this phase, and the register is the
  stronger half, precisely because the register does not have a method — it has
  thirteen named files and a test.

## Where it ended

Three complete passes, which is three more than the four phases before this one
managed between them:

| | files | tests | failures |
| --- | --- | --- | --- |
| Before the fixes | 242 | 4,437 | **10**, in 7 files |
| After the fixes | 243 | 4,447 | **1** — this phase's own, in shard 7 |
| After the follow-up | 243 | **4,447** | **none** |

Every failure in all three runs was a tree-wide scan. Not one was a defect in a
feature.

## A line worth stating

A number in prose is either a claim about now or a record of what a phase
measured. The second is a log entry and stays: ADRs are dated, and a README
section narrating Phase 150 should say what Phase 150 found. The first must be
true now.

Every claim in `PINNED_CLAIMS` is the first kind, and the audit deliberately left
the second kind alone — `references.ts`'s heading *"Measured: 271 of them, and
not one carries the tenant"* is what Phase 170 measured and is not corrected to
274, because correcting it would erase the finding that phase was about.

## Nominated for Phase 180: move the two scans into a module

The unpinned entry names the work. `guardedWrites()` and the read scan are
hundreds of lines of source analysis living in test files, which means:

- Nothing can pin the numbers they produce, as this phase just found.
- Nothing else can use them. `PINNED_CLAIMS` wants them; a future deploy check
  that refused to ship with an unguarded write would want them more.
- Their own argument — that counting the whole tree is the only honest way to
  claim coverage — applies to anything that wants to make that claim, and it is
  locked inside two `describe` blocks.

`src/modules/source/` already exists and already holds `enclosing.ts`, which both
scans import. The move is mechanical; what it buys is the twelfth claim, and a
`deploy:check` that can answer "is every write guarded" without running vitest.
