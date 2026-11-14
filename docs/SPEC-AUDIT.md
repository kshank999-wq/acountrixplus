# Spec audit, measured

**Date:** 2026-10-06 · **Phase:** 164

A section-by-section audit of `docs/SPEC.md` against the code, done by reading
rather than by grepping — for a reason given below.

## Why this exists

Four consecutive phases (160–163) nominated their successor from inside one arc,
and ADR 0163 recorded that **three consecutive nominations had been wrong**,
each because it reasoned about how something would behave instead of measuring
it. The corrective to a run of bad hypotheses is not a better hypothesis. It is
a measurement, which is what this is.

## The method, and the mistake it starts with

The first attempt grepped the spec's own vocabulary against the source. It
reported that §9's *"performance by … geography"* was unimplemented: zero files
matched `geograph`.

**That was wrong.** `breakdownBy(ctx, dimension)` takes
`'owner' | 'source' | 'industry' | 'region'`, and `region` *is* geography —
joined from `organizations.region`, labelled `'Unspecified region'` when absent.
`source` is likewise §9's *"lead source"*.

So grepping the specification's words finds the specification's words, not the
implementation. Two of five apparent gaps in §9 were false negatives from one
naive pass, and this audit is done by opening the modules instead.

**It also means four ADRs were wrong, which is the better finding.** The claim
appears in ADRs **0152, 0153, 0154 and 0157** — each inheriting the previous
one's nomination list without re-measuring it. That is how a false sentence
survives four phases of otherwise careful work: not because anybody asserted it
carelessly the first time, but because nobody asked again.

Each of the four now carries a correction pointing here, rather than being left
to be inherited by a fifth. And it is worth drawing the rule out, because this
project has a register for everything else: **a nomination inherited is a
nomination unmeasured.** The arc from 160 to 163 produced three wrong
nominations by reasoning; this one produced a wrong one by copying. Both are the
same failure to re-measure, and ADR 0164 states it as a rule.

## Section by section

| § | Section | State |
| --- | --- | --- |
| 1 | Product Vision | — prose |
| 2 | Primary Workspaces | **done** — all workspaces exist under `src/app` |
| 3 | MVP: Daily Bookkeeping | **done** |
| 4 | Reconciliation | **done** — `modules/reconciliation` |
| 5 | Chart of Accounts & Industry Onboarding | **done** — `modules/coa`, `modules/industry` |
| 6 | Clients, Leads & Opportunity Pipeline | **done** — `modules/crm` |
| 7 | Proposal / Estimate / Document Designer | **done** — `modules/design`, `modules/studio` |
| 8 | Shared Marketing Creative Studio | **done** — `modules/marketing`, `modules/brand` |
| 9 | Proposal Analytics & Sales Dashboard | **one status had no writer** — below |
| 10 | Marketing & Strategic Prospecting | **done** — `modules/marketing/segments`, `campaigns` |
| 11 | Optional AI Module | **seven rows, 25 of 33 functions** — below |
| 12 | AI Technical Architecture | **done** — `modules/ai/gateway`, metering, provider registry |
| 13 | Professional Accounting Workspace | **done** — every bullet, checked individually |
| 14 | Roles, Permissions & Accountant Access | **done** — `modules/permissions`, `modules/practice` |
| 15 | Company Studio / Brand Profile | **done** — `modules/brand` |
| 16 | Core Data Model | **done** — 185 tables |
| 17 | Recommended Service Boundaries | **done** — modular monolith, `src/modules/<domain>` |
| 18 | Technology Direction | **done** |
| 19 | Security & Financial Integrity | **one partial** — below |
| 20 | Development Phases | **done** — all 51 deliverables, measured — below |
| 21–24 | Assignments, DoD, rules, next steps | — process |

### §9 — the four real gaps (all four built in Phase 168), and a fifth found in Phase 195

`modules/crm/analytics.ts` provides `winLossSummary`, `breakdownBy`,
`lossReasons`, `proposalStats` and `pipelineValue`. Against §9's own list:

| §9 asks for | state |
| --- | --- |
| counts and value by status | ✓ `proposalStats.byStatus` |
| win rate by count and value | ✓ `winLossSummary`, `winRateBp` |
| pipeline value, forecast value | ✓ `pipelineValue`, `forecastValueCents` |
| by salesperson, lead source, industry, geography | ✓ `breakdownBy` — `owner`, `source`, `industry`, `region` |
| opens/views | ✓ `viewRateBp`, `proposal_views` |
| lost-opportunity dashboard, loss reasons, re-engagement | ✓ `lossReasons`, nurture handoff |
| average proposal size | ✓ `proposalStats.averageValueCents` — **built in Phase 168** |
| average time to decision | ✓ `proposalStats.averageDaysToDecision` — **built in Phase 168** |
| performance by service/product | ✓ `serviceBreakdown` — **built in Phase 168** |
| performance by time period | ✓ `breakdownBy('month' \| 'quarter')` — **built in Phase 168** |

> **Closed by Phase 168, and the paragraph below was backwards on both halves.**
>
> *Average time to decision* needed **no** new fact. `proposals.sent_at` is
> written by `sendProposal` and `proposals.decided_at` by `decideProposal` and
> by the public acceptance path — both since Phase 3. Nothing computed the
> interval, which is a different problem from nothing recording it.
>
> *Performance by service/product* needed one, **and a screen**.
> `proposal_items` had no reference to the service catalogue at all, so the only
> thing to group a line by was the prose somebody typed. That is Phase 136's
> `a field` blocker, not a re-grouping.
>
> And §9's *average time to decision* was not merely missing: a different
> interval was already on the dashboard under that name —
> `WinLossSummary.averageDaysToDecision`, measuring `closed_at - created_at`.
> Renamed to `averageDaysToClose` in Phase 168.
>
> Third false *reason* in this audit's lineage, after §9's "geography analytics"
> (ADR 0164) and §11's "segments has strategic-account segmentation" (ADR 0167).
> The audit's claims about what is missing have held; its explanations of why
> have not.

The first two are small and the second two are the same shape as the four
dimensions that exist. Worth noting that *"average time to decision"* is the only
one needing a fact nothing currently records per proposal — the others are
re-groupings of data already there.

> **Re-measured in Phase 195, and the row was claiming too much.** The four
> gaps are built. What this row never said is that §9's **first** bullet asks
> for *"counts and value by Draft, Sent, Viewed, Won, Lost, Expired, and No
> Decision"* — and of those seven, **six were reachable**. Nothing in the
> application ever set `expired`.
>
> Every other part of it was here. `proposals.expires_on` is recorded, the
> client-facing page has refused a lapsed proposal by comparing it against
> today since Phase 3, and `serviceBreakdown` already classified `expired`
> beside `lost`. So the company's dashboard counted a lapsed proposal as sent
> and awaiting a reply while the link it was sent on told the client it had
> expired — two documents disagreeing, which is the defect this project names
> most often.
>
> `lapseExpiredProposals` and the daily `proposals.lapse_expired` schedule are
> the one write that was missing. `decided_at` is deliberately left alone, so a
> deadline passing does not enter §9's *"average time to decision"*, and
> `decideProposal` no longer accepts `expired` at all — one status, one writer.
>
> `proposalStats.byStatus` is now seeded from the enum, so all seven appear in
> pipeline order with their zeros. A status missing from a table of counts is
> ambiguous between "none" and "not reported", and that ambiguity is how this
> one stayed invisible for a hundred and ninety phases.

### §11 — seven of seven rows, and 25 of 33 functions (Phase 195)

`BUILT_IN_PROMPTS` holds **10 prompt keys** covering all seven of §11's rows. It held eight
covering five when this audit was written:

| §11 capability | prompt |
| --- | --- |
| AI Bookkeeping Assistant | `bookkeeping.categorize`, `.anomalies`, `.rule`, `.summary` |
| AI Reconciliation Assistant | `reconciliation.explain` |
| AI Proposal Writer | `proposal.draft` |
| AI Marketing Assistant | `marketing.draft` |
| AI Business Insights | `insights.business` |
| AI Design Assistant | `design.layout` — **built in Phase 166** |
| AI Strategic Account Assistant | `account.strategy` — **built in Phase 167** |

> **Closed by Phases 166 and 167.** §11 is complete: seven capabilities, seven
> prompts. The two sentences below were what this audit said while both were
> outstanding, and both were corrected by building them.
>
> `modules/marketing/segments` does **not** have strategic-account
> segmentation in the sense this claimed. It has `isStrategicAccount` as a
> segment *field* — a boolean a marketing audience can be filtered on — and no
> relationship data at all. The Strategic Account Assistant reads
> `engagement/communications.ts`, `engagement/timeline.ts`,
> `opportunity_activities`, `proposals`, and invoices through
> `customers.organization_id`. The claim was repeated by ADRs 0165 and 0166,
> each inheriting the nomination without re-measuring — the pattern Phase 164
> named.
>
> And §11's Design Assistant is **not** the larger of the two, because it does
> not ask for an image model: every capability in that row is advisory and the
> bullet that sounds like pixels, *"image prompts"*, is explicitly text. The
> Strategic Account Assistant turned out to be the larger, because half of its
> row — *"identify neglected high-value prospects"* — is arithmetic that must
> work with the AI module switched off, and so needed a pure core
> (`crm/attention.ts`) and a measured service (`crm/accounts.ts`) of its own.

Both capabilities had the infrastructure they needed — the gateway, metering,
and the prompt registry with versioning.

Of the two, **AI Design Assistant** was nominated first because provenance is a
data requirement rather than a prompt — which held: Phase 165 settled
`assets.provenance_origin` before a prompt was written, and Phase 166 found that
rule had been applied one level short of where an accepted layout suggestion
actually writes.

#### Counted by function rather than by row (Phase 195)

ADR 0194 nominated this row because it had been revised *upward*, five to
seven, which is the one direction a stale row had not yet been wrong in here.
Re-measured, the seven are right and **the unit is not**. §11 is a table whose
*Function* cell lists several things per row, and counted that way it asks for
**thirty-three**:

| §11 row | functions | behind them |
| --- | --- | --- |
| Bookkeeping | 5 | 5 |
| Reconciliation | 3 | 3 |
| Proposal Writer | 5 | 4 — no reusable proposal content |
| Design Assistant | 5 | 3 — no brand variations, no logo ideation; its two imagery bullets are served by one feature |
| Marketing | 5 | 1 — no segment suggestion, timing, or nurture sequence, and no voice input reaches the prompt |
| Strategic Account | 4 | 4 |
| Business Insights | 6 | **5** — was 3; no operational figure is supplied |
| **total** | **33** | **25** |

So *"seven of seven"* was true of the rows and said nothing about eight
functions §11 asks for and nothing produces. Both numbers are worth having: a row with a prompt behind it is a
capability a company can switch on, and a function with nothing behind it is
something §11 asked for.

**Business Insights was the one that mattered**, because two of its three
missing functions were not absent so much as starved. That prompt's own first rule is
*"every insight must be traceable to a figure you were given"*, and §11 asks it
to explain *"expense changes"* and *"cash-flow trends"*. It had been given no
expense figure at all, and for cash a single balance — which is a position, not
a trend. So it correctly said nothing about either, and the silence read as a
quiet month rather than a missing input.

Nothing new had to be computed. `comparativeProfitAndLoss` has produced two
columns of a real profit and loss since §13's comparative periods were built,
and `cashFlowStatement` has stated opening, closing and net movement since
Phase 33. The calls were never made.

That change is `insights.business` **version 2**, with version 1 left in place:
the gateway writes `promptVersion` into every `ai_requests` row, so editing v1
would rewrite history under rows that already cite it — and §12 asks for a
registry with *"versioning, testing, and rollback"*, which a version that can
be rewritten is not.

Its sixth, *"operational trends"*, is left as a gap and named as one: nothing
operational reaches that prompt — not the uncategorized backlog `inboxShape`
already counts, not unreconciled accounts, not overdue follow-ups. It is the
next thing to put behind this row, and unlike the two above it needs a figure
chosen rather than a call made.

The other seven are recorded as gaps rather than built. Two are counted
generously and the generosity is stated: the Design row's *"background/graphic
concepts"* and *"image prompts"* are one feature answering two of §11's words —
`design.layout` returns short textual descriptions of imagery — so counting
both would double-count it and counting neither would misreport it.

> **Phase 200 built the Marketing row's cheapest gap, and found three defects
> behind it.**
>
> *"Adapt content to company voice"* had nothing behind it, and the reason was
> a chain where each link hid the next: `companyProfiles.description` had a
> column, a service that accepted it and **no field on the Design Center form**,
> so there was no material; `companyContext` exposed a `tagline` **no caller
> had ever read** and never loaded the description, so what material there was
> did not reach the module; and `marketing.draft` never asked.
>
> Building from the nomination alone would have fed the prompt an empty string.
>
> `proposal.draft` turned out to be the sharper half: its v1 **already said**
> *"write in the company's voice"* while being given the name, the industry and
> a price list — inferring voice from a catalogue. Both prompts are at v2 now
> with their v1s retained, and both are given the company's own words.
>
> And the tripwire written for this — `PROFILE_FIELDS` asserted against the
> profile's own columns — named two more on its first run:
> **`addressLine2` and `country`, which `letterhead.ts` reads** and puts on
> every document a client sees. A column with a reader and no writer, so a
> company with a second address line or an address abroad could not put it on
> its own letterhead. Both have fields now.

Segment suggestion and nurture sequences are §10 work wearing an §11 label, and
with voice built the Marketing row's three remaining gaps are all of that kind
or Phase 195's *follow-up timing*.

### §19 — one partial

Nine of ten bullets are done: encryption (`modules/auth/secret-box`), tokenized
bank connections, idempotent imports (`idempotency_keys`), complete auditability
(`audit_events`), backups and a **tested** restore procedure
(`scripts/backup.sh`, `scripts/verify-restore.sh`), exportability (§19's own
portability export plus Phase 158's accountant exporter), privacy and
suppression (`modules/crm/intake`, `modules/notify`), and security review gating.

**Strong tenant isolation** is the partial, and it is partial in a precise way
rather than vaguely: the application layer is complete and measured — **305
writes** and **979 reads**, every one guarded (Phases 149–150, the census
widened in Phases 196–198) — and
the database layer is installed, forced on 165 tables, proven against a restricted role, and **not
switched on**, because the application connects as a superuser that owns the
tables. `RLS_ROLLOUT` carries the detail; `rlsStands` refuses to report
otherwise.

> **The write half of that measurement was 43% of itself until Phase 196.**
>
> *"Every one guarded"* was true and *"complete"* was not. `scanWrites`
> recognised a key only as `input.something` or a name ending in `Id`, so
> `eq(proposals.id, proposal.id)`, `eq(x.id, id)` and `eq(x.id, placeholder)`
> were not reported as unguarded — they were outside the census altogether.
> Measured: **157 writes**, against the 119 it was counting.
>
> The answer that mattered is that **none of them was unguarded**, and it was
> measured before the scan was changed. All 157 classify; six stood on a guard
> the write classifier had no word for, and those six were read one at a time
> rather than counted. `id-from-fetched-row` is that word — the read classifier
> has had it since Phase 150, and the guard's own prose said the distinction
> *"makes the whole narrowing of both scans possible"* while it was declared
> for reads alone.
>
> One write could not be justified by the widened census: `mintChartAccount`
> took its id from a company-filtered helper three lines above rather than from
> its own statement. It got a `scoped()` rather than a guard entry, because the
> ordering in `guardFor` exists to prefer the guard that cannot be separated
> from the write.
>
> The read side has no hole of that shape, for a reason worth stating:
> `scanReads` matches every `.from(` on a company-scoped table and never
> filters by key, so its denominator was always every read.
>
> Both numbers in this paragraph are pinned now (`audit-isolation-census`), as
> is the copy in `docs/RUNBOOK-FIRST-COMPANY.md`. They had drifted — the writes
> by four phases, the reads by two — while the pinned copy in `isolation.ts`
> stayed right, which is what pinning one sentence of three gets you.
>
> **Phase 197 found two more layers of the same defect.** The census recognised
> a query by three separate names and each hid some: the key's value (157
> writes, Phase 196), the **table** — a name in the schema, so a query through
> a variable was not reported as unguarded but *was not a query*: 5 writes and
> 15 reads — and the key's **predicate**, an `eq`, so 3 writes keyed only by
> `inArray(table.id, ids)` were missed, which is a bulk write by a
> caller-supplied list and the most aimable shape there is. Two of the
> variable-table writes are in `importing/reversal.ts`, which deletes the rows
> an import created, so the census had never looked at a destructive generic
> helper.
>
> All twenty are guarded, read site by site before anything was widened. Two
> queries remain unresolvable — `retention/sweep.ts` takes its table from
> `RETENTION_POLICIES` at runtime — and are **declared** in
> `scanUnresolvedTables()` with the count pinned at two, rather than skipped.
>
> **Phase 198 folded raw SQL in**, and the shortfall was not nine but eleven.
> Phase 196 had counted the raw *writes* — seven — and asserted each carried a
> tenant predicate; extending the same measurement to reads found **four
> selects nobody had counted**, one of which had no tenant predicate at all,
> nine lines from a sibling that did. A writes-only count was incomplete in the
> direction that mattered.
>
> That read was not a disclosure: another company's row cannot name this
> company's vendor, because the column is a foreign key and that is the
> cross-tenant reference Phases 170–172 made the database refuse. So the count
> was right, and right because of a property of the data rather than anything
> in the statement. The clause is defence in depth, and the check that holds it
> is the census rather than a behavioural test — a test for it was written and
> deleted for passing without it.
>
> There is no known shortfall in these two numbers now. A statement whose table
> is chosen at runtime is counted as `(dynamic)` and still has to be guarded,
> which is the conservative direction.

#### A different census of the same schema (Phase 201)

Isolation asks whether every query names the tenant. **Phase 201 asks a
question nothing had asked: which columns does something read that nothing
lets a person fill in?** Phase 49 found that shape twice by accident and Phase
200 found three more by accident of writing one narrow check against one form,
so it was measured as a class instead.

The scan reads **2176 columns** across **185 tables** and reports **93** with a
reader and no writer it can see. All three numbers are pinned
(`audit-column-writers`) — the denominator beside the answer, because Phases
196–198 each found a census quoting a subset as a total.

**Twelve of the 93 are findings, covering 13 columns** — fourteen over sixteen
when Phase 210 wrote them, less `bill_lines.item_id`, which Phase 211
established had never been a defect and dropped, and less the two `projects`
columns Phase 212 gave a writer. They are the first findings
this register has carried. From Phase 208 to Phase 210 it had none, and that was a
claim about what the scan could see: its test for *read* was `tableVar.column`
named outside the schema, and a projectionless `select()` reads every column of
its table while naming none, so **72 columns had never been examined at all**.
Phase 210 corrected the rule; the count went 29 → 96 and sixteen of the new
ones are written by nothing. `COLUMN_WRITERS`' candidate count is what makes a
closure visible — it falls when one is closed, because a closed column leaves
the scan.

Most of them are written by a **spread** or a **helper's return**, which no
regex can resolve, so `COLUMN_WRITERS` declares each mechanism and names the
file that writes it. The rule its test asserts is that every candidate is
**declared or fixed**, in both directions: an entry for a column the scan no
longer reports is removed rather than left to excuse it.

Four were real. Two are closed in Phase 201 and are therefore **absent** from
the register, which is what proves the editors reach the column:

- **`organizations.sizeBand`** — a segment filter that could only ever match
  nothing. Listed in `SEGMENT_FIELDS`, given a `case` in the matcher, selected
  by `loadCandidates`, labelled *"Size band"* on the segment workspace, and set
  by no screen. Worse than an unused column, because the interface offered the
  filter and returned an empty audience with nothing to say why.
- **`service_items.inventoryAccountId`** — a ledger decision nobody could make.
  `inventoryAccounts` chose the posting account from it and `reconcileInventory`
  collects every account any item names so the subledger check does not cry
  wolf; its docstring said *"a business that keeps raw materials and finished
  goods on separate balance sheet lines sets them on the items"*. Only the seed
  did.

Two remained at the end of Phase 201, declared and nominated. Both are closed
now, and the gap between declaring and closing is the thing to read:

- **`memberships.permissionOverrides`** — §14's granular grants and
  revocations, read into the actor, parsed, and *applied* by
  `effectivePermissions`, with nothing anywhere able to write one. The
  §20 register's own permissions entry claimed them until Phase 201 measured
  it. Closed in Phase 202, which found it was one of four §14 gaps rather than
  the one ADR 0201 nominated.
- **`vendors.organizationId`** — the supplier who is also a client, the case
  `engagement/filing.ts` exists for. The customer side is written when an
  opportunity is won; there was no path at all for a supplier, so a remittance
  never reached that client's CRM timeline. **Declared in five consecutive
  ADRs** and closed in Phase 208 — see §6 below, because the reason it took
  five is the interesting part.

The fifth mechanism is worth recording because it was a correction to a shared
primitive rather than to this scan: Phase 197's `declarationOf` read a local
declaration **to the end of its line**, on the stated grounds that every one in
the repository was a single-line ternary. It was not — `payroll/sales-tax.ts`
builds its rows with `const rows = input.lines.map((line) => {` — and four
columns of `document_tax_lines` looked unwritable, two of them `notNull`, which
would have meant a table nothing could insert into.

#### What that census could not see (Phase 202)

**Two blind spots, both closed or declared.**

Phase 201 excluded every column carrying a **default**, on the argument that
the database supplies it. Too wide: a `defaultRandom()` key is the whole
answer, a `.default(true)` boolean is a *starting value for a state*, and a
state nothing can change is a switch painted on. Narrowed to
`defaultRandom()` and `defaultNow()` only, the census went 27 → 35, and **six
of the eight it added are an `isActive` nothing can turn off**. One of them was
§14's revocation; Phase 203 closed a second, and the pinned figure is 34.

The second cannot be closed. **1168 columns** are written at insert and never
updated, so the scan counts them as written even where nothing can ever change
them — `memberships.role` was unchangeable for 201 phases and the census
reported nothing. Almost all 1168 are immutable *on purpose* (ADR 0021's sent
document, ADR 0042's live record), so a register of them would say "correct"
hundreds of times and bury the few that are not. It is a pinned number
(`audit-insert-only-columns`) rather than a register, and narrowing it needed a
way to say which columns are state rather than record — which **Phase 212
supplied**, ten phases later, and the figure is 1168. See §5 below.

### §14 — the switch painted on (Phase 202)

**`memberships` was insert-only.** Nothing in the repository updated a
membership row; the three `delete(memberships)` statements are keyed by
`practiceEngagementId` and remove only what an engagement created. So §14's
permission model was four gaps rather than the one ADR 0201 nominated:

- **no revocation.** `resolveSession` re-reads the membership on *every*
  request filtered on `isActive`, under a comment saying *"a lock that waits
  for a session to expire is not a lock"*. §14 asks for revocation by name.
  Nothing could set it false, so a directly-hired employee who left kept their
  access.
- **no promotion.** `role` is read in eight places and chosen once, at
  invitation. The access board printed it as text.
- **no granular overrides**, ADR 0201's finding: parsed and *applied* by
  `effectivePermissions`, writable by nothing.
- **no audit.** `'membership.update'` has been in `AuditAction` since Phase 3
  and nothing had ever written it — `'organization.update'`'s shape, unwritten
  until Phase 78.

`updateMembership` closes all four in one write, with four refusals. The one
worth naming is the invariant: **somebody must keep `company:manage`**,
asserted over the *effective* permissions of every active membership after the
change, so a demotion, a revocation of access and a `revoke` override all come
through one predicate. A rule written as *"is there another owner"* would be
wrong in the direction that locks a company out of its own books, because a
bookkeeper **granted** `company:manage` is an administrator — and that grant is
the seam §14 asks for.

Who may do it has one answer now: `users:manage`, which `inviteToCompany` and
`withdrawCompanyInvitation` moved onto from `company:manage`. Only `owner`
holds either today, so no role's behaviour changed; the seam did, and a company
can grant `users:manage` alone without the Studio, the module switches or the
billing. `company:manage` keeps the company's own arrangements, the engagement
with a practice included.

### §13, §14 — the account with no way back (Phase 211)

§13 claims payables and §14 claims inventory, and the seam between them is a
supplier's bill for goods. This phase measured what the application does when
somebody codes one.

`documentLineAccounts` offers a bill line every expense, cost of sale and asset
account, holding back four it names in a bare array, on a rule its docstring
states plainly: *"two kinds of account are held back even so, because coding a
line to one silently breaks an invariant something else is checking"*. Two
sentences earlier the same docstring says *"a supplier bill for a van
legitimately debits Fixed Assets, and one for stock debits Inventory, so assets
are offered"*.

Measured, with every account the bill side offers put on its own $1,000 bill
and all nineteen integrity checks run after each: **four of them raise a
fault** — `1250` breaks `payments.in_transit`, `1400` breaks `inventory.lots`,
`1450` breaks `manufacturing.wip`, `1500` breaks `assets.register`. The invoice
side breaks nothing, because it offers revenue only.

**One of the four is not a defect, and finding out which is the phase.**
Registering the asset closes `1500` — 0 against 4,000,000 becomes 4,000,000
against 4,000,000 — because a bill line *is* the intended way to capitalise
one; `registerAsset` posts nothing precisely so the truck is not on the balance
sheet twice. Stock has no adoption step: after a bill coded to `1400`,
receiving the same goods properly **doubles** the difference, because the
receipt posts its own debit.

So §14's subledger identity — Σ open lots equals the Inventory account — was
reachable from a dropdown, and the audit can now say the composer cannot reach
it. The class of accounts something else maintains is one register,
`coa/maintained.ts`, measured against `FALSIFIERS`: **fifteen accounts have a
fault-severity check watching them**, and the two lists that each described the
class for their own call site named four between them. Eight of the rest were
safe only because a bill line may not name a liability, which is a filter about
what a cost is rather than a protection, and that is now written down where
somebody widening the filter will see it.

One correction the audit should carry, because it is about this file's method
as much as the phase's. The measurement above asked what the **pickers** offer,
and the invoice picker offers revenue only, so the invoice side measured clean.
Nine modules raise documents with accounts they choose themselves and no picker
is involved in any of them — two of them raise a deposit invoice credited to the
retainer account, correctly, because money taken before the work is not revenue.
The register names that licence now. A guard measured against the dropdown it
backs is measured against the wrong thing, and the suite was the instrument that
could see it.

ADR 0210's nomination is answered in the other direction: `bill_lines.item_id`
had no writer, and the right place to record what arrived is the goods receipt
line, which has had one since Phase 14. The column had no reader either, so it
is dropped (`0104`) rather than filled — a picker there would have been a second
way to receive stock, which is the one thing §14's subledger cannot survive.

Dropping it moved two tree-wide censuses, and the audit should carry the second
of them because it is about this file's subject rather than the phase's. The
reference count between tenant-scoped tables falls to **294 and 39** from 295
and 40 — the first fall in that tally, in both figures. And the test asserting
`item_id` is a foreign key *"on both invoice and bill lines"* has been asserting
something true and empty: **Phase 169 keyed `bill_lines.item_id` and Phase 170
made that key composite so it could not name another tenant's item, over a
column nothing ever wrote.** A tenancy guarantee asserted over an unwritten
column is indistinguishable, from the test's side, from one that is doing work.
The assertion now measures every column in the schema that names a catalogue
item and requires a key on each, then names the twelve exactly.


### §19 — the switch the census could not see (Phase 210)

This file's §19 census passage said, from Phase 208, that *none of the 29
candidates is a finding*. That was true of what the scan could see and false of
the schema, and the gap between those two is this phase.

`writerCandidates` tests whether something **reads** a column by looking for
`tableVar.column` named outside the schema. A projectionless `select()`
compiles to `select *`: it reads every column of the table and names none of
them, and the row's columns are then reached as properties — `row.isActive`,
`profile?.country` — which carry no table to key on. The scan skipped such a
column *before* applying any exclusion, so it could never be a candidate
however unwritable it was. **Seventy-two columns had never been examined, and
sixteen of them are written by nothing.**

The audit's own earlier correction is the one worth recording. Phase 202
narrowed this register's exclusion for defaulted columns, closed the six
`isActive` switches that exposed, and said so here. The exclusion was never
what hid the rest; the shape of the query was. And Phase 203 found that exact
mechanism in the mirror direction, named the file, and wrote *"conservative in
the safe direction — a missed read loses a candidate"*. A missed read loses a
**finding**: the forward scan reports nothing rather than reporting carefully.

**What §19 can now say that it could not.** Of the thirty tables carrying an
`isActive`, twenty-four name it in a query and all twenty-four have a writer;
six never name it and five of those six had none. Those five are closed or
removed, and the census enforces the general case: with the read rule
corrected, any `isActive` that something reads and nothing writes becomes a
candidate and must be declared or fixed.

**What it does not close.** The insert-only class, measured under the same
correction, was **1169 columns** rather than 770 — the limitation §19 declares
is half again as large as this file has been saying since Phase 202, and
narrowing it still needs a way to say which columns are *state* rather than
*record*. (Phase 212 found one; see §5 below.) The sixteen findings are
declared, not fixed; the largest is `bill_lines.itemId`, which is Phase 169's
inventory gap on the purchase side.

### §5, §19 — the job that cannot be finished (Phase 212)

§5 claims job costing and §19 claims an audit trail, and this phase is about a
column neither of them could have told you was missing.

`projects.end_date` had no writer. ADR 0211 nominated it and argued the column
was worth **writing** rather than dropping, *"because the register's entry for
it names what reads it"* — and that entry said `jobs/reports.ts` *"reads the end
date into every date range it builds."* It does not. That file's one `endDate`
is a function parameter: a caller-supplied window for a ledger query, named the
same as the column and related to nothing. Measured, nothing in `src/` names
`projects.endDate`.

The audit should carry how that happened, because it is a failure mode of this
file's own method. Phase 210 taught the column scan that a projectionless
`select()` is a read, correctly, and uncovered seventy-two columns it had never
examined. The **first** register entry written after that correction then used
"it is read" as the argument for keeping a column no reader consults. A
correction to what a scan can see created a new way for prose about it to be
wrong, and no scan can catch that, because the scan agrees with the prose.

**What was waiting for an answer was `projects.status`:** four enum values,
written once at insert as the literal `'active'` that is also its default, so
one of the four was ever reachable. That is the kind of column §19's insert-only
limitation has been unable to name since Phase 202, and this phase supplies the
test it was missing — a column is **state** when its declared domain holds more
than one value, and **painted on** when every write of it is the same literal
and that literal is its default. Measured: **1,169 insert-only columns, 28 with
a domain of more than one value, 4 written only as literals, 1 painted on.** The
limitation is unchanged in size (1,168 now) and the question is no longer
unanswerable.

For §5 the finding is sharper than a missing writer. The three readers a
finished job should have were three different states of affairs: the WIP
schedule's filter **existed and had never been able to fire**; the timesheet
picker's **did not exist**, because `listProjects` selects the status and the
page maps it off the row one line before the dropdown; and the cost chokepoint's
**did not exist either**. And the WIP filter is a §13 matter rather than a
display one: `wipSummary` feeds the draft period-end entry against `1160`,
`2560` and `4200`, so a job closed while over-billed drops off the schedule and
nothing proposes the reversal. The audit can now say that completing a job does
not remove it from the schedule — being settled does — which is what a WIP
schedule does in practice.

For §19 the correction is `job` in the audit log's readable-types table.
`bookkeeper` holds `jobs:manage` and not `audit:view`, so the first audit event
this application ever wrote about a project would have been invisible to the
role most likely to have caused it. Phase 78's finding, on a different module,
and the other six job-costing types are still unplaced — nominated rather than
fixed one seventh at a time.

### §13 — the tax code nothing could reach (Phase 209)

§13 asks for sales tax support, and this audit has recorded it as built since
Phase 2: codes a company owns, tax priced per code, a breakdown frozen at the
rate as applied, and a return per jurisdiction. All of that exists and all of it
works. **Nothing in the application could put a code on an invoice.**

`taxLines` appeared nowhere under `src/app`, and the only writer of
`document_tax_lines` was `db/seed.ts`. The composer took sales tax as a single
typed figure, which credits 2200 Sales Tax Payable and records no breakdown — so
on every invoice the application itself raised, the ledger held the tax and the
return reported none of it. The page prints the variance between exactly those
two numbers.

**Why the audit missed it.** This section was checked bullet by bullet, and
every bullet was true of the core. The bullet-level pass asks whether the
capability exists, not whether a screen reaches it — and here the seed made even
that question look answered: the demo writes a breakdown through `createInvoice`'s
own API, so the page, the runbook step and the browser verification all showed a
working sales tax return. It is Phase 169's finding (`invoice_lines.item_id`,
complete since Phase 14, written only by a test) with demo data on top.

Worse, the module detected the gap and attributed it to the reader.
`hasUncodedSales` is `NOT EXISTS (document_tax_lines …)`, which is every invoice
raised through the composer, and the warning read *"usually a company that has
not set codes up yet; occasionally a real gap"*. ADR 0134's rule — an exclusion
that *excuses* a site is worse than one that misses it — in user-facing copy.

**What it closes:** a tax code per invoice line, priced by the server as the
lines are typed and shown per jurisdiction before anybody commits; a refusal
when a typed total and a breakdown disagree, where the precedence had silently
favoured the total; and `is_exempt`, which was read by no arithmetic anywhere, so
an exempt code at 8.25% charged 8.25%. An exempt code has no rate now.

**What it does not close:** a tax code cannot be retired from any screen — the
register has no control for it, so `activeOnly` can only ever hide a row set
outside the application. And `document_tax_lines.documentType` admits `'bill'`
and nothing writes it; §13 asks for sales tax and not purchase tax, so that is a
column the schema anticipates rather than a bullet left undone.

### §6, §19 — the supplier who is also a client (Phase 208)

§6 asks for *"unified contact/company records with lead, prospect, active
client, former client, vendor, or strategic-target status"* while §16 lists
Customer and Vendor as their own entities. The schema answers both by making
`organizations` the one party record and customer and vendor **accounting
roles** it plays: `customers.organizationId` and `vendors.organizationId` point
back at it, so *"a firm you both buy from and sell to is one organization with
two accounting roles, not two conflicting rows"*.

**The vendor half of that sentence was never writable.** `crm/conversion.ts`
writes the customer side when an opportunity is won. For a supplier there was
no path at all — `createVendor` has no such input, `updateVendor` has no such
field — so `engagement/filing.ts`, a module that exists entirely for the firm
that both buys and sells, could not serve the one case it was built for. A
remittance advice files on the supplier's record, correctly and deliberately,
and `columnsFor` carries the organisation along *"whenever the party has
one"* — which for a vendor was never.

**Why it took five ADRs.** The column was declared in ADRs 0201 through 0207
on the argument that the vendor correction screen is driven by `VENDOR_FIELDS`,
a registry of **text fields** whose three-way `kind` says what changing one
means, so a link to a CRM record would be a new *kind* of field and `diffParty`
would print a uuid into the audit trail.

Both halves of that are true and the conclusion does not follow. **The customer
side is not a field either** — `CUSTOMER_FIELDS` has no `organizationId` entry,
and the link is written by winning an opportunity. And the people board already
carries a non-text act beside the correction form: `mergeParties`, which takes
two record ids, previews what would move, refuses a blank reason and writes both
sides' history. So `setVendorOrganization` is an act of that kind,
`VENDOR_FIELDS` learns nothing, and the audit entry carries the organisation's
**name**.

Four refusals, each from something the code already does: an unknown vendor or
client; a supplier already linked **elsewhere** (repointing would leave letters
already filed against the wrong client, so the link is taken away on purpose
first); and a client already linked to another supplier, which would split that
client's payables the way Phase 45 found two customer rows splitting a client's
aging. The undo ships in the same phase on Phase 206's rule: a writer that only
moves one way is invisible to both censuses and looks identical to a working
control until somebody wants it back.

**It does not set `lifecycleStage` to `'vendor'`.** A lifecycle stage holds one
value, so writing `'vendor'` over `'active_client'` would delete the more
important half of the fact being recorded. That a single stage cannot say
"both" is the reason the link column exists, and `'vendor'` as a stage is left
as the one §6 lists.

**What this closes:** the column census's last finding. 29 candidates, none of
them a finding.

### §4, §13 — a name is not a function (Phase 207)

ADR 0206 nominated *"`listFinancialAccounts`' nine flagless callers"*, since a
financial account is a **bank account** and offering a retired one is offering
to move money through something the business has closed.

**There are two exported functions with that name.** `banking/sync.ts` takes
no option and always filters on `isActive` — five screens import it and were
correct all along. `banking/accounts.ts` took `activeOnly` opt-in with a
different return shape — four callers. The count was wrong because it was
taken by name, which is Phases 196–198's lesson about scans applied to a grep:
a name is a claim about what code does, and the same claim was attached to two
bodies. The sync one is `pickableFinancialAccounts` now.

**One live defect** among the four real callers: the refund picker on the
payments board was built from every account the company had ever had.

Flipping the default to live-only was safe **only because the callers were
read first**. Two would have broken: `cashTieOut`, which ties each account's
feed to the ledger and must keep seeing a closed account that still carries a
balance, and `settings/accounts`, which carries the Reopen control and would
have lost closed accounts from the one screen that can restore them — Phase
206's defect reintroduced by Phase 207's own flip. A third break was caught by
an existing test whose two calls a blanket rewrite made identical.

**Still open:** four functions with the opt-in default, and `listAccounts`
keeping its deliberately because two of its callers need the whole chart.

### §15, §13 — a retirement with no way back (Phase 206)

Two findings, neither of them the one nominated.

**`deactivateServiceItem` wrote in one direction.** It has existed since Phase
4, set `isActive` to false only, and audited nothing — so a catalogue item
retired by mistake was gone from every picker for ever, and it was the one of
the Studio's four libraries whose retirement left no trace. **No census asks
about this shape**: a column with a one-directional writer is read *and*
written, so it is invisible both to the reader-and-no-writer census of Phases
201–205 and to the mirror Phase 203 measured and declined. It looks identical
to a working control until somebody wants to undo it.

**Four pickers were offering retired chart accounts.** `listServiceItems` is
one of **seven** list functions with the `activeOnly` opt-in default, and
`listAccounts` had four callers feeding a `<select>` with no flag: the till
pay-out's *"Where it lands"*, the takings categories, the budget lines and the
recurring-billing revenue account. `account.retire` has claimed since Phase
118 that retiring *"takes it out of every picker"* — **false for four of them
for eighty-eight phases**, and the reason is in the same sentence, because an
opt-in flag makes that a claim about what callers remember. Fixed, and the
docstring keeps its wording with the correction attached (Phase 185).

Not filtered everywhere: `dimensions` builds a name lookup so a posting on a
retired account still reads with its name, and the §19 export carries the
whole chart. *Offering* against *displaying*.

The nomination's own two premises measured false — no screen was offering
retired items, and retiring an item with stock hides nothing because
`stockOnHand` filters on `isInventoried` rather than `isActive`. So did ADR
0205's reason for declining the default flip: four callers, not five, and no
behaviour change.

**Still open and declared:** six functions with the opt-in default, of which
`listFinancialAccounts` has nine flagless callers and is the sharpest, since a
financial account is a bank account.

### §7, §15, §5 — offered, and not offered (Phase 205)

The last two of the six `isActive` columns Phase 202 found, and **all six are
closed**. Reading each reader had split them into *enforced* — a refusal
already written, so the whole gap was the writer — and *projections only*,
selected to be displayed and filtered by nothing, where a writer alone would
have been a control with no effect. The three enforced ones went first.

ADR 0204 said *filter first*, which was right and incomplete. The two need the
filter in **different places**, and the reason is copying against referencing.

A clause is **copied** into a document as a `clauseVersionId` — *"what a client
was shown must not"* change — so retiring one is invisible to every proposal
ever sent and not offering it is the whole job. ADR 0021 is satisfied by the
schema rather than by a rule, and `listClauses` filters with the option as
`includeRetired` **opt-out**, because three screens read that list and two of
them *offer* clauses for a document.

A work order **references** its recipe for the life of the run, so filtering
the read would cost a half-built batch the recipe it was costed against. The
recipe stays readable and `createWorkOrder` refuses to **start** a run against a
superseded one — in the service rather than only the picker, since a rule that
holds on the one screen that remembered to filter is not the rule. That also
closed something nobody had asked about: **nothing validated `bomId` at all**,
the composite foreign key having been doing the existence and tenant checks.

The column census now declares **one finding**, `vendors.organizationId`. The
other twenty-nine entries are columns something writes in a way no pattern
sees, which is what the register was built to hold.

### §14 — the access that disappeared quietly (Phase 204)

Phase 202 closed §14's granular grants, role changes and revocation. **The
practice side still had three holes**, and all three are the same hole: a firm
can remove a client's access and the client's audit log did not say so.

- `endEngagement` wrote its event only `if (party.side === 'client')`, so the
  accountant walking away — taking every membership the engagement granted —
  was never recorded.
- `removePracticeMember` deletes the memberships that person held at *every*
  client of the firm and audited nothing, on either side.
- Closing a practice would have been a third; it refuses while engagements are
  live instead.

§14 asks for an audit log of **permission** changes, and losing your
accountant's access is one. It was never a decision: `recordAudit` needs a
company and the practice side has none of its own. But `companyId`, the member
and the firm are all on the engagement, and `ActorContext.viaPractice` was
built for exactly this line — its own comment says a client should not have to
cross-reference a user list to learn that whoever reopened December works for
their accountants. `practiceActorContext` resolves it; the removal writes one
event per client, because an event filed against one of twelve companies is
eleven companies with no record.

**Not auditable, and declared:** a practice-side action that touches no
client's books. Creating a firm, adding a member, closing one. There is no
tenant whose log they belong in, and filing them against an arbitrary company
would be worse than not filing them.

The two columns the census asked for are closed with them.
`cash_drawers.isActive` needed no decision about the float, which ADR 0203
expected it to — `closeShift` already counts the cash, so the refusal is only
that the shift must be closed first. `practices.isActive` is refused while any
engagement is live, because a closed firm holding somebody's books is an
outside party with nothing to answer for it.

Of the six switches Phase 202 found, the **three enforced** ones are now
closed and the **two projection-only** ones remain — a distinction that only
exists because two of Phase 202's own register entries were wrong as drafted
and reading the call sites corrected them.

### §5 — where a gift card's money went (Phase 203)

`gift_cards.isActive` was one of six switches nothing could turn off, and the
one where the thing nobody could switch off is **money**: `redeemGiftCard`
refuses an inactive card by name and no path could set the flag.

Measuring it found the nomination was the second half of a screen with no first
half — **there was no list of gift cards anywhere.** Four totals, an insert,
and a card's own code and balance visible only in the §19 portability export.

The phase's claim is a refusal. A card holds a liability on 2590 and
`giftCardPosition` reconciles the sum of card balances against that account
separately, so stopping a card with a balance on it has three dishonest answers
— leave the balance (a liability nobody can settle, and the check still
agrees), zero it and post nothing (the check cries wolf on a deliberate
change), or zero it and pick the account silently. `closeGiftCard` therefore
refuses unless the caller says where the money went: **refunded** (credit the
account the card was sold into) or **written off** (credit income, refused
unless the account *is* income). ADR 0029 stands — nothing sweeps, ages or
expires, and a write-off is one card decided by name with the decision in the
audit trail.

A lost card is **reprinted** rather than destroyed: `reissueGiftCard` changes
the code and posts nothing, because one card with a new number is what a
business means, and selling a replacement would post a sale that never
happened.

Two columns were waiting. `depositAccountId` was **written and read by
nothing** — Phase 49's shape mirrored, invisible to the column census because
that census asks the opposite question — and `code` was insert-only, one of the
769.

The census's mirror was measured and **declined**: *"named outside the schema"*
is an inclusion test for reads and becomes an exclusion test when inverted, and
one `.select()` with no projection reads every column of a table while naming
none. The mirror reports **683 columns**, which is the size of the error rather
than a finding.

### §20 — all fifty-one deliverables, measured (Phase 199)

This row read *"Phases 0–8 all have shipped work"* from Phase 164 to Phase
199, and it was **the last unmeasured sentence in this file**. ADR 0194 named
it; Phases 195, 196, 197 and 198 each put something ahead of it. Four
deferrals.

It was also the weakest reading of §20 available. *"Has shipped work"* is true
of a phase if **anything** in it shipped, and §20 is a table of nine cells each
listing several deliverables — the same shape in which Phase 195 found §11 had
seven of seven *rows* and twenty-five of thirty-three *functions*.

Counted per deliverable there are **fifty-one**, and all fifty-one are built:

| phase | deliverables |
| --- | --- |
| 0 — Foundation | 8 |
| 1 — Bookkeeping MVP | 8 |
| 2 — Reconciliation + Accounting Core | 6 |
| 3 — CRM + Proposal Pipeline | 6 |
| 4 — Proposal Designer + Company Studio | 7 |
| 5 — Marketing | 6 |
| 6 — AI Add-on | 6 |
| 7 — Industry Modules | 2 |
| 8 — Payroll/Tax/Advanced | 2 |
| **total** | **51** |

So the sentence holds in its strong reading as well as its weak one. That is a
result rather than a formality — the alternative was to go on deferring §20 on
the strength of nobody having looked.

`PHASE_DELIVERABLES` is what replaces the sentence. Each entry carries §20's
own words, the files that ship it, and an argument for why those files are that
deliverable; a test holds the keys to §20's wording, asserts that **no word of
any cell is unaccounted for**, and checks all sixty-nine paths exist. ADR 0194
said this file could not be made self-measuring because *"all 12 have a module"
is a judgement* — right about integers, and the way round it is to write the
judgement down once and check everything around it.

Three Phase 0 entries ship no code and say so: *repository audit*,
*architecture* and *database conventions* are acts whose product is a decision,
and their evidence is the document that records it.

> **Two things the measurement found, neither of them a missing deliverable.**
>
> `modules/mobile/operations.ts` hardcoded `rememberVendor: false` on the
> offline queue — correctly, since rule creation writes outside the operation's
> transaction and `categorization_rules` has no uniqueness constraint — and
> excused it with *"the phone offers the checkbox only when online"*. That was
> **false**: the mobile review deck always goes through the outbox, so the
> phone has never offered vendor memory at all. A sentence justifying a
> hardcoded value by describing a UI that does not exist, which is ADR 0134's
> rule in a comment rather than a register. Recorded as a decision now, with a
> test that asserts the flag is dropped even when the payload sets it.
>
> And the register's own first draft named four files that do not exist —
> `modules/tax`, `ai/layout.ts`, `brand/brand.ts`,
> `db/schema/bookkeeping.ts` — every one written from what I expected the tree
> to look like. Sales tax lives under `payroll/`, which that entry now says out
> loud. The path check caught all four on its first run, which is the argument
> for naming files rather than describing them.

## The bullet-level pass of §12–§19 (Phase 194)

> ADR 0193 nominated this file. The Phase 173 pass below covered **§1–§11
> only**; §12 onward had never been measured below the section heading, and
> this file's own closing claim is that *"the other sections hold up"*, with
> §12–§18 said to *"would likely find more"*. Three §7 rows re-opened since
> had each turned out wrong, so the question was whether the rest did too.

**It largely holds.** Measured bullet by bullet, §13's eleven are built —
fixed assets and depreciation included, although §13 makes them optional;
§14's roles and six requirements have `user_mfa`, `sessions`, `devices`,
`login_attempts`, `audit_events` and practice mode behind them; §15's five are
`service_items`, `clauses`, `team_members` and the brand kit; §16's
thirty-four entities all resolve (`Project/Job` is `projects`, `Lead` is
`lead_submissions`, `MarketingEvent` is `campaign_events`); §18's seven
include a real outbox (`modules/worker/outbox.ts`, `domain_events`,
`relayPendingEvents`) and server-side PDF; §19's nine are in place.

Three things came out of it.

| | finding |
| --- | --- |
| §12 | **Tool/function layer — nothing.** No tool registry, no `tool_use`, no `tool_choice`. Recorded as a **decision** rather than a gap: every consequential AI action in this application goes through a suggestion a human applies, which is *more* restrictive than the bullet asks and is what §12's own next bullet requires. Building tool-calling would add a path around the approval gate. |
| §12 | **"Caching where safe" is not achievable with these prompts**, and `cachedInputTokens` correctly reads zero. Caching needs a stable prefix of at least 1024 tokens on this model family; every system prompt is 230–631. A `cache_control` would have cached nothing — the no-op was nearly written. A test now fails if a prompt grows past the threshold. |
| §16 | **181 tables → 185.** The only number in this file that had moved, now pinned in `PINNED_CLAIMS` so it cannot move again unnoticed. |

One modelling choice to record alongside §16's three, so nobody counts it as a
gap: **§17's "Reporting/Analytics Service" has no module of its own.** Sales
analytics is `crm/analytics.ts` and the financial reports are `ledger/*` —
reporting sits inside the domain that owns the data, which is defensible and
arguably better than a reporting service reaching into everything.

So the sentence this pass was sent to test — *"the other sections hold up"* —
is **true**, and is now true by measurement rather than by assertion. The
prediction beside it, that §12–§18 *"would likely find more"*, was wrong: it
found less than §7 did, which is the opposite of what twenty phases of
re-measurement had taught this process to expect.

## The bullet-level pass (Phase 173)

> The section below predicted that a bullet-level pass "would likely find more".
> It did: **eight capabilities with nothing behind them, and two adjacent
> findings**, all but one of them in §7 and §8 — the design engine, which this
> audit had marked as the largest unbuilt piece without saying which parts.

### Verified complete, bullet by bullet

- **§3 Daily Bookkeeping** — all 13. The seven review states exist in the
  spec's own order (`new, suggested, needs_review, categorized, matched,
  excluded, reconciled`); rules test five fields and **combine** them through
  `matchType: 'all' | 'any'` over a `conditions[]` array, which is more than the
  bullet asks; `undoLast`, `bulkCategorize`, splits, transfers, invoice
  matching and attachments all exist.
- **§4 Reconciliation** — all 6, including the controlled reopen, which is
  behind its own `reconciliation:reopen` permission rather than bundled with
  completion.
- **§10 Marketing & Prospecting** — all 6. `SEGMENT_FIELDS` covers every
  dimension the first bullet names, with a `segments` row serving as the "saved
  filter".
- **§16 Core Data Model** — 33 of the 35 named entities are tables. `Role` and
  `Permission` are code constants in `modules/permissions`, and `AIUsage` is
  served by `ai_requests`, which §12 calls the usage ledger. Those are modelling
  choices rather than gaps, and are recorded so nobody counts them twice.
- **§17 Service Boundaries** — all 12 have a module.

### Eight capabilities with nothing behind them

| § | capability | measured |
| --- | --- | --- |
| 7 | ~~**Comments/questions on the client link**~~ | **Built in Phase 174**, and this row was stale from that day — three later ADRs carried it forward as a nomination without re-measuring. Phase 188 measured §7's whole bullet instead and found four of its five items built; see below. |
| 7 | ~~**Generic `table` block**~~ | **Built in Phase 181.** A `table` block with an optional header, up to six columns, per-column alignment and three border styles, rendered on all eight surfaces. Writing it found that three block types had never reached one of them — see ADR 0181. |
| 7 | ~~**Crop/mask on images**~~ | **Built in Phase 186**, two phases after it was nominated: Phase 185 had to put pictures in the PDF first. A crop is fractions of the source with one shared `normalizeCrop`, a mask is a circle or a rounded corner, and neither resamples anything. It needed `assets.width`/`assets.height` — in the schema since Phase 4 with no writer and no reader — because a crop is not expressible in CSS without the source's aspect ratio. See ADR 0186. |
| 7 | ~~**SVG import/export**~~ | **The import half built in Phase 190**, and the row was true when written — but not through neglect. SVG was refused in three places with a correct argument (*it can carry script, and these files are served back to browsers*), and §7's own qualifier is *where practical*. What makes it practical is that the subset worth importing is tiny: an allowlist of eleven elements that is **both** the security boundary and the printable subset, so what is stored is a document the module rewrote and what the PDF draws is the same function's reading of it. Export is not built and is a different question — see ADR 0190. |
| 7 | **Artboard affordances** (partly) | **Measured item by item in Phase 191, and this row both understated the capability and overstated the gap.** §7's bullet lists **twelve** things; this row named ten. Two were already built and it named neither — the page system itself and multiple page sizes, since Phase 4. Five of the rest are properties of a vector canvas: guides, rulers, snapping, grids and object distribution, all of which **ADR 0004 decided against by name** (*"A block document engine, not a vector canvas"*), from §7's own instruction and with `canvas` named as the block type to add when they are wanted — a recorded decision with an extension point, re-read in Phase 191 rather than quoted. `lock/hide` **was built in Phase 191** and **undo/redo in Phase 192**, and layers is answered: the block list is the ordered object list and now carries visibility. What is genuinely left is zoom and grouping, both named with their costs in ADR 0191. Measuring undo/redo also found that the application had not built since Phase 183 and that the designer was ignoring every server write — see ADR 0192. |
| 7 | ~~**Vector primitives**~~ | **Built in Phase 193**, and this row named **ten** of §7's **thirteen** — omitting `text`, `opacity` and `reusable components`, two of which were already built. It was also measuring the wrong thing: since Phase 190 `pdf/vector.ts` has drawn rectangles, ellipses, lines, paths, fills, strokes, corner radii and transforms, and the page renders the same markup, so the gap was never a renderer — it was a way to **place** one without uploading a file. A `shape` block holds parameters and one generator turns them into SVG inside the subset both surfaces already draw, so there is no second renderer to disagree. Colour is a brand role rather than a hex, because no block in this engine carries a colour. Gradients, shadows, opacity, arbitrary paths and rotation remain, each refused with a reason — see ADR 0193. |
| 7 | ~~**`deliverables` and `assumptions`**~~ | **Built in Phase 182**, and the measurement here understated it: of the ten said to have a home, **four had a column that nothing rendered** — `executive_summary`, `scope`, `exclusions` and `terms` were written, snapshotted into versions, and reached no document. All six narrative sections are merge fields now, and `PROPOSAL_COMPONENTS` makes "has a home" mean "a client can read it". See ADR 0182. |
| 8 | ~~**Asset association**~~ | **Built in Phase 180.** `asset_links` carries all five, each by a composite key holding the tenant rather than the polymorphic `subject_type` `document_links` used — see ADR 0180 for why the precedent was not followed, and ADR 0184 for `document_links` being converted too. Four of the five kinds have no attach control yet. |
| 15 | ~~**Team bios**~~ | **Built in Phase 183.** A `team_members` table — not a `jsonb` array beside `credentials`, because a document has to *point at* one person and a reference into an array has no key — plus a `team` block that holds ids and a Design Center screen that writes bios. Retired rather than deleted, so a proposal sent last year still names who was going to do the work. See ADR 0183. |

**All nine rows are now struck through**, the last of them in Phase 193.
Three were not what they said: the comments/questions row was stale by
fourteen phases, the artboard row listed ten features of which two were built
and five had been decided against by name in ADR 0004, and the vector row
listed ten of thirteen and most of them were already drawable. The rows that
were measured again were the rows that turned out to be wrong — which is an
argument for re-measuring this file rather than a reason to call it finished.

What follows is the history, left as it was written.

That is nine rows for eight capabilities plus one, because the two §7 vector
rows are one piece of work. **Seven are struck through: asset association
(Phase 180), the generic table block (Phase 181), `deliverables`/`assumptions`
(Phase 182), team bios (Phase 183), crop/mask (Phase 186), the client-link
comment thread (Phase 174, recorded in Phase 188), and SVG import (Phase
190).** *(Later: artboard affordances in Phase 191 and 192, vector primitives
in Phase 193 — see the note above this paragraph.)*

SVG was struck through with a qualifier rather than outright: §7 says
*import/export* and Phase 190 built import. The export half is recorded in ADR
0190 as a different question with a different answer, not as a remainder of
this one.

**Artboard affordances is the row this audit got least right**, and Phase 191
says how: a list of ten features in one cell, of which two were already built
and five had been decided against by name in ADR 0004 three years of phases
earlier. The row is not struck through, because `undo/redo`, zoom and grouping
remain — but it is no longer a capability with "nothing behind it", and the
reason it read that way is the reason Phase 188 gives for the
comments/questions row: a bullet measured as one thing is a bullet nobody has
measured.

One §7 item was unbuilt and never had a row here, because this audit took the
bullet as one capability: **version history on the client link**. Phase 188
measured the bullet item by item and found it the only one of five missing;
**Phase 189 built it**, with the rule that a client may re-read a version they
demonstrably opened — evidence from `proposal_views` rather than a policy
somebody has to defend. All five items of that bullet are now built.

Phase 185 is not a row here and was the largest of them: **the PDF contained no
images at all**, which this audit never asked about because §7 does not say
*"the PDF should contain the pictures"* and the renderer declared the limit in
its own docstring.

**A row that was wrong, and what finding out cost.** The comments/questions
row above was struck through in Phase 188 — by Phase 174. Nobody re-measured it
for fourteen phases, and ADRs 0185, 0186 and 0187 each repeated it in a
nomination list. Phase 164's rule is in this file and was not applied to this
file: a nomination inherited is a nomination unmeasured.

Measuring §7's client-link bullet properly then found what no row here names:
the page served **live** figures, so a sent proposal could be edited and the
client would sign for a number nobody had sent them. An audit that asks "does
this capability exist" cannot see a capability that exists and is wrong, which
is the same blind spot Phase 185 is recorded under below — twice now in four
phases, which makes it the method's limit rather than an accident.

**Phase 187 is the one row this audit could never have.** It moved two source
scanners out of test files so a sentence quoting their numbers could be
checked, and it found that the two files' shared helper had drifted and that
one copy was wrong. Nothing in the specification asks for any of it. The audit
measures what §-numbers name against what exists; it has no column for *the
mechanism that keeps the other measurements honest*.

**And what Phase 185 found, which is the same blind spot from the other side.**
The nominated row below said crop and mask were missing, and they were. It did
not say that the PDF drew no pictures of any kind — not the logo, not a
photograph, not a face — because this audit asks what the specification names
and §7 does not name *"the PDF should contain the images"*. The gap was also
**declared** in the renderer's own docstring, which is the form a defect takes
when nobody re-reads a limitation after its reason expires.

**What Phase 184 found that this audit cannot look for.** The nominated work —
converting `document_links` away from a keyless polymorphic reference — was a
schema-shape job with no §-number. Doing it found that discarding a draft
journal entry left an unanswerable question on an accountant's work list
forever, that `tests/party-merge.test.ts` had been failing since Phase 180, and
that **merging two records of one business had never moved their evidence**, in
any phase, because the reference the merge needed to see had no foreign key to
see it by. None of the three is a missing capability. This audit measures what
the specification asks for against what exists; it has no column for *works, and
wrongly*.

**The correction of Phase 182, confirmed again in Phase 183.** `team bios` was
measured here as having *nothing* behind it, and that was right. But the
`professional-engagement` template's own description read *"Approach,
deliverables, team, fees, and terms"* and had no team section of any kind — a
sentence shipped to users with nothing behind it, which this audit does not
look for at all. Nor did it find that `isolation-guards.test.ts` had never
counted four tenant writes, including the one that moves every opportunity in
the system. Both were found by doing the nominated work, not by auditing.

**A correction to this audit's method, from Phase 182.** The
`deliverables`/`assumptions` row said *"10 of the 12 components have a dedicated
block or column"*, and checking the other ten found four with a column and no
reader. "Has a column" is not the same claim as "reaches the client", and this
audit checked the first one throughout. Where a row below says a capability
exists because a column or a table exists, that is the weaker reading.

**On §7's own deferral.** The section ends: *"advanced Illustrator-class path
editing can be phased in after the core proposal workflow is stable."* That
sentence defers **path editing** and nothing else — it does not defer guides,
rulers, snapping, layers, zoom or undo/redo, which are layout affordances rather
than vector authoring. Reading it as deferring the whole of bullets 1 and 2 is
the generous reading and is not what it says.

### Two adjacent findings

- **§3: `bank_transactions.provider_category` is imported and not rule-testable.**
  The feed records the bank's own category and `RULE_FIELDS` omits it, so the
  single most useful field for a rule after the merchant name cannot be tested.
  Not strictly a §3 gap — the bullet names five fields and all five exist — but
  it is the gap a user would hit first.
- **§3: "bulk rule creation" is satisfied on one reading only.**
  `createRule({ applyToExisting: true })` creates a rule and applies it to the
  existing inbox in bulk, which is the useful capability. Creating *several
  rules* in one action does not exist. The bullet's parallel with "bulk
  categorization" suggests the second reading; the first is what anybody wants.

## What this audit is not

It is not bullet-level for every section. §13 was checked bullet by bullet
because it is the accounting core; §9, §11 and §19 because they contain
enumerable lists; **§3–§8, §10 and §15–§17 by Phase 173.** §12, §14 and §18
remain module-level, as do §1, §2 and §19–§24.

The sections marked **done** were verified at module level — the module exists,
is exported, and has test files behind it — which is weaker than reading every
bullet, and is said here rather than implied.

The four gaps in §9 and two in §11 were therefore a floor, not a ceiling, and
Phase 173 found eight more.

## Nominations this produces

Grounded in measurement rather than in reasoning about behaviour, which is the
point of having done it:

1. ~~**The two missing AI capabilities** (§11), Design Assistant first, because it
   is the larger and because its provenance requirement is a data decision that
   should be made before the prompt.~~ **Done: Phases 165–167.** The ordering was
   right for the stated reason and wrong about which was larger — see the note
   under §11.
2. ~~**§9's four analytics gaps**, which are one small phase: two derived figures,
   one new recorded fact (sent→decided), and two more `breakdownBy` dimensions.~~
   **Done: Phase 168.** Not one small phase, and not that shape: the "new
   recorded fact" already existed, and one of the "re-groupings" needed a column
   and a screen. See the note under §9.
3. **A bullet-level pass** over the sections this audit verified only at module
   level, which is where the honest unknowns are.

The row-level-security arc keeps its own nominations from ADR 0163 — a principal
per kind of authority, then the ~397 web boundaries — but after four consecutive
phases in one arc, and three corrected nominations inside it, the measured
backlog above is the better next move.
