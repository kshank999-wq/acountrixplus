# 0158 — Exporting to the accountant's software

**Status:** accepted
**Date:** 2026-10-04
**Phase:** 158

---

## Why this is not the nomination ADR 0157 made

ADR 0157 nominated **spec §19's row-level security**, on the grounds that it was
the last item on the spec audit that was a stated requirement rather than a
feature. That stands, and it is nominated again at the end of this document.

What happened instead is that a new specification arrived: the *Accountrix Plus
Professional Accountant Export Engine*, with the instruction *"you need to be
able to export to all the major accounting software, excluding anything that
would be competition."* A new requirement from the person the product is for
outranks a self-selected one, so the phase went there.

This is the first phase since 104 whose subject was chosen by a document rather
than by measurement. The measurement still decided what was *built*: three of
the four findings below came from writing a check and then asking what could
satisfy it.

## What the specification asks for, and what this phase did

The Exporter spec has five phases of its own. Its Phase 1 is *"Universal
accountant data model, balancing, mapping, audit logging, CSV/XLSX package"* and
is the only one that needs no vendor research — its §13 requires a one-page
integration worksheet citing official vendor documentation **before** any adapter
code, and §7 is blunt about why:

> Do not assume an API exists. Professional tax and workpaper products often rely
> on vendor-specific import files, trial-balance mappings, desktop utilities,
> SDKs, partner programs, or controlled integrations.

So this phase built the engine and declared every one of §3's twenty targets
`unresearched`. That is not a placeholder. Writing `api: 'REST'` against a
product whose real import path is a desktop bridge utility would be this
project's oldest defect — a declaration argued from a fact that is not a fact
(Phases 110, 125) — in the one place where being wrong means a firm's trial
balance silently fails to arrive, at a filing deadline.

Stated plainly because it is a limit on what was delivered: **no §3 target is
exportable today**, `adapterMayBeBuilt` refuses all twenty, and the sentence it
refuses with names what would change that.

## Five registries in one phase

The registry-with-prose device (Phase 101) was used five times here:
`EXCLUDED_DESTINATIONS`, `EXPORT_DESTINATIONS`, `READINESS_CHECKS`,
`PACKAGE_SECTIONS`, `TAX_CLASSIFICATIONS`. That took `registry-error.test.ts`
from twenty throws to twenty-five, which is worth a sentence rather than a shrug.

The specification names its destinations, its package sections, its validation
checks and its entity types as **lists**, and a list whose lookup returns
`undefined` lets somebody export to a competitor, skip a section of the package
or miss a validation check by typing a key wrong. ADR 0132 built `RegistryError`
so that the twelfth registry would cost nothing; this is what that bought.

### The exclusion is a constraint, not a note

§15's first acceptance criterion is *"direct competitor bookkeeping products are
not presented as export destinations."* A sentence in a specification cannot
enforce that — the next person to add a destination will not have read it.

So the seven products §2 names are declared with their reasons,
`mayExportTo('quickbooks-online')` refuses with the decision rather than with
"nobody declared that key", and a test asserts that no `EXPORT_DESTINATIONS`
entry appears among them. A constraint beats a check (Phase 116), and a check
beats a paragraph.

Two details worth recording. The exclusion is about a product's **position**, not
a company's name: §2 qualifies Sage as *"products positioned primarily as
small-business bookkeeping replacements"* and §3 lists Sage Intacct as a Priority
2 target, so the entry says so. And the refusal says the books can go out as a
universal package instead, because §2 permits reading these products as migration
sources — books coming *in* from QuickBooks is a migration tool, and only pushing
books *out* is refused.

The export screen does **not** list the excluded products. A section headed "we
will not export to these" presents them, in the place somebody is looking for a
destination.

## What measurement found

### `companies` could not say which return the books feed

§5's package opens with *"client / entity information"* and *"entity type and tax
classification"*, and §11 makes an incomplete client profile a **red** exception:
the entity type decides which return the figures feed and the fiscal year decides
which year they land in.

Measured against `companies`: a name, a legal name, an industry, a fiscal year
start month, a currency and an inventory cost method. No entity type and no EIN.

So `entity_data_complete` would have fired on every company in existence. A red
check that can only fail is worth exactly as little as Phase 121's check that can
only agree, and only one of the two could change — it was not going to be the
check, because *which return do these books feed* is a real question with no
answer in that schema.

`industry` is not it, and the distinction is the point. A joinery can be a sole
proprietorship, a partnership or an S corporation. `industry` drives the chart of
accounts; this drives the return. Bending one to mean both would be Phase 130's
defect in the field a federal return is selected from.

`TAX_CLASSIFICATIONS` names the return each type files, because that is the fact
an adapter needs and the one a person choosing from a dropdown is actually
deciding. A list of names with no returns beside them invites somebody to pick
"LLC", which is not a tax classification at all — hence two LLC entries naming
what they are *taxed as*.

### §11's continuity check had no fact behind it

The obvious reading of *"beginning balance continuity"* is: does this period's
opening equity equal the prior period's closing equity? Both figures come from
summing the same journal lines to the same date, so they agree by construction.
That is Phase 121 again, and it was caught by writing the check and trying to
make it fail.

The real break is the one `staleCloses` has measured since ADR 0011's follow-up.
Closing and locking are deliberately separate in this ledger, so an entry can be
posted into a year that has already been closed; the books still balance, because
the new entry has two sides, and the figure the close moved into retained
earnings is now wrong. That is precisely an opening balance that does not carry
forward, and it is a fact rather than an identity. Only closes whose date
precedes the export window count — drift inside the window shows up in the
window's own figures.

### §15's reconciliation has two readings, one unsound

> The exported totals reconcile exactly to the Accountrix reports for the same
> period.

The unsound way to satisfy that is for the exporter to write its own queries and
compare its answers to the reports'. That is two answers to one question — the
defect this project has named since Phase 100 — and the comparison is a check
that will one day disagree, leaving an accountant holding two trial balances with
no way to tell which is the books.

So `assemble` calls `trialBalance`, `profitAndLoss`, `balanceSheet`,
`cashFlowStatement`, `arAging`, `apAging`, `assetRegister`, `salesTaxReturn`,
`contractorPayments` and `payrollSummary` — the same functions the screens call.
Reconciliation is then structural rather than checked (Phase 116).

What remains worth checking is narrower than §15's sentence suggests, and both
halves of it are real:

- **The rendering.** The one step where a figure can change is cents to units,
  and a rounding slip or a thousands separator there produces a file that looks
  right and foots to something else. `renderedTotals` reads the trial balance
  file back — with a parser that honours the writer's RFC 4180 quoting, because
  one that did not would report a difference that was in the reader — and §11
  compares that against the report.
- **The two halves of the package.** `detail_ties_to_balances` foots the general
  ledger detail against the trial balance. These *are* two queries with
  separately written filters, because `generalLedger` reports one account at a
  time and a whole-period detail file through it would be one round trip per
  account. A firm will foot one to the other, because that is what a workpaper
  review does.

The orphan-line check earns its place through the same seam.
`detailLines` inner-joins, so a line with no entry is **silently absent from the
detail while its figures remain in the balances** — the two halves stop tying
with nothing on screen to say why. The orphan check names the cause; the
reconciliation check reports only the symptom.

## Three states, not two, for what is in the package

`PACKAGE_SECTIONS` holds §5's twenty-seven items. A `type AccountantPackage = {
trialBalance: …, generalLedger: … }` would say what the package holds and nothing
about what it *should* hold, so the four items Accountrix cannot produce would be
invisible — absent from the type, absent from the file, and absent from any list
of what is missing. A firm would find the gap by looking for the loan schedule.

| state | means | the firm reads it as |
| --- | --- | --- |
| `source: null` | Accountrix does not hold it | "the client does not have this" |
| `exported: false` | held, not yet written to a file | "ask Accountrix" |
| omitted at run time | the caller may not read it (§12) | "ask somebody with the permission" |

Those are three different phone calls, and `gapNote` says which. The four true
gaps, measured rather than guessed: loan and liability schedules (`loan` is a
*kind of financial account*; no amortisation is stored), adjusting journal
entries separately (entries carry no adjusting flag, which is also what §8's
*"whether adjustments can be exported separately from balances"* question
blocks), tax-code mappings (§10's store does not exist), and supporting-document
references (nothing indexes them, and §7 has no answer for any target yet).

Each of those is a feature with a §5 clause behind it, which is a better backlog
than a list of ideas.

### The registry's claims are measured, not trusted

`export-engine.test.ts` reads every `produces` out of the file it names and every
`permission` out of that function's own `requirePermission` call. Phase 141's
rule: declare the knowledge, measure the fact.

It earned itself immediately. The registry's first draft claimed
`tenancy/companies:companyProfile` and there was no such file — which is how this
phase found that `companies` held no entity type. The scan also follows one level
of same-file delegation, because `trialBalance` takes no permission of its own
and calls `accountBalances`, and the permission a caller actually needs is the one
at the bottom of the chain.

## Permissions: omit and say so

§12 requires exports to be restricted by permission, and §5's sections sit behind
eight different ones. Two shapes are worse than the one chosen. An export taking
the broadest permission in the product would let anybody who can see a report
take the payroll home in a file. One calling every producer unconditionally would
throw halfway through for a bookkeeper who cannot see payroll — producing **no**
package rather than the package they are entitled to.

So a section the caller cannot read is omitted and the manifest names it. A firm
then knows the payroll summary is absent because of who asked rather than because
the client has no payroll, which is the one thing a missing file cannot say for
itself. A bookkeeper's export carries the same trial balance and the same ledger
detail as an accountant's, and loses the three statements and the payroll.

The trial balance is the exception: without `reports:view` there is no package at
all, so that is a refusal rather than an omission.

`companyProfile` sits at `reports:view` and the EIN behind a separate
`taxIdentifier` at `company:manage`. The assessment carries *whether* an
identifier exists and never the number, because an assessment is shown on screen,
written into the export log and pasted into support tickets — §12: *"do not
include sensitive fields that are not required by the target system."*

## A held export is a row

The one design decision in `accountant_exports`. §11 produces red and no file,
and that event is the most valuable thing in the table: somebody tried to send
these books to professional software and could not, and the exception report says
why in sentences.

A log that records only successes cannot answer *did anybody try*, which is the
first question asked when a filing is late.

`accountant_exports_red_is_held` makes the two agree in the database:
`(readiness = 'red') = (result = 'held')`. That turns §15's *"every export is
balanced and validated before release"* into a constraint — the path that skipped
the validation cannot write the row that records having skipped it.

It is a separate table from `data_exports` deliberately. That one is §19's
portability log, a customer taking their own data home. This one records a firm's
books being converted into a named system's format. The questions asked of the
two rows are different — *who took the ledger* against *which version of which
adapter produced the file UltraTax rejected* — and collapsing them would mean a
column saying which kind a row is, with half the other columns null.

## The adapter contract, declared before the second adapter

Normally this project would refuse this. Phase 49's rule is that a function with
no caller is a feature that does not exist, and an interface with one
implementation is an interface shaped like its only implementation.

Two things make this the other case. §15 requires that *"adapters can be updated
independently when a vendor changes its format or API"*, which is a requirement
about the seam rather than about any adapter. And §13 puts the second adapter
weeks of research away, so the choice is between declaring the seam now and
discovering it later by refactoring the universal package into it under deadline.

The honest cost is stated rather than hidden: the contract is a prediction, and
the first real tax adapter will correct it. What it is not is a guess at any
vendor's format — every member comes from §8's own list.

The interesting part of §8 is its qualifications: `sendViaAPI()` *"when
supported"*, `generateManualImportInstructions()` *"when direct API is
unavailable"*, `parseImportErrors()` *"when supported"*. A professional tax
product's import path is often a file a human carries into a desktop program, and
an interface that made `sendViaAPI` mandatory would force every such adapter to
implement a lie. So those are optional members, `capabilities` declares which
exist rather than being inferred by probing for methods, and `adapterStands`
relates the two — which TypeScript cannot: it can require `instructions?` and
cannot require it *when `transmits` is false*.

`registerAdapter` throws at import time on an incoherent adapter, so one stops the
process that loaded it rather than waiting to be offered to somebody.

## What is declared not done

§4 lists five formats for the universal package. This phase does CSV and
delimited text, and says why not the rest rather than omitting them quietly:

- **XLSX** is a ZIP of XML with a shared-string table and a styles part. This
  project has nine dependencies and no spreadsheet library, and it wrote its own
  PDF writer rather than pulling one in. So XLSX is either a new dependency or a
  file of its own, and both are decisions for whoever knows which the project
  wants. Every spreadsheet opens CSV in the meantime.
- **A PDF reporting package** is a composition of statements this codebase can
  already render; it is a screen and a layout rather than an exporter question.
- **ZIP** needs the same archive writer, and §4 calls it *"optional"*. Its
  absence is why the screen saves files one at a time, which is said on the
  action rather than left to be discovered from the download behaviour.

§10's mapping and learning system — firm templates, client overrides, prior-year
reuse, entity-type-aware mappings — is not built. Its absence is **enforced**
rather than recorded: the three `mapped-destination` checks read `null`, and
`null` is red, so asking to export to Lacerte today gets *"no account mapping has
been established for Lacerte Tax"* rather than a feature failing silently.

Phase 157's rule decides whether those three checks should exist at all with no
mapping store behind them: a declared value with no users is kept when it accuses
and deleted when it excuses. These accuse.

## Also removed

A `refuseDestination(key): Refusal` with no caller. `service.ts` throws
`new Refusal(allowed.why)` at the two places that need it, because that is one
line and reads in place. Phase 49, and found by the only part of it that did
anything — a bare `throw` that `refusal-audience.test.ts` reads as prose written
for a person.

## What is nominated next

**Spec §19's row-level security**, re-nominated from ADR 0157 unchanged. It has
been declared outstanding since Phases 149 and 150, which measured tenant
isolation on both sides — 110 writes and 878 reads, every one guarded — and said
in both ADRs that RLS is a *second* layer and a migration, not a substitute for
the first. This phase added five reads and no new exposure, and it is still the
only remaining item with a spec section behind it.

The Exporter spec's own next phase is **§10's mapping store**, and it is nominated
*after* RLS rather than before it for a reason worth writing down: §13 means no
§3 adapter can be built until vendor research is done, and a mapping store with
no destination to map to would be Phase 49's defect at the scale of a subsystem.
The three red checks that refuse a tax destination today are the right placeholder
for it — they say what is missing and they stop anybody relying on its absence.
