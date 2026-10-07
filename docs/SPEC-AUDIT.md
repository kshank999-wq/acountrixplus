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
| 9 | Proposal Analytics & Sales Dashboard | **four gaps** — below |
| 10 | Marketing & Strategic Prospecting | **done** — `modules/marketing/segments`, `campaigns` |
| 11 | Optional AI Module | **five of seven** — below |
| 12 | AI Technical Architecture | **done** — `modules/ai/gateway`, metering, provider registry |
| 13 | Professional Accounting Workspace | **done** — every bullet, checked individually |
| 14 | Roles, Permissions & Accountant Access | **done** — `modules/permissions`, `modules/practice` |
| 15 | Company Studio / Brand Profile | **done** — `modules/brand` |
| 16 | Core Data Model | **done** — 181 tables |
| 17 | Recommended Service Boundaries | **done** — modular monolith, `src/modules/<domain>` |
| 18 | Technology Direction | **done** |
| 19 | Security & Financial Integrity | **one partial** — below |
| 20 | Development Phases | Phases 0–8 all have shipped work |
| 21–24 | Assignments, DoD, rules, next steps | — process |

### §9 — the four real gaps (all four built in Phase 168)

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

### §11 — seven of seven AI capabilities (was five)

`BUILT_IN_PROMPTS` holds ten prompts covering all seven of §11's rows. It held eight
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

### §19 — one partial

Nine of ten bullets are done: encryption (`modules/auth/secret-box`), tokenized
bank connections, idempotent imports (`idempotency_keys`), complete auditability
(`audit_events`), backups and a **tested** restore procedure
(`scripts/backup.sh`, `scripts/verify-restore.sh`), exportability (§19's own
portability export plus Phase 158's accountant exporter), privacy and
suppression (`modules/crm/intake`, `modules/notify`), and security review gating.

**Strong tenant isolation** is the partial, and it is partial in a precise way
rather than vaguely: the application layer is complete and measured — 111 writes
and 911 reads, every one guarded (Phases 149–150, counted again in 179) — and
the database layer is installed, forced on 162 tables, proven against a restricted role, and **not
switched on**, because the application connects as a superuser that owns the
tables. `RLS_ROLLOUT` carries the detail; `rlsStands` refuses to report
otherwise.

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
| 7 | **Comments/questions on the client link** | No table, column or module. The link tracks views and takes an acceptance; a client cannot ask a question through it. |
| 7 | **Generic `table` block** | §7 names *"tables, pricing tables"* as two things. `pricingTable` exists; a plain table does not, so a specification table in a proposal has to be built from `keyValue` rows. |
| 7 | **Crop/mask on images** | Nothing. An image block places a whole asset. |
| 7 | **SVG import/export** | Nothing for designs. The only SVG in the codebase is QR output. |
| 7 | **Artboard affordances** | No guides, rulers, snapping, grids, zoom, layers, grouping, align/distribute, lock/hide, or designer undo/redo. `undoLast` is bookkeeping's. |
| 7 | **Vector primitives** | No lines, rectangles, ellipses, paths, fills, strokes, gradients, shadows, corner controls or transforms. The engine is 16 block types. |
| 7 | **`deliverables` and `assumptions`** | 10 of the 12 components §7 names have a dedicated block or column; these two have neither and would be typed into a `text` or `list` block. |
| 8 | **Asset association** | §8: *"Assets can be associated with campaigns, contacts, companies, opportunities, or client records."* `assets` carries none of those columns. |
| 15 | **Team bios** | Nothing. `company_profiles.credentials` covers licences, certifications and insurance; bios have no home. |

That is nine rows for eight capabilities plus one, because the two §7 vector
rows are one piece of work.

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
