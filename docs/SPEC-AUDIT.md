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
the database layer is installed, forced on 165 tables, proven against a restricted role, and **not
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
| 7 | ~~**Comments/questions on the client link**~~ | **Built in Phase 174**, and this row was stale from that day — three later ADRs carried it forward as a nomination without re-measuring. Phase 188 measured §7's whole bullet instead and found four of its five items built; see below. |
| 7 | ~~**Generic `table` block**~~ | **Built in Phase 181.** A `table` block with an optional header, up to six columns, per-column alignment and three border styles, rendered on all eight surfaces. Writing it found that three block types had never reached one of them — see ADR 0181. |
| 7 | ~~**Crop/mask on images**~~ | **Built in Phase 186**, two phases after it was nominated: Phase 185 had to put pictures in the PDF first. A crop is fractions of the source with one shared `normalizeCrop`, a mask is a circle or a rounded corner, and neither resamples anything. It needed `assets.width`/`assets.height` — in the schema since Phase 4 with no writer and no reader — because a crop is not expressible in CSS without the source's aspect ratio. See ADR 0186. |
| 7 | ~~**SVG import/export**~~ | **The import half built in Phase 190**, and the row was true when written — but not through neglect. SVG was refused in three places with a correct argument (*it can carry script, and these files are served back to browsers*), and §7's own qualifier is *where practical*. What makes it practical is that the subset worth importing is tiny: an allowlist of eleven elements that is **both** the security boundary and the printable subset, so what is stored is a document the module rewrote and what the PDF draws is the same function's reading of it. Export is not built and is a different question — see ADR 0190. |
| 7 | **Artboard affordances** (partly) | **Measured item by item in Phase 191, and this row both understated the capability and overstated the gap.** §7's bullet lists **twelve** things; this row named ten. Two were already built and it named neither — the page system itself and multiple page sizes, since Phase 4. Five of the rest are properties of a vector canvas: guides, rulers, snapping, grids and object distribution, all of which **ADR 0004 decided against by name** (*"A block document engine, not a vector canvas"*), from §7's own instruction and with `canvas` named as the block type to add when they are wanted — a recorded decision with an extension point, re-read in Phase 191 rather than quoted. `lock/hide` **was built in Phase 191**, and layers is answered: the block list is the ordered object list and now carries visibility. What is genuinely left is **undo/redo**, plus zoom and grouping. See ADR 0191. |
| 7 | **Vector primitives** | No lines, rectangles, ellipses, paths, fills, strokes, gradients, shadows, corner controls or transforms. The engine is 18 block types. |
| 7 | ~~**`deliverables` and `assumptions`**~~ | **Built in Phase 182**, and the measurement here understated it: of the ten said to have a home, **four had a column that nothing rendered** — `executive_summary`, `scope`, `exclusions` and `terms` were written, snapshotted into versions, and reached no document. All six narrative sections are merge fields now, and `PROPOSAL_COMPONENTS` makes "has a home" mean "a client can read it". See ADR 0182. |
| 8 | ~~**Asset association**~~ | **Built in Phase 180.** `asset_links` carries all five, each by a composite key holding the tenant rather than the polymorphic `subject_type` `document_links` used — see ADR 0180 for why the precedent was not followed, and ADR 0184 for `document_links` being converted too. Four of the five kinds have no attach control yet. |
| 15 | ~~**Team bios**~~ | **Built in Phase 183.** A `team_members` table — not a `jsonb` array beside `credentials`, because a document has to *point at* one person and a reference into an array has no key — plus a `team` block that holds ids and a Design Center screen that writes bios. Retired rather than deleted, so a proposal sent last year still names who was going to do the work. See ADR 0183. |

That is nine rows for eight capabilities plus one, because the two §7 vector
rows are one piece of work. **Seven are struck through: asset association
(Phase 180), the generic table block (Phase 181), `deliverables`/`assumptions`
(Phase 182), team bios (Phase 183), crop/mask (Phase 186), the client-link
comment thread (Phase 174, recorded in Phase 188), and SVG import (Phase
190).** Two capabilities remain — artboard affordances and vector primitives —
and both are the Illustrator-class work §7 itself defers.

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
