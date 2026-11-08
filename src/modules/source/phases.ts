import { RegistryError } from '@/modules/errors/registry'

/**
 * What each of §20's development phases shipped (Phase 199).
 *
 * ## The sentence this exists to measure
 *
 * `docs/SPEC-AUDIT.md` has said since Phase 164 that §20's state is *"Phases
 * 0–8 all have shipped work"*. It is the **last unmeasured sentence in the
 * file** — ADR 0194 named it, and ADRs 0195, 0196, 0197 and 0198 each put
 * something ahead of it. Four deferrals is long enough that the fifth would be
 * a habit.
 *
 * It is also the weakest reading of §20 available. *"Has shipped work"* is
 * true of a phase if **anything** in it shipped, and §20 is a table of nine
 * cells each listing several deliverables — the same shape as §11, where Phase
 * 195 found seven of seven *rows* and twenty-five of thirty-three
 * *functions*.
 *
 * So this register counts the deliverables: **51 of them**, each naming where
 * it shipped. Measured that way the sentence holds in its strong reading too,
 * which is a result rather than a formality — Phase 194 made the point when
 * its own hypothesis came out wrong: *"A measurement that confirms is still a
 * measurement; the alternative was to keep nominating against it on a
 * suspicion nobody had checked."*
 *
 * ## Why the evidence is a path and not a sentence
 *
 * ADR 0194 said this file could not be made self-measuring, because *"all 12
 * have a module" is a judgement about what counts as a module, and
 * `PINNED_CLAIMS` measures integers*. That is right about integers and wrong
 * about judgements: the judgement can be **written down once** and then
 * checked, which is what `PROPOSAL_COMPONENTS` does to §7 and this does to
 * §20. Each entry names files, and a test asserts they exist — so a deliverable
 * whose module is deleted or renamed fails here rather than going quietly
 * untrue.
 *
 * What a test cannot check is whether the named module *is* the deliverable.
 * That is the judgement, it is in `because`, and it is for a person to
 * re-read — the honest division, and the same one Phase 179 drew for
 * `PINNED_CLAIMS`.
 *
 * ## Three entries ship no code, and say so
 *
 * *Repository audit*, *architecture* and *database conventions* are Phase 0
 * acts whose product is a decision, not a module. Their evidence is the
 * document that records the decision, which is the honest answer and not a
 * dodge: a convention nobody wrote down is a convention the next person
 * cannot follow.
 */
export type PhaseDeliverable = {
  /** 0–8, as §20 numbers them. */
  phase: number
  /** §20's own words, verbatim, so the register can be checked against it. */
  deliverable: string
  /** Files that ship it. Asserted to exist; not asserted to be sufficient. */
  evidence: readonly string[]
  /** Why these files are that deliverable, and what they do not cover. */
  because: string
}

export const PHASE_DELIVERABLES: readonly PhaseDeliverable[] = [
  // --- Phase 0 — Foundation -------------------------------------------------
  {
    phase: 0,
    deliverable: 'Repository audit',
    evidence: ['docs/adr/0001-modular-monolith-and-tenancy.md'],
    because:
      'An act rather than a module: the audit was the reading that produced ADR 0001, and the ' +
      'ADR is what it left behind. Nothing in `src` can evidence it, and an entry claiming a ' +
      'module would be the register lying to look complete.',
  },
  {
    phase: 0,
    deliverable: 'architecture',
    evidence: ['docs/adr/0001-modular-monolith-and-tenancy.md', 'src/modules'],
    because:
      'The modular monolith: domain logic in `src/modules/<domain>` and none in `src/app`, ' +
      'decided in ADR 0001 and enforced since by the shape of the tree. §17 is the same claim ' +
      'from the other end and the audit measures it there.',
  },
  {
    phase: 0,
    deliverable: 'auth/tenant model',
    evidence: ['src/modules/auth', 'src/modules/tenancy', 'src/db/tenant-scope.ts'],
    because:
      'Sessions, devices and MFA on one side; `ActorContext`, `scoped()` and the isolation ' +
      'census on the other. The strongest-measured deliverable in the whole table: 292 writes ' +
      'and 955 reads, every one standing on a named guard (Phases 149–150, 196–198).',
  },
  {
    phase: 0,
    deliverable: 'permissions',
    evidence: ['src/modules/permissions/index.ts'],
    because:
      'Seven roles against a permission list. `requirePermission` is the single gate and every ' +
      'service takes an actor first, which is what makes a role something structural rather ' +
      'than a screen that hides a button. This entry claimed §14\'s "granular grants and ' +
      'revocations layered on top" until Phase 201 measured it: `effectivePermissions` applies ' +
      'them and `memberships.permissionOverrides` has no writer, so the mechanism is complete ' +
      'except for anything that could use it — declared in `COLUMN_WRITERS` and nominated.',
  },
  {
    phase: 0,
    deliverable: 'database conventions',
    evidence: ['src/db/schema', 'docs/adr/0002-double-entry-ledger.md'],
    because:
      'Money in integer minor units, every tenant table carrying `company_id`, `date` columns ' +
      'with no zone, enums for closed sets, and constraints preferred over checks in code. ' +
      'Recorded in ADR 0002 and in the schema itself rather than in a style guide, which is ' +
      'why the schema is the evidence.',
  },
  {
    phase: 0,
    deliverable: 'audit logging',
    evidence: ['src/modules/audit/index.ts'],
    because:
      '`AuditAction` is a closed union and `recordAudit` writes before/after, so an action ' +
      'nobody declared does not compile. §19 asks for complete auditability and this is what ' +
      'that claim rests on.',
  },
  {
    phase: 0,
    deliverable: 'CI/CD',
    evidence: ['.github/workflows/ci.yml'],
    because:
      'The one deliverable here whose absence this project has actually felt: Phase 192 found ' +
      '`npm run build` broken for eight phases because nothing in the development loop ran it, ' +
      'and CI was what eventually said so. The build is step 0 of the local suite now for the ' +
      'same reason.',
  },
  {
    phase: 0,
    deliverable: 'design system',
    evidence: ['src/app/globals.css', 'tailwind.config.ts', 'src/components'],
    because:
      'Brand values as CSS custom properties (ADR 0004) so one document renders under a ' +
      'different kit without touching its content, plus the shared shell, cards, tables and ' +
      'refusal panels in `src/components`. Not a published component library, and not claimed ' +
      'as one.',
  },

  // --- Phase 1 — Bookkeeping MVP -------------------------------------------
  {
    phase: 1,
    deliverable: 'COA',
    evidence: ['src/modules/coa/standard.ts', 'src/modules/coa/industry.ts'],
    because:
      'A standard chart plus per-industry packs (§5), installed at registration. The industry ' +
      'packs are why §5 is one deliverable rather than a setup screen.',
  },
  {
    phase: 1,
    deliverable: 'bank connections',
    evidence: ['src/modules/banking/provider.ts', 'src/modules/banking/providers/plaid.ts'],
    because:
      'A `BankProvider` interface with a real Plaid adapter and a mock, which Phase 176 tested ' +
      "against the interface's own claim that swapping aggregators means one new adapter.",
  },
  {
    phase: 1,
    deliverable: 'transaction import/inbox',
    evidence: ['src/modules/bookkeeping/transactions.ts', 'src/app/bookkeeping/inbox.tsx'],
    because:
      'Idempotent import keyed on the provider transaction id, and the inbox screen this ' +
      'application is mostly used through. Phases 177–178 are about the two lists that import ' +
      'originally dropped.',
  },
  {
    phase: 1,
    deliverable: 'categorization',
    evidence: ['src/modules/bookkeeping/transactions.ts'],
    because:
      '`categorize` posts the journal entry as well as setting the account, which is the ' +
      'reason it lives beside import rather than in the ledger: the bookkeeping act and the ' +
      'ledger consequence are one transaction.',
  },
  {
    phase: 1,
    deliverable: 'rules',
    evidence: ['src/modules/bookkeeping/rules-engine.ts'],
    because:
      'User-created rules on merchant, description, amount, account or type (§3), applied to ' +
      'new transactions and optionally to existing ones, with bulk creation grouped under a ' +
      'batch so one decision can be undone as one. The `suggest` / `auto` split is the ' +
      "preference §3 asks for, and defaults to `suggest`: a rule that matches too broadly " +
      'miscategorizes everything it touches, quietly.',
  },
  {
    phase: 1,
    deliverable: 'recurring memory',
    evidence: ['src/modules/bookkeeping/rules-engine.ts'],
    because:
      "§3's *recurring vendor memory*: `rememberVendor` turns one categorization into a rule, " +
      'defaulting to `suggest` rather than `auto` so the next charge is proposed rather than ' +
      'posted. Reachable without the AI module — the checkbox is on the inbox and on by ' +
      'default — which §22 requires of everything in Phases 0–5. **Not offered on the phone**, ' +
      'which Phase 199 found stated the other way round in a comment.',
  },
  {
    phase: 1,
    deliverable: 'splits/transfers',
    evidence: ['src/modules/bookkeeping/transactions.ts', 'src/db/schema/banking.ts'],
    because:
      '`transaction_splits` for one charge across several accounts, and transfer identification ' +
      'so moving money between own accounts is not counted as income and expense. Both are §3 ' +
      'bullets and both post through the same ledger path.',
  },
  {
    phase: 1,
    deliverable: 'mobile-responsive review',
    evidence: ['src/app/m/review/deck.tsx', 'src/modules/mobile/operations.ts'],
    because:
      'More than responsive: an installable app with an offline outbox that replays operations ' +
      'when the connection returns (§2). The replay queue is why its categorize path is ' +
      'narrower than the desktop one.',
  },

  // --- Phase 2 — Reconciliation + Accounting Core --------------------------
  {
    phase: 2,
    deliverable: 'Reconciliation',
    evidence: ['src/modules/reconciliation/service.ts'],
    because:
      'Sessions against a statement, with the difference explained and uncleared items listed ' +
      '(§4). The AI assistant on top is Phase 6 and optional.',
  },
  {
    phase: 2,
    deliverable: 'ledger/journals',
    evidence: ['src/modules/ledger/journal.ts', 'src/modules/ledger/posting.ts'],
    because:
      'Double entry with balance enforced in the database, period locks, and corrections by ' +
      'reversal rather than edit (ADR 0002). Every module that moves money posts through here.',
  },
  {
    phase: 2,
    deliverable: 'trial balance',
    evidence: ['src/modules/ledger/balances.ts'],
    because:
      '`trialBalance` over account balances, on either basis and at any date. The figure the ' +
      'control-account checks reconcile the subledgers against, so it is the one report whose ' +
      'being wrong is found by something other than a person reading it: ' +
      '`books.integrity_check` runs nightly and records three outcomes rather than two — ' +
      'agrees, disagrees, and *nobody knows*, because a check that threw and was swallowed ' +
      'looks exactly like a check that passed.',
  },
  {
    phase: 2,
    deliverable: 'core statements',
    evidence: ['src/modules/ledger/reports.ts', 'src/modules/ledger/cash-flow.ts'],
    because:
      'Profit and loss, balance sheet and cash flow, on cash or accrual basis, with comparative ' +
      'periods and as-at dating (§13). Phase 195 found the AI insights assistant had never been ' +
      'given two of these.',
  },
  {
    phase: 2,
    deliverable: 'AR/AP basics',
    evidence: ['src/modules/receivables/service.ts', 'src/modules/ledger/aging.ts'],
    because:
      'Invoices, bills, payments, credit notes and aging, with the subledgers reconciled to ' +
      'their control accounts rather than assumed equal. *Basics* is §20 being modest: this is ' +
      'also where multi-currency lives, and Phases 122–145 are mostly about the arithmetic of ' +
      'a foreign document meeting a home-money ledger.',
  },
  {
    phase: 2,
    deliverable: 'accountant role',
    evidence: ['src/modules/permissions/index.ts', 'src/modules/practice/service.ts'],
    because:
      'The role, and the practice model behind it (§14): an external accountant reaches a ' +
      "client's books through an engagement rather than through a second account.",
  },

  // --- Phase 3 — CRM + Proposal Pipeline ----------------------------------
  {
    phase: 3,
    deliverable: 'Lead intake',
    evidence: ['src/modules/crm/intake.ts', 'src/app/api/intake/[key]/route.ts'],
    because:
      'A public endpoint keyed by a per-company public key, with a spam trap, consent capture ' +
      'and the attacker-first refusals an unauthenticated write needs.',
  },
  {
    phase: 3,
    deliverable: 'clients/contacts',
    evidence: ['src/modules/crm/opportunities.ts', 'src/db/schema/crm.ts'],
    because:
      'Organizations, contacts and customers, with the party merge that puts two records of one ' +
      'business together (Phases 96, 184, 198). The merge is the part that keeps costing: its ' +
      'reference registry is checked against the catalogue, because repointing twenty-one of ' +
      'twenty-two references leaves a document attached to a record the screens have hidden.',
  },
  {
    phase: 3,
    deliverable: 'opportunities',
    evidence: ['src/modules/crm/pipeline.ts', 'src/modules/crm/opportunities.ts'],
    because:
      'Stages with probabilities, a weighted forecast, and activity logged against each deal so ' +
      'the timeline is a record rather than a reconstruction. The stage is forward-only through ' +
      "`sendProposal` and `acceptProposal`, which is why a client's acceptance cannot move a " +
      'deal backwards.',
  },
  {
    phase: 3,
    deliverable: 'proposal statuses',
    evidence: ['src/db/schema/crm.ts', 'src/modules/crm/proposals.ts'],
    because:
      "All seven §9 names: draft, sent, viewed, won, lost, expired, no_decision. Phase 195 " +
      'found `expired` had no writer for a hundred and ninety phases and built the sweep that ' +
      'sets it.',
  },
  {
    phase: 3,
    deliverable: 'win/loss analytics',
    evidence: ['src/modules/crm/analytics.ts'],
    because:
      'Win rate by count and value, loss reasons, pipeline and forecast, and breakdowns by ' +
      'owner, source, industry, region and period (§9). Phase 168 built the last four.',
  },
  {
    phase: 3,
    deliverable: 'website intake API/widget',
    evidence: ['src/app/api/intake/[key]/route.ts', 'src/app/crm/intake/intake-keys.tsx'],
    because:
      'The API, and a dependency-free HTML form the screen hands over as copyable markup — no ' +
      'script to host, which is the only version of this a small business will actually ' +
      'install.',
  },

  // --- Phase 4 — Proposal Designer + Company Studio ------------------------
  {
    phase: 4,
    deliverable: 'Brand kit',
    evidence: ['src/modules/brand/identity.ts', 'src/modules/brand/letterhead.ts'],
    because:
      'Colours, type and logo as CSS custom properties, so one document renders under a ' +
      'different kit without touching its content (ADR 0004). The PDF resolves the same tokens.',
  },
  {
    phase: 4,
    deliverable: 'templates',
    evidence: ['src/modules/design/templates.ts'],
    because:
      'Starting documents and save-as-template, which is also §7\'s *reusable components* — a ' +
      'row Phase 193 found the audit had omitted while it was built.',
  },
  {
    phase: 4,
    deliverable: 'dynamic fields',
    evidence: ['src/modules/design/merge-fields.ts'],
    because:
      'Merge fields resolved per recipient at send time, and the route every narrative column ' +
      'reaches the page by — the rule `PROPOSAL_COMPONENTS` enforces after Phase 182 found four ' +
      'columns nothing rendered.',
  },
  {
    phase: 4,
    deliverable: 'pricing',
    evidence: ['src/modules/crm/proposals.ts', 'src/modules/crm/billing-schedule.ts'],
    because:
      'Line items with optional and selected lines, discounts, tax, and billing schedules in ' +
      'stages. The optional-line arithmetic is what Phase 168 reconciled against the analytics.',
  },
  {
    phase: 4,
    deliverable: 'PDF/web proposal',
    evidence: ['src/modules/pdf/service.ts', 'src/app/p/[token]/page.tsx'],
    because:
      'A server-side PDF writer with no dependency, and the client-facing page on a public ' +
      'token. Both render the same block list, which is the invariant Phases 190–193 kept ' +
      'testing.',
  },
  {
    phase: 4,
    deliverable: 'acceptance/versioning',
    evidence: ['src/modules/crm/acceptance.ts', 'src/db/schema/crm.ts'],
    because:
      'A version snapshot per send, so a sent proposal never changes (ADR 0021), and an ' +
      'acceptance record carrying the parties frozen into the version that was signed.',
  },
  {
    phase: 4,
    deliverable: 'core vector/layout engine',
    evidence: ['src/modules/pdf/vector.ts', 'src/modules/design/svg.ts', 'src/modules/design/shapes.ts'],
    because:
      'The §7 capability ADR 0173 listed last: an SVG subset that is both the security boundary ' +
      'and the printable set, a PDF path/transform writer, and generated shape primitives. ' +
      'Phases 190–193. Gradients, shadows and opacity are refused by name rather than missing.',
  },

  // --- Phase 5 — Marketing -------------------------------------------------
  {
    phase: 5,
    deliverable: 'Segments',
    evidence: ['src/modules/marketing/segments.ts'],
    because:
      'Audience definitions filtered on CRM fields, with consent applied **at send rather than ' +
      'at build** — a segment is a query, so a contact who unsubscribes between building and ' +
      'sending is excluded by the send and would not be by a stored list. Suppression works the ' +
      'same way, for the same reason.',
  },
  {
    phase: 5,
    deliverable: 'strategic accounts',
    evidence: ['src/modules/crm/attention.ts', 'src/modules/crm/accounts.ts'],
    because:
      "§10's high-value recurring-service targets. A pure core with no clock and no database, " +
      'so the list answers with the AI module switched off — which Phase 167 found was the ' +
      'harder half of the §11 row that reads as a prompt.',
  },
  {
    phase: 5,
    deliverable: 'campaigns',
    evidence: ['src/modules/marketing/campaigns.ts', 'src/modules/marketing/render-email.ts'],
    because:
      'Multi-step campaigns with a scheduler, an email renderer that degrades to the least ' +
      'capable client, and delivery events fed back per recipient.',
  },
  {
    phase: 5,
    deliverable: 'creative reuse',
    evidence: ['src/modules/design/documents.ts', 'src/modules/design/templates.ts'],
    because:
      '`duplicateDocument` and the template library, which is where Phase 166 found the ' +
      'provenance rule had to follow a copy rather than stay on the asset.',
  },
  {
    phase: 5,
    deliverable: 'lost-opportunity nurture',
    evidence: ['src/modules/marketing/segments.ts', 'src/modules/crm/analytics.ts'],
    because:
      "§9's automatic handoff: a lost or dormant opportunity with re-engagement eligibility " +
      'becomes a nurture audience, with suppression and consent honoured.',
  },
  {
    phase: 5,
    deliverable: 'analytics',
    evidence: ['src/modules/marketing/campaigns.ts'],
    because:
      'Sends, opens and clicks per campaign and per recipient, from the delivery events the ' +
      'email provider reports back through a webhook — one of the five unauthenticated writes ' +
      '`PUBLIC_WRITES` exists to keep counted. Bounces and complaints feed consent, so a ' +
      'campaign that damages a list narrows the next one rather than being reported as reach.',
  },

  // --- Phase 6 — AI Add-on -------------------------------------------------
  {
    phase: 6,
    deliverable: 'AI gateway',
    evidence: ['src/modules/ai/gateway.ts', 'src/modules/ai/provider.ts'],
    because:
      'One path to a model: schema-validated output, a provider registry with a heuristic mock ' +
      'as the default, and a human-applied suggestion for every consequential act (ADR 0006).',
  },
  {
    phase: 6,
    deliverable: 'usage metering',
    evidence: ['src/modules/ai/settings.ts', 'src/db/schema/ai.ts'],
    because:
      '`ai_requests` with tokens, cost and prompt version per call, which §12 asks for *for ' +
      'billing and monitoring* — and which Phase 194 found had been metering Sonnet half again ' +
      'too high against a price increase that was cancelled.',
  },
  {
    phase: 6,
    deliverable: 'bookkeeping suggestions',
    evidence: ['src/modules/ai/bookkeeping.ts'],
    because:
      'Categories, anomalies and duplicates, proposed rules and an inbox summary — five of §11\'s ' +
      'five for that row, each landing in the suggestion queue rather than in the ledger.',
  },
  {
    phase: 6,
    deliverable: 'proposal/marketing drafting',
    evidence: ['src/modules/ai/assistants.ts', 'src/modules/ai/prompts.ts'],
    because:
      'Scope, summaries, exclusions and follow-up for proposals; campaign copy for marketing. ' +
      'Phase 195 counted four of five and one of five against §11\'s own cells, and recorded the ' +
      'gaps rather than claiming the rows.',
  },
  {
    phase: 6,
    deliverable: 'business insights',
    evidence: ['src/modules/ai/assistants.ts'],
    because:
      'Cash movement, receivables, conversion, concentration and expense change against the ' +
      'prior period. Phase 195 found it had been asked to explain expense changes with no ' +
      'expense figure, and said nothing — correctly, which is why nobody noticed.',
  },
  {
    phase: 6,
    deliverable: 'design assistance',
    evidence: ['src/modules/ai/design.ts', 'src/modules/design/documents.ts'],
    because:
      'Layout suggestions as an ordering over blocks that already exist — never block ' +
      'content — so the worst a bad suggestion can do is rearrange. Provenance follows the ' +
      'document, which is Phase 166\'s finding.',
  },

  // --- Phase 7 — Industry Modules -----------------------------------------
  {
    phase: 7,
    deliverable: 'Construction first or based on market validation',
    evidence: ['src/modules/jobs', 'src/modules/coa/industry.ts'],
    because:
      'Construction, as §20 offers first: jobs, cost codes, work in process, retainage, ' +
      'subcontractor compliance and progress billing, with its own chart pack.',
  },
  {
    phase: 7,
    deliverable: 'add specialized workflows without forking the core ledger',
    evidence: ['src/modules/industry/modules.ts', 'src/modules/ledger/posting.ts'],
    because:
      'The constraint rather than a feature, and the one §20 bullet that is a rule: eight ' +
      'industry modules post through `ledger/posting` and none has its own ledger. ' +
      '`moduleEnabled` gates them per company, so a company that lets no property never sees ' +
      'the rent run.',
  },

  // --- Phase 8 — Payroll/Tax/Advanced Integrations -------------------------
  {
    phase: 8,
    deliverable: 'Partner integrations',
    evidence: [
      'src/modules/banking/providers/plaid.ts',
      'src/modules/payments/service.ts',
      'src/modules/notify/transactional.ts',
    ],
    because:
      'Bank aggregation, card payments and transactional email, each behind an interface with a ' +
      'mock, so a deployment missing one degrades visibly rather than silently (Phase 175).',
  },
  {
    phase: 8,
    deliverable: 'compliance-heavy features',
    evidence: [
      'src/modules/payroll',
      'src/modules/payroll/sales-tax.ts',
      'src/modules/retention/sweep.ts',
    ],
    because:
      'Payroll with remittances, sales-tax collection and returns, and retention policies that ' +
      'delete what the law says not to keep. The last of those is the one with a register and a ' +
      'refusal, because a sweep that silently deleted nothing is worse than one that fails. ' +
      'Sales tax lives under `payroll/` rather than in a module of its own, which is a ' +
      'filing-and-remittance grouping rather than a modelling claim — worth knowing before ' +
      'somebody looks for `modules/tax` and concludes it is missing, as this register did on ' +
      'its first pass.',
  },
]

/** The register's entry for a deliverable, by §20's own words. */
export function phaseDeliverableFor(deliverable: string): PhaseDeliverable {
  const found = PHASE_DELIVERABLES.find((row) => row.deliverable === deliverable)
  if (found) return found

  throw new RegistryError({
    registry: 'PHASE_DELIVERABLES',
    key: deliverable,
    message:
      `No §20 deliverable is registered as "${deliverable}". The register's keys are §20's own ` +
      'words, so a miss means either the spec was reworded or somebody is asking about ' +
      'something §20 never promised.',
  })
}

/** Every deliverable §20 lists for one phase. */
export function deliverablesOfPhase(phase: number): readonly PhaseDeliverable[] {
  const rows = PHASE_DELIVERABLES.filter((row) => row.phase === phase)
  if (rows.length > 0) return rows

  throw new RegistryError({
    registry: 'PHASE_DELIVERABLES',
    key: String(phase),
    message: `§20 has no phase ${phase}. It runs 0 to 8.`,
  })
}

/**
 * Filler in §20's cells that is not a deliverable.
 *
 * Declared rather than skipped, so the test that asserts every word of a cell
 * is accounted for can say what it is ignoring. Phase 8's tail is a
 * **sequencing condition** — *after the accounting foundation is stable* — and
 * conditions are not things to build; this one was met by Phases 0–2 existing
 * before Phase 8 did.
 */
export const NOT_DELIVERABLES: readonly string[] = [
  'after the accounting foundation is stable',
]
