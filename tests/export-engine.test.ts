import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  EXCLUDED_DESTINATIONS,
  EXPORT_DESTINATIONS,
  adapterMayBeBuilt,
  destinationFor,
  exclusionFor,
  mayExportTo,
  offerableDestinations,
} from '@/modules/exporter/destinations'
import {
  READINESS_CHECKS,
  assess,
  checkFor,
  exceptionReport,
  requiresMapping,
  type PackageFacts,
} from '@/modules/exporter/readiness'
import { integrationFor } from '@/modules/exporter/destinations'
import {
  PACKAGE_SECTIONS,
  exportedSections,
  gapNote,
  packageGaps,
  sectionFor,
  unexportedSections,
} from '@/modules/exporter/sections'
import {
  adapterFor,
  adapterStands,
  registeredAdapters,
  type ExportAdapter,
} from '@/modules/exporter/adapter'
import { universalAdapter } from '@/modules/exporter/universal'
import { TAX_CLASSIFICATIONS, classificationFor } from '@/modules/exporter/entity'
import { RegistryError } from '@/modules/errors/registry'

/**
 * The professional accountant export engine, as its own specification asks to
 * be checked (Phase 158).
 *
 * No database and no clock in this file. Every §11 check is exercised against a
 * fixture written here, which is the only way to see each one *disagree* — real
 * books are hard to get into most of these states and impossible to get into
 * some of them, and a check only ever seen to agree is not a check (Phase 121).
 */

/** The twenty targets §3 names, by key. */
const SPEC_TARGETS = [
  'lacerte',
  'proseries',
  'proconnect',
  'ultratax-cs',
  'gosystem-tax-rs',
  'cch-axcess-tax',
  'cch-prosystem-fx-tax',
  'drake-tax',
  'atx',
  'taxwise',
  'caseware-working-papers',
  'caseware-cloud',
  'cch-axcess-engagement',
  'cch-prosystem-fx-engagement',
  'workpapers-cs',
  'accounting-cs',
  'tr-cloud-audit-suite',
  'sage-intacct',
  'netsuite',
  'dynamics-365-bc',
]

/** Books that pass every check, for the universal package. */
function cleanFacts(): PackageFacts {
  return {
    destinationKey: 'universal',
    entity: {
      name: 'Hartley Joinery Ltd',
      taxClassification: 's_corporation',
      fiscalYearEndMonth: 12,
      hasTaxIdentifier: true,
    },
    period: { startDate: '2026-01-01', endDate: '2026-12-31' },
    trialBalance: { totalDebitCents: 1_000_000, totalCreditCents: 1_000_000, rowCount: 24 },
    continuity: [],
    orphanLineCount: 0,
    unpostedEntryCount: 0,
    accountNumbers: ['1000', '4000', '5000'],
    unmappedAccountCount: 0,
    missingTaxCodeCount: 0,
    formatVersionConfirmed: true,
    rendered: { totalDebitCents: 1_000_000, totalCreditCents: 1_000_000 },
    detail: { totalDebitCents: 1_000_000, totalCreditCents: 1_000_000 },
  }
}

describe('the destinations a firm may be offered', () => {
  it('presents no direct competitor as an export destination', () => {
    /**
     * §15's first acceptance criterion, and the reason `EXCLUDED_DESTINATIONS`
     * exists as data rather than as a paragraph in a document. A sentence in a
     * specification cannot enforce this; the next person to add a destination
     * will not have read it.
     */
    const excludedKeys = new Set(EXCLUDED_DESTINATIONS.map((row) => row.key))
    const excludedProducts = new Set(EXCLUDED_DESTINATIONS.map((row) => row.product.toLowerCase()))

    const trespassers = EXPORT_DESTINATIONS.filter(
      (row) => excludedKeys.has(row.key) || excludedProducts.has(row.product.toLowerCase()),
    )

    expect(trespassers).toEqual([])
  })

  it('names the competitor and the reason rather than saying "unsupported"', () => {
    // Asked by key, which is how a dropdown or a URL asks. Before this was
    // wired, `mayExportTo('quickbooks-online')` fell through to
    // `destinationFor` and threw "nobody declared that key" — which is both
    // true and useless, because somebody asking for QuickBooks has not made a
    // typo. They have asked a question with an answer.
    const verdict = mayExportTo('quickbooks-online')

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('QuickBooks Online is not an export destination')
    // §2 allows reading these products as migration sources. The refusal says
    // so, because the opposite impression is the one somebody would form.
    expect(verdict.why).toContain('universal accountant package')
  })

  it('answers to a product name as well as a key', () => {
    expect(exclusionFor('Xero')?.key).toBe('xero')
    expect(exclusionFor('xero')?.product).toBe('Xero')
    expect(exclusionFor('  WAVE  ')?.key).toBe('wave')
    expect(exclusionFor('Lacerte Tax')).toBeNull()
  })

  it('excludes a product by its position and not its vendor', () => {
    // The one entry in the list that needed qualifying. §2 says "Sage
    // Accounting products positioned primarily as small-business bookkeeping
    // replacements", and §3 names Sage Intacct as a Priority 2 *target* — same
    // vendor, different product, different market.
    expect(exclusionFor('sage-accounting')).not.toBeNull()
    expect(destinationFor('sage-intacct').vendor).toBe('Sage')
    expect(exclusionFor('sage-intacct')).toBeNull()
  })

  it('covers exactly the twenty targets the specification lists, plus the universal package', () => {
    expect(EXPORT_DESTINATIONS.map((row) => row.key).sort()).toEqual(
      [...SPEC_TARGETS, 'universal'].sort(),
    )
  })

  it('offers only the universal package, because nothing else has been researched', () => {
    /**
     * §7: *"Do not assume an API exists."* §13: a one-page integration
     * worksheet, citing official vendor documentation, before production code.
     *
     * So every §3 target is `unresearched` and this assertion is the honest
     * state of the feature rather than a placeholder. It will change one target
     * at a time, each with a worksheet behind it.
     */
    expect(offerableDestinations().map((row) => row.key)).toEqual(['universal'])

    // Phase 159 researched the fourteen Priority 1 targets, so they are no
    // longer `unresearched` — and none is offerable, because none is verified.
    // The six Priority 2 targets have no worksheet at all.
    const states = EXPORT_DESTINATIONS.map((row) => integrationFor(row.key))
    expect(states.filter((state) => state === 'researched-unverified')).toHaveLength(14)
    expect(states.filter((state) => state === 'unresearched')).toHaveLength(6)
  })

  it('refuses a planned destination differently from an excluded one', () => {
    // A Priority 2 target, because Phase 159 researched Priority 1 and this is
    // the "nobody has looked yet" refusal. The researched ones get their own
    // sentences, asserted in `export-worksheets.test.ts`.
    const planned = mayExportTo('netsuite')

    expect(planned.ok).toBe(false)
    if (planned.ok) return
    // Two refusals, two kinds. An exclusion is a decision and will not change by
    // doing more work; this is an absence, and the refusal says what would fill
    // it.
    expect(planned.why).toContain('nobody has established how it actually accepts a trial balance')
    expect(planned.why).toContain('must not be assumed')
    expect(planned.why).not.toContain('not an export destination')
  })

  it('refuses to let an adapter be written before the worksheet exists', () => {
    for (const key of SPEC_TARGETS) {
      const verdict = adapterMayBeBuilt(key)
      expect(verdict.ok, `${key} should wait on a §13 worksheet`).toBe(false)
      if (verdict.ok) continue
      expect(verdict.why).toContain('§13')
    }

    expect(adapterMayBeBuilt('universal')).toEqual({ ok: true })
    expect(adapterMayBeBuilt('xero').ok).toBe(false)
  })

  it('throws rather than returning undefined for a key nobody declared', () => {
    expect(() => destinationFor('quickbooks-online')).toThrow(RegistryError)
    expect(() => destinationFor('nonsense')).toThrow(/No export destination is declared/)
  })

  it('knows which destinations need Accountrix accounts translated', () => {
    // Derived from what a product *is*, not declared per destination. A tax
    // program needs return-line codes and a workpaper program needs a grouped
    // trial balance; neither can use "4000 — Sales" as it stands.
    expect(requiresMapping('universal')).toBe(false)
    expect(requiresMapping('tax')).toBe(true)
    expect(requiresMapping('workpapers')).toBe(true)
    expect(requiresMapping('firm-or-erp')).toBe(true)
  })
})

describe('the pre-export readiness assessment', () => {
  it('is green when every check passes', () => {
    const assessment = assess(cleanFacts())

    expect(assessment.status).toBe('green')
    expect(assessment.exceptions).toEqual([])
    expect(assessment.mayProceed).toBe(true)
    expect(exceptionReport(assessment)).toContain('Every pre-export check passed')
  })

  it('refuses a key no check is declared for', () => {
    expect(() => checkFor('vibes')).toThrow(RegistryError)
    expect(checkFor('debits_equal_credits').severity).toBe('red')
  })

  it('covers every clause §11 names', () => {
    /**
     * §11's own list, which is the specification of what "validated" means here.
     * Written out rather than counted, so a clause that loses its check fails by
     * name.
     */
    const clauses = READINESS_CHECKS.map((check) => check.clause).join(' | ')

    for (const clause of [
      'debits equal credits',
      'beginning balance continuity',
      'no orphan journal lines',
      'all required accounts have target mappings',
      'all required tax codes are present',
      'entity and fiscal-year data are complete',
      'date ranges are valid',
      'no unsupported account identifiers or characters',
      'no duplicate unique IDs where the target forbids them',
      'export totals reconcile to Accountrix source reports',
    ]) {
      expect(clauses, `§11 clause not covered: ${clause}`).toContain(clause)
    }
  })

  it('holds the export when the ledger does not balance, and says by how much', () => {
    const assessment = assess({
      ...cleanFacts(),
      trialBalance: { totalDebitCents: 1_041_200, totalCreditCents: 1_000_000, rowCount: 24 },
      // The rendered and detail figures follow the report, as they would.
      rendered: { totalDebitCents: 1_041_200, totalCreditCents: 1_000_000 },
      detail: { totalDebitCents: 1_041_200, totalCreditCents: 1_000_000 },
    })

    expect(assessment.status).toBe('red')
    expect(assessment.mayProceed).toBe(false)
    // The figure, not the fact. "Debits do not equal credits" starts a search;
    // "$412.00" ends one.
    expect(assessment.exceptions[0].message).toContain('Debits exceed credits by $412.00')
  })

  it('holds the export when a closed year has had entries posted into it', () => {
    /**
     * §11's "beginning balance continuity", as the question the ledger can
     * answer. The obvious reading — does this period's opening equity equal the
     * prior period's closing equity — is not a check at all: both come from
     * summing the same lines to the same date.
     *
     * The real break is `staleCloses`: closing and locking are separate in this
     * ledger, so an entry can land in a closed year, and the figure the close
     * moved into retained earnings is then wrong while the books still balance.
     */
    const assessment = assess({
      ...cleanFacts(),
      continuity: [{ fiscalYear: 2025, driftCents: 83_400, entriesSinceCloseCount: 3 }],
    })

    expect(assessment.status).toBe('red')
    expect(assessment.exceptions[0].message).toContain('2025 year was closed')
    expect(assessment.exceptions[0].message).toContain('$834.00')
    expect(assessment.exceptions[0].message).toContain('Reopening and re-closing')
  })

  it('says nothing about continuity when nobody was allowed to look', () => {
    // `null` is "the person running the export cannot read closes", recorded in
    // the manifest under §12. Asserting continuity either way from figures
    // nobody was permitted to read would be worse than saying nothing.
    const assessment = assess({ ...cleanFacts(), continuity: null })

    expect(assessment.status).toBe('green')
  })

  it('holds the export when the two halves of the package do not tie', () => {
    // The reconciliation a firm actually performs: balances per account against
    // the lines behind them. Two queries, separately written filters.
    const assessment = assess({
      ...cleanFacts(),
      detail: { totalDebitCents: 999_000, totalCreditCents: 1_000_000 },
    })

    expect(assessment.status).toBe('red')
    expect(assessment.exceptions[0].code).toBe('detail_ties_to_balances')
    expect(assessment.exceptions[0].message).toContain('do not tie')
  })

  it('holds the export when the rendered file foots to something else', () => {
    /**
     * §15's *"the exported totals reconcile exactly to the Accountrix reports"*,
     * narrowed to the step that can actually fail.
     *
     * The package is built from the same `trialBalance` the screen shows, so the
     * figures cannot differ. What can differ is how they were written down —
     * cents to units — and this is that.
     */
    const assessment = assess({
      ...cleanFacts(),
      rendered: { totalDebitCents: 100_000, totalCreditCents: 100_000 },
    })

    expect(assessment.status).toBe('red')
    expect(assessment.exceptions[0].code).toBe('totals_reconcile_to_source')
    expect(assessment.exceptions[0].message).toContain('came from the same report')
  })

  it('says nothing about the rendering before anything has been rendered', () => {
    // §9 asks for the balance check *before* the package is generated, in that
    // order, so a readiness opinion with no file behind it is a thing the engine
    // has to be able to give.
    const assessment = assess({ ...cleanFacts(), rendered: null })

    expect(assessment.status).toBe('green')
  })

  it('holds the export when the entity profile cannot say which return it feeds', () => {
    const assessment = assess({
      ...cleanFacts(),
      entity: { name: 'Hartley Joinery Ltd', taxClassification: null, fiscalYearEndMonth: null, hasTaxIdentifier: false },
    })

    expect(assessment.status).toBe('red')
    const codes = assessment.exceptions.map((exception) => exception.code)
    expect(codes).toContain('entity_data_complete')
    // The EIN is a yellow and the classification a red, which is the judgement:
    // a firm preparing a return almost certainly has the EIN on its engagement
    // letter, and nothing but these books can say they are an S corporation.
    expect(codes).toContain('tax_identifier_present')
    const identifier = assessment.exceptions.find((e) => e.code === 'tax_identifier_present')
    expect(identifier?.severity).toBe('yellow')
  })

  it('holds the export on a reversed period and on a duplicate account number', () => {
    const reversed = assess({
      ...cleanFacts(),
      period: { startDate: '2026-12-31', endDate: '2026-01-01' },
    })
    expect(reversed.exceptions.map((e) => e.code)).toContain('date_range_valid')

    const duplicated = assess({ ...cleanFacts(), accountNumbers: ['1000', '4000', '1000'] })
    const duplicate = duplicated.exceptions.find((e) => e.code === 'no_duplicate_account_numbers')
    expect(duplicate?.severity).toBe('red')
    expect(duplicate?.message).toContain('"1000"')
    expect(duplicate?.message).toContain('merges two balances into one row')
  })

  it('holds the export when a line belongs to no entry', () => {
    const assessment = assess({ ...cleanFacts(), orphanLineCount: 2 })

    expect(assessment.status).toBe('red')
    expect(assessment.exceptions[0].message).toContain('2 journal lines belong to no entry')
  })

  it('warns without holding when the books are right and something is worth saying', () => {
    /**
     * Yellow has to have real producers or it is a status value nothing
     * generates — and Phase 157's rule is that a declared value with no users is
     * kept when it accuses and deleted when it excuses. Yellow *excuses*: it lets
     * an export through. So it needs producers, and here are two.
     */
    const assessment = assess({
      ...cleanFacts(),
      unpostedEntryCount: 11,
      accountNumbers: ['1000', '4000 · Sales', '5000/1'],
      entity: { ...cleanFacts().entity, hasTaxIdentifier: false },
    })

    expect(assessment.status).toBe('yellow')
    expect(assessment.mayProceed).toBe(true)
    expect(assessment.exceptions.map((e) => e.code).sort()).toEqual(
      ['account_identifiers_portable', 'no_unposted_entries', 'tax_identifier_present'].sort(),
    )
    expect(assessment.exceptions.every((e) => e.severity === 'yellow')).toBe(true)

    const report = exceptionReport(assessment)
    expect(report).toContain('YELLOW')
    expect(report).toContain('The export may proceed')
  })

  it('reads worst first, so the report is in the order somebody would act in', () => {
    const assessment = assess({
      ...cleanFacts(),
      unpostedEntryCount: 4,
      orphanLineCount: 1,
    })

    expect(assessment.exceptions.map((e) => e.severity)).toEqual(['red', 'yellow'])
    expect(exceptionReport(assessment)).toContain('The export is held')
  })

  it('refuses a tax destination because no mapping has been established', () => {
    /**
     * The three `mapped-destination` checks, and the reason they are declared
     * before §10's mapping store exists. `null` means nobody has established a
     * mapping, which is **not** the same as having established that nothing is
     * unmapped — and `null` is red.
     *
     * So asking to export to Lacerte today gets a sentence saying what is
     * missing rather than a feature failing silently. These checks accuse; Phase
     * 157's rule says keep them.
     */
    const assessment = assess({
      ...cleanFacts(),
      destinationKey: 'lacerte',
      unmappedAccountCount: null,
      missingTaxCodeCount: null,
      formatVersionConfirmed: null,
    })

    expect(assessment.status).toBe('red')
    const codes = assessment.exceptions.map((e) => e.code)
    expect(codes).toContain('accounts_mapped')
    expect(codes).toContain('tax_codes_present')
    expect(codes).toContain('format_version_confirmed')
    expect(assessment.exceptions.find((e) => e.code === 'accounts_mapped')?.message).toContain(
      'No account mapping has been established for Lacerte Tax',
    )
  })

  it('asks the mapping checks of no universal export', () => {
    // The universal package carries Accountrix's own account numbers because the
    // firm is going to map them in its own system or read them by hand. §4 is
    // what makes that the right answer rather than a shortcut.
    const assessment = assess(cleanFacts())
    const mappingCodes = READINESS_CHECKS.filter(
      (check) => check.scope === 'mapped-destination',
    ).map((check) => check.code)

    expect(mappingCodes).toHaveLength(3)
    for (const code of mappingCodes) {
      expect(assessment.exceptions.map((e) => e.code)).not.toContain(code)
    }
  })

  it('counts a destination with a mapping as mapped once the figures are zero', () => {
    // The other half of the mapping check: `null` accuses and `0` passes, so the
    // check will be seen to agree as well as to disagree once §10's store exists.
    const assessment = assess({
      ...cleanFacts(),
      destinationKey: 'drake-tax',
      unmappedAccountCount: 0,
      missingTaxCodeCount: 0,
      formatVersionConfirmed: true,
    })

    expect(assessment.status).toBe('green')
  })

  it('names the unmapped accounts rather than just reporting their number', () => {
    const assessment = assess({
      ...cleanFacts(),
      destinationKey: 'caseware-working-papers',
      unmappedAccountCount: 7,
      missingTaxCodeCount: 2,
      formatVersionConfirmed: true,
    })

    expect(assessment.exceptions.find((e) => e.code === 'accounts_mapped')?.message).toContain(
      '7 accounts have no Caseware Working Papers mapping',
    )
    expect(assessment.exceptions.find((e) => e.code === 'tax_codes_present')?.message).toContain(
      'appear on no return line',
    )
  })

  it('holds an export of nothing, because an empty file reads as a client with no books', () => {
    const assessment = assess({
      ...cleanFacts(),
      trialBalance: { totalDebitCents: 0, totalCreditCents: 0, rowCount: 0 },
      rendered: { totalDebitCents: 0, totalCreditCents: 0 },
      detail: { totalDebitCents: 0, totalCreditCents: 0 },
    })

    expect(assessment.status).toBe('red')
    expect(assessment.exceptions[0].code).toBe('has_accounts')
  })

  it('has no check that could only ever pass', () => {
    /**
     * Phase 121, applied to the registry as a whole. Every check above has been
     * seen to fire on a fixture in this file; this asserts the inverse — that no
     * check is declared whose `detect` nothing in this file can make return a
     * sentence.
     *
     * Measured rather than trusted: the codes that fired across every fixture
     * tried here, against the codes declared.
     */
    const fired = new Set<string>()
    const facts = cleanFacts()

    const fixtures: PackageFacts[] = [
      { ...facts, trialBalance: { ...facts.trialBalance, totalDebitCents: 2 } },
      { ...facts, continuity: [{ fiscalYear: 2025, driftCents: 1, entriesSinceCloseCount: 1 }] },
      { ...facts, orphanLineCount: 1 },
      { ...facts, unpostedEntryCount: 1 },
      { ...facts, entity: { ...facts.entity, taxClassification: null } },
      { ...facts, entity: { ...facts.entity, hasTaxIdentifier: false } },
      { ...facts, period: { startDate: '2026-02-01', endDate: '2026-01-01' } },
      { ...facts, accountNumbers: ['4000 · Sales'] },
      { ...facts, accountNumbers: ['1000', '1000'] },
      { ...facts, rendered: { totalDebitCents: 1, totalCreditCents: 1 } },
      { ...facts, detail: { totalDebitCents: 1, totalCreditCents: 1 } },
      { ...facts, trialBalance: { totalDebitCents: 0, totalCreditCents: 0, rowCount: 0 } },
      {
        ...facts,
        destinationKey: 'lacerte',
        unmappedAccountCount: null,
        missingTaxCodeCount: null,
        formatVersionConfirmed: null,
      },
    ]

    for (const fixture of fixtures) {
      for (const exception of assess(fixture).exceptions) fired.add(exception.code)
    }

    const declared = READINESS_CHECKS.map((check) => check.code)
    expect([...declared].filter((code) => !fired.has(code))).toEqual([])
  })
})

describe('the normalized package §5 asks for', () => {
  it('declares every item §5 lists', () => {
    // §5's list is twenty-seven items. Counted here so that dropping one is
    // loud, and counted from the specification rather than from the registry:
    // the first draft of this assertion said twenty-six, which is what reading
    // the list quickly produces.
    expect(PACKAGE_SECTIONS).toHaveLength(27)
    expect(new Set(PACKAGE_SECTIONS.map((section) => section.key)).size).toBe(27)
  })

  it('says which items Accountrix does not hold, and why', () => {
    /**
     * The reason this is a registry and not a type. A
     * `type AccountantPackage = { trialBalance: …, generalLedger: … }` would say
     * what the package holds and nothing about what it *should* hold, so the
     * items Accountrix cannot produce would be invisible — absent from the type,
     * absent from the file, and absent from any list of what is missing. A firm
     * would discover the gap by looking for the loan schedule and not finding
     * one.
     */
    expect(packageGaps().map((section) => section.key).sort()).toEqual([
      'adjusting_journal_entries',
      'document_references',
      'loan_schedules',
      'tax_code_mappings',
    ])

    for (const gap of packageGaps()) {
      // Each one is a feature with a §5 clause behind it, which is a better
      // backlog than a list of ideas — so each has to carry the reason.
      expect(gap.because.length, gap.key).toBeGreaterThan(80)
    }
  })

  it('keeps "not held" apart from "held and not yet exported"', () => {
    // Three states, not two. A firm told a section is absent reads "the client
    // does not have this"; told it is not exported yet it reads "ask
    // Accountrix" — and those are different phone calls.
    expect(unexportedSections().map((section) => section.key)).toEqual(['dimensions'])
    expect(exportedSections()).toHaveLength(27 - 4 - 1)
  })

  it('names in the manifest what the package does not contain', () => {
    const note = gapNote()

    expect(note).toContain('loan and liability schedules')
    expect(note).toContain('tax-code mappings')
    expect(note).toContain('Held but not yet written into a package')

    // And what was left out because of who asked (§12), which depends on the
    // caller and so is passed in rather than derived.
    const withOmission = gapNote([sectionFor('payroll_summary')])
    expect(withOmission).toContain('not permitted to read them')
    expect(withOmission).toContain('says nothing about whether the client has them')
  })

  it('names a producer that really exists, and the permission it really takes', () => {
    /**
     * Phase 141's rule — declare the knowledge, measure the fact — against this
     * registry's own claims. Every `produces` is read out of the file it names
     * and every `permission` is read out of that function's
     * `requirePermission` call, so a producer that is renamed or whose
     * permission tightens cannot leave a stale claim here.
     *
     * This is the check that caught the registry's first draft: it claimed
     * `tenancy/companies:companyProfile`, and there was no such file. The
     * function had to be written, which is how Phase 158 found that `companies`
     * held no entity type at all.
     */
    const faults: string[] = []

    for (const section of PACKAGE_SECTIONS) {
      if (section.source === null) continue
      const [path, fn] = section.source.produces.split(':')
      const file = `src/modules/${path}.ts`

      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        faults.push(`${section.key}: no file ${file}`)
        continue
      }

      const declaration = new RegExp(`^export (?:async )?function ${fn}\\b`, 'm')
      if (!declaration.test(source)) {
        faults.push(`${section.key}: ${file} exports no ${fn}`)
        continue
      }

      // The permission is the one inside that function — found by reading from
      // its declaration to the next top-level `export`, so a different
      // function's `requirePermission` in the same file cannot satisfy it.
      const from = source.search(declaration)
      const rest = source.slice(from + 1)
      const next = rest.search(/^export /m)
      const body = next === -1 ? rest : rest.slice(0, next)

      // One level of same-file delegation, because `trialBalance` is exactly
      // that: it takes no permission of its own and calls `accountBalances`,
      // which takes `reports:view`. A scan that refused to follow it would have
      // pushed the registry into claiming a permission that function does not
      // mention, or into pointing at the wrong function — and the permission a
      // caller actually needs is the one at the bottom of the chain.
      let required = /requirePermission\([^,]+,\s*'([^']+)'\)/.exec(body)?.[1]
      if (required === undefined) {
        const delegate = /\b([a-zA-Z]\w*)\(ctx\b/.exec(body)?.[1]
        if (delegate) {
          const inner = new RegExp(`^export (?:async )?function ${delegate}\\b`, 'm')
          const at = source.search(inner)
          if (at !== -1) {
            const after = source.slice(at + 1)
            const end = after.search(/^export /m)
            required = /requirePermission\([^,]+,\s*'([^']+)'\)/.exec(
              end === -1 ? after : after.slice(0, end),
            )?.[1]
          }
        }
      }

      if (required !== section.source.permission) {
        faults.push(
          `${section.key}: ${fn} requires ${required ?? 'nothing'}, registry says ${section.source.permission}`,
        )
      }
    }

    expect(faults).toEqual([])
  })

  it('refuses a section key nobody declared', () => {
    expect(() => sectionFor('vibes')).toThrow(RegistryError)
    expect(() => sectionFor('vibes')).toThrow(/§5 is the list/)
  })
})

describe('the adapter contract §8 asks for', () => {
  it('has one adapter, and it is the universal package', () => {
    // §13 is why: an adapter waits on a worksheet. §4 is why there is one at
    // all: the universal package must exist regardless, and §15 calls it the
    // fallback where no API exists.
    expect(registeredAdapters().map((adapter) => adapter.destinationKey)).toEqual(['universal'])
    expect(adapterFor('universal')).toBe(universalAdapter)
  })

  it('refuses to name an adapter for a destination nobody has written one for', () => {
    expect(() => adapterFor('ultratax-cs')).toThrow(RegistryError)
    expect(() => adapterFor('ultratax-cs')).toThrow(/§13/)
  })

  it('stands up to its own coherence rules', () => {
    for (const adapter of registeredAdapters()) {
      expect(adapterStands(adapter), adapter.destinationKey).toEqual([])
    }
  })

  it('catches an adapter whose claims and methods disagree', () => {
    /**
     * Not type-checkable, which is why it is a function and a test. TypeScript
     * can require `instructions?` and cannot require it *when `transmits` is
     * false* — and §15 requires a clear fallback file workflow where no API
     * exists, so an adapter producing files with no word on what to do with them
     * has not provided one.
     */
    const base: ExportAdapter = {
      ...universalAdapter,
      destinationKey: 'fixture',
    }

    expect(adapterStands({ ...base, instructions: undefined })).toHaveLength(1)
    expect(adapterStands({ ...base, instructions: undefined })[0]).toContain('fallback file workflow')

    expect(
      adapterStands({ ...base, capabilities: { ...base.capabilities, transmits: true } })[0],
    ).toContain('declares that it transmits and has no sendViaApi')

    expect(
      adapterStands({
        ...base,
        capabilities: { ...base.capabilities, readsImportErrors: true },
      })[0],
    ).toContain('no parseImportErrors')

    expect(adapterStands({ ...base, version: 'v1' })[0]).toContain('major.minor')

    expect(
      adapterStands({ ...base, capabilities: { ...base.capabilities, fileTypes: [] } }).join(' '),
    ).toContain('no way to deliver anything')
  })

  it('declares a null supported-version list only where the question does not apply', () => {
    // The universal package is not a version of anybody's product. For a real
    // target, `null` would be a worksheet that was never done.
    expect(universalAdapter.supportedVersions).toBeNull()
    expect(universalAdapter.capabilities.transmits).toBe(false)
    expect(universalAdapter.capabilities.fileTypes).toEqual(['csv', 'txt'])
  })
})

describe('which return a set of books feeds', () => {
  it('names the return for every classification, because that is the fact an adapter needs', () => {
    expect(TAX_CLASSIFICATIONS).toHaveLength(8)

    for (const classification of TAX_CLASSIFICATIONS) {
      // A list of names with no returns beside them invites somebody to pick
      // "LLC", which is not a tax classification at all.
      expect(classification.filesAs, classification.key).toMatch(/Form|Schedule/)
    }

    expect(classificationFor('s_corporation').filesAs).toContain('1120-S')
    expect(classificationFor('nonprofit').filesAs).toContain('990')
    expect(() => classificationFor('llc')).toThrow(RegistryError)
  })

  it('tells the two LLC classifications apart by what they are taxed as', () => {
    // The client calls itself an LLC and would not find itself in a list of
    // "sole proprietor" and "partnership". The election is the thing a preparer
    // needs told rather than inferred.
    expect(classificationFor('single_member_llc').filesAs).toBe(
      classificationFor('sole_proprietor').filesAs,
    )
    // The same return, worded for the reader: a partnership has partners and an
    // LLC has members, and a preparer choosing from the list is choosing the
    // return.
    expect(classificationFor('multi_member_llc').filesAs).toContain('Form 1065')
    expect(classificationFor('partnership').filesAs).toContain('Form 1065')
    expect(classificationFor('multi_member_llc').filesAs).toContain('members')
    expect(classificationFor('partnership').filesAs).toContain('partners')
  })
})
