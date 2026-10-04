/**
 * Whether a set of books is fit to hand to an accountant's software (Phase 158).
 *
 * Exporter spec §11 lists eleven things to check before an export and asks for
 * *"a green / yellow / red readiness status before export, together with a
 * human-readable exception report."* This is that, as a pure function over
 * facts — no database, no clock, so every state can be written down in a test
 * including the ones real books are hard to get into.
 *
 * ## Why reconciliation is a check here and not everywhere
 *
 * §15 requires that *"the exported totals reconcile exactly to the Accountrix
 * reports for the same period."* There are two ways to satisfy that and only one
 * of them is sound.
 *
 * The unsound one is for the exporter to write its own query — sum the journal
 * lines itself — and then compare its answer to the report's. That is two
 * answers to one question, which this project has called the defect since Phase
 * 100, and the comparison is a check that will one day disagree and leave an
 * accountant holding two trial balances with no way to tell which is the books.
 *
 * So `assemble` calls `trialBalance`: the same function the screen calls. There
 * is then nothing to reconcile, because it is the same number — a constraint
 * where a check would have been (Phase 116).
 *
 * What remains is genuinely worth checking, and it is narrower than §15's
 * sentence suggests. The one place a figure can change between the report and
 * the file is **rendering** — cents to units, `108000` to `1,080.00` — and a
 * rounding slip or a thousands separator there produces a file that looks right
 * and foots to something else. So `totals_reconcile_to_source` compares the
 * report's totals against the figures *parsed back out of the rendered file*.
 * It checks the step that can actually fail.
 *
 * ## Why the mapping checks are declared before there is a mapping store
 *
 * §11 requires that *"all required accounts have target mappings"* and *"all
 * required tax codes are present"*, and §10's mapping-and-learning store does
 * not exist yet. Three of these checks therefore have `scope:
 * 'mapped-destination'`, and the fact they read is deliberately **nullable**:
 * `null` means nobody has established a mapping, which is not the same as
 * having established that nothing is unmapped.
 *
 * `null` is red. Asking to export this company's books to Lacerte today gets
 * *"no account mapping has been established for Lacerte"*, which is true,
 * actionable, and arrives from the check rather than from a missing feature
 * failing silently. Phase 157's rule applies: a declared value with no users is
 * kept when it accuses and deleted when it excuses, and these accuse.
 */

import { RegistryError } from '@/modules/errors/registry'
import {
  destinationFor,
  type DestinationKind,
  type ExportDestination,
} from './destinations'

/**
 * The three states §11 asks for.
 *
 * Ordered worst-first, because that is how `assess` folds them and how an
 * accountant reads the report.
 */
export type Readiness = 'red' | 'yellow' | 'green'

/**
 * What a failed check costs.
 *
 * - `red` — the export does not happen. The books are not a set of books, or
 *   the destination cannot be given what it needs, and sending the file anyway
 *   makes the firm's problem worse than having no file.
 * - `yellow` — the export happens and the firm is told. Something is true that
 *   an accountant would want to know and would not want to be stopped by.
 *
 * There is no `green` severity, because green is the absence of exceptions
 * rather than a kind of exception. A check that can only pass would be Phase
 * 121's *"a check only ever seen to agree is not a check"*.
 */
export type Severity = 'red' | 'yellow'

/** Which packages a check is asked of. */
export type CheckScope =
  /** Every export, including the universal package. */
  | 'always'
  /**
   * Only destinations that need Accountrix accounts and tax codes translated
   * into the target's own codes — §3's tax and workpaper products.
   *
   * The universal package is exempt by what it is: §4's CSV and delimited files
   * carry Accountrix's own account numbers because the firm is going to map them
   * in its own system or read them by hand.
   */
  | 'mapped-destination'

/** The facts a readiness assessment is computed from. */
export type PackageFacts = {
  /** The destination the package is being judged for. */
  destinationKey: string

  /** §5's client / entity information, as the questions §11 asks of it. */
  entity: {
    name: string
    /** §5 "Entity type and tax classification" — drives which return it feeds. */
    taxClassification: string | null
    /** 1–12. §5 "Fiscal year and tax year". */
    fiscalYearEndMonth: number | null
    /**
     * Whether an EIN or TIN is on file — not the number itself.
     *
     * §12 says *"do not include sensitive fields that are not required by the
     * target system"*, and a readiness assessment is a thing that gets logged,
     * shown on screen and screenshotted into support tickets. Whether one exists
     * is the whole question this check asks, so the number has no business here.
     */
    hasTaxIdentifier: boolean
  }

  /** The export window. Inclusive both ends, as the ledger reports take it. */
  period: { startDate: string; endDate: string }

  /** Straight from `trialBalance`, not recomputed. */
  trialBalance: {
    totalDebitCents: number
    totalCreditCents: number
    rowCount: number
  }

  /**
   * §11 "Beginning balance continuity", as the question the ledger can answer.
   *
   * The obvious reading — *does this period's opening equity equal the prior
   * period's closing equity* — is not a check at all: both figures come from
   * summing the same journal lines to the same date, so they agree by
   * construction and the check could only ever pass. Phase 121.
   *
   * The real break is the one `staleCloses` already measures. Closing and
   * locking are deliberately separate in this ledger, so an entry can be posted
   * into a year that has already been closed; the books still balance, and the
   * figure the close moved into retained earnings is now wrong. That is exactly
   * an opening balance that does not carry forward, and it is a fact rather than
   * an identity.
   *
   * `null` when the person running the export cannot read closes — the manifest
   * records that omission under §12, and asserting continuity from figures
   * nobody was allowed to read would be worse than saying nothing.
   */
  continuity:
    | readonly { fiscalYear: number; driftCents: number; entriesSinceCloseCount: number }[]
    | null

  /** Lines whose entry does not exist, or whose account does not. */
  orphanLineCount: number

  /** Entries in the window that are drafted and not posted. */
  unpostedEntryCount: number

  /** Every account number in the package, in file order. */
  accountNumbers: readonly string[]

  /**
   * §11 "All required accounts have target mappings".
   *
   * `null` means no mapping has been established for this destination, which is
   * the state every §3 target is in until §10's store exists. Zero means a
   * mapping exists and covers everything.
   */
  unmappedAccountCount: number | null

  /** §11 "All required tax codes are present". Same `null`. */
  missingTaxCodeCount: number | null

  /**
   * Whether the adapter's declared format version matches what the vendor's
   * current documentation says (§10's last bullet).
   *
   * `null` until a worksheet records a version to compare against.
   */
  formatVersionConfirmed: boolean | null

  /**
   * The totals read back out of the rendered file.
   *
   * Not the exporter's own sum of the ledger — see this module's opening note.
   * `null` when nothing has been rendered yet, which is how a caller asks for a
   * readiness opinion *before* building the package, as §9's workflow does:
   * *"Accountrix checks that the books balance"* comes before *"Accountrix
   * generates the destination-specific package"*.
   */
  rendered: { totalDebitCents: number; totalCreditCents: number } | null

  /**
   * What the general ledger detail foots to.
   *
   * A different question from `rendered`, and the one §11's *"export totals
   * reconcile to Accountrix source reports"* is really about. The package
   * carries a trial balance summed per account by `accountBalances` and a
   * ledger detail read line by line, and a firm will foot one to the other
   * because that is what a workpaper review does.
   *
   * They are two queries with separately written filters — posted only, inside
   * the window, joined to an account that exists — so they can genuinely
   * disagree, and when they do the detail is the half that is wrong.
   */
  detail: { totalDebitCents: number; totalCreditCents: number } | null
}

/** One §11 requirement, as something that can be asked of a package. */
export type ReadinessCheck = {
  /** Stable code, logged and shown. */
  code: string
  /** The §11 or §10 clause this implements, in the specification's words. */
  clause: string
  severity: Severity
  scope: CheckScope
  /** Why it is that severity rather than the other one. */
  because: string
  /**
   * The sentence an accountant reads, or `null` when the package passes.
   *
   * Returns prose rather than a boolean because the useful part of an exception
   * report is the figure: *"debits exceed credits by $412.00"* ends the problem
   * and *"debits do not equal credits"* starts a search.
   */
  detect: (facts: PackageFacts, destination: ExportDestination) => string | null
}

/** Cents as an amount a person reads, for exception sentences. */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`
}

/**
 * Characters an account identifier may carry into a professional system.
 *
 * Deliberately narrow: digits, letters, hyphen, full stop. §11 asks for *"no
 * unsupported account identifiers or characters"* and §7 says not to assume what
 * a target accepts, so this is the intersection every plausible target handles
 * rather than a guess at any one of them. Being told that `4000 · Sales` will
 * need attention is useful even when it turns out the target would have coped.
 */
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9.-]+$/

/**
 * §11's checks, each arguing for its own severity (Exporter spec §11, §10).
 *
 * The registry-with-prose device (Phase 101): the list is the specification of
 * what "validated" means, and `tests/export-readiness.test.ts` asserts it covers
 * every clause §11 names.
 */
export const READINESS_CHECKS: readonly ReadinessCheck[] = [
  {
    code: 'has_accounts',
    clause: '§11 — export totals reconcile to Accountrix source reports',
    severity: 'red',
    scope: 'always',
    because:
      'An export with no accounts in it is not a trial balance with nothing in it; it is a ' +
      'question about whether the period, the company or the permission was wrong. A firm that ' +
      'receives an empty file will assume the client has no books rather than that the export ' +
      'picked the wrong window.',
    detect: (facts) =>
      facts.trialBalance.rowCount === 0
        ? `No accounts have any activity between ${facts.period.startDate} and ${facts.period.endDate}, so there is nothing to export. Check the period and the company before sending an empty file.`
        : null,
  },
  {
    code: 'debits_equal_credits',
    clause: '§11 — debits equal credits',
    severity: 'red',
    scope: 'always',
    because:
      'The one check that is not about the export at all. Every entry is validated as balanced on ' +
      'the way in, so the columns can only disagree if something wrote around the journal service, ' +
      'and that means the ledger is wrong rather than the file. Sending it would make a firm ' +
      'reconcile somebody else’s defect.',
    detect: (facts) => {
      const difference = facts.trialBalance.totalDebitCents - facts.trialBalance.totalCreditCents
      if (difference === 0) return null
      const side = difference > 0 ? 'Debits exceed credits' : 'Credits exceed debits'
      return `${side} by ${money(Math.abs(difference))}. The ledger itself does not balance for this period, which no export can repair — the entries need looking at before anything is sent out.`
    },
  },
  {
    code: 'beginning_balance_continuity',
    clause: '§11 — beginning balance continuity',
    severity: 'red',
    scope: 'always',
    because:
      'An opening balance that does not carry forward is two sets of books presented as one. A ' +
      'workpaper system ties the opening balance to last year’s signed file, finds the difference, ' +
      'and treats every figure after it as suspect — and it is right to, because the equity in ' +
      'these books no longer reflects the profit that was transferred into it.',
    detect: (facts) => {
      // Null is "nobody was allowed to look", recorded in the manifest under
      // §12 rather than asserted here either way.
      if (facts.continuity === null) return null
      const drifted = facts.continuity.filter((close) => close.driftCents !== 0)
      if (drifted.length === 0) return null

      return drifted
        .map(
          (close) =>
            `The ${close.fiscalYear} year was closed and then had ${close.entriesSinceCloseCount} ` +
            `entr${close.entriesSinceCloseCount === 1 ? 'y' : 'ies'} posted into it, so the profit ` +
            `transferred to retained earnings is out by ${money(Math.abs(close.driftCents))}. The ` +
            'opening balances in this package carry that difference forward. Reopening and ' +
            're-closing the year puts it right.',
        )
        .join(' ')
    },
  },
  {
    code: 'no_orphan_journal_lines',
    clause: '§11 — no orphan journal lines',
    severity: 'red',
    scope: 'always',
    because:
      'An orphan line is money in the trial balance totals that belongs to no entry and so appears ' +
      'in no general ledger detail. The summary and the detail then disagree in a file the firm ' +
      'will tie one to the other.',
    detect: (facts) =>
      facts.orphanLineCount === 0
        ? null
        : `${facts.orphanLineCount} journal line${facts.orphanLineCount === 1 ? '' : 's'} belong to no entry or no account. They would be in the balances and absent from the general ledger detail, so the two halves of the package would not tie.`,
  },
  {
    code: 'no_unposted_entries',
    clause: '§11 — export totals reconcile to Accountrix source reports',
    severity: 'yellow',
    scope: 'always',
    because:
      'A drafted entry is correctly absent: only posted entries are the books, and this project has ' +
      'held that since Phase 12. But an accountant who knows there are eleven drafts sitting in the ' +
      'period will ask about them, and finding out after the return is prepared is worse than ' +
      'reading it here. Yellow rather than red because the file is right either way.',
    detect: (facts) =>
      facts.unpostedEntryCount === 0
        ? null
        : `${facts.unpostedEntryCount} entr${facts.unpostedEntryCount === 1 ? 'y is' : 'ies are'} drafted and not posted in this period. They are correctly excluded — only posted entries are the books — but they are work somebody intended and may need posting before the period is handed over.`,
  },
  {
    code: 'entity_data_complete',
    clause: '§11 — entity and fiscal-year data are complete',
    severity: 'red',
    scope: 'always',
    because:
      'Entity type decides which return the figures feed and fiscal year end decides which year ' +
      'they land in. A package that leaves either to be guessed invites a firm to prepare an 1120-S ' +
      'from partnership books, and the file carries no sign that anything was assumed.',
    detect: (facts) => {
      const missing: string[] = []
      if (!facts.entity.name.trim()) missing.push('the entity name')
      if (!facts.entity.taxClassification) missing.push('the entity type or tax classification')
      if (facts.entity.fiscalYearEndMonth === null) missing.push('the fiscal year end')
      return missing.length === 0
        ? null
        : `The client profile is missing ${missing.join(' and ')}. These decide which return the figures belong to and which year they land in, so they cannot be inferred from the ledger.`
    },
  },
  {
    code: 'tax_identifier_present',
    clause: '§7 — client metadata: entity name, EIN/TIN handling, fiscal year, entity type',
    severity: 'yellow',
    scope: 'always',
    because:
      'A firm preparing a return needs the EIN and almost certainly already has it on the engagement ' +
      'letter, so a missing one is a thing to mention rather than a reason to withhold a trial ' +
      'balance. It becomes red only for a destination whose own import requires it, which is a ' +
      'fact for that destination’s worksheet to establish rather than for this check to assume.',
    detect: (facts) =>
      facts.entity.hasTaxIdentifier
        ? null
        : 'No EIN or TIN is on file for this client. Most professional systems key a client record on it, so the firm will need it from somewhere — the package itself is unaffected.',
  },
  {
    code: 'date_range_valid',
    clause: '§11 — date ranges are valid',
    severity: 'red',
    scope: 'always',
    because:
      'A window that ends before it starts produces an empty file rather than an error, and an empty ' +
      'file is indistinguishable from a client with no activity. Caught here it is a typo; caught by ' +
      'the firm it is a phone call.',
    detect: (facts) => {
      const { startDate, endDate } = facts.period
      const shape = /^\d{4}-\d{2}-\d{2}$/
      if (!shape.test(startDate) || !shape.test(endDate)) {
        return `The export period (${startDate} to ${endDate}) is not a pair of calendar dates.`
      }
      return endDate < startDate
        ? `The export period ends on ${endDate}, before it starts on ${startDate}. Nothing falls inside it, so the package would be empty for a reason the firm could not see.`
        : null
    },
  },
  {
    code: 'account_identifiers_portable',
    clause: '§11 — no unsupported account identifiers or characters',
    severity: 'yellow',
    scope: 'always',
    because:
      '§7 forbids assuming what a target accepts, so this cannot be red: refusing an export because ' +
      'an account number contains a slash would be this project declaring a limit it has not ' +
      'established. Naming the accounts is the useful half, and the accountant can decide.',
    detect: (facts) => {
      const awkward = facts.accountNumbers.filter((number) => !PORTABLE_IDENTIFIER.test(number))
      if (awkward.length === 0) return null
      const shown = awkward.slice(0, 5).map((number) => `"${number}"`).join(', ')
      const rest = awkward.length > 5 ? ` and ${awkward.length - 5} more` : ''
      return `${awkward.length} account number${awkward.length === 1 ? '' : 's'} contain characters outside digits, letters, hyphen and full stop: ${shown}${rest}. Professional systems vary in what they accept, and one that rejects a character usually rejects the whole import rather than the row.`
    },
  },
  {
    code: 'no_duplicate_account_numbers',
    clause: '§11 — no duplicate unique IDs where the target forbids them',
    severity: 'red',
    scope: 'always',
    because:
      'Account number is the key every target joins on. Two accounts sharing one means the import ' +
      'either rejects the file or merges two balances into whichever row it saw last, and the second ' +
      'outcome is silent.',
    detect: (facts) => {
      const seen = new Set<string>()
      const duplicates = new Set<string>()
      for (const number of facts.accountNumbers) {
        if (seen.has(number)) duplicates.add(number)
        seen.add(number)
      }
      if (duplicates.size === 0) return null
      return `Account number${duplicates.size === 1 ? '' : 's'} ${[...duplicates].map((n) => `"${n}"`).join(', ')} appear more than once. Account number is the key every professional system joins on, so a duplicate either rejects the import or merges two balances into one row without saying so.`
    },
  },
  {
    code: 'totals_reconcile_to_source',
    clause: '§15 — the exported totals reconcile exactly to the Accountrix reports for the same period',
    severity: 'red',
    scope: 'always',
    because:
      'This is the narrowest the check can honestly be and still mean anything. The package is built ' +
      'from the same `trialBalance` the screen shows, so the figures cannot differ; what can differ ' +
      'is how they were written down. Reading the file back and footing it tests the rendering, ' +
      'which is the only step between the report and the firm.',
    detect: (facts) => {
      // Null is a readiness opinion asked before the file exists — §9 asks for
      // the balance check before the package is generated, in that order.
      if (facts.rendered === null) return null
      const debitGap = facts.rendered.totalDebitCents - facts.trialBalance.totalDebitCents
      const creditGap = facts.rendered.totalCreditCents - facts.trialBalance.totalCreditCents
      if (debitGap === 0 && creditGap === 0) return null
      return `The rendered file foots to ${money(facts.rendered.totalDebitCents)} / ${money(facts.rendered.totalCreditCents)} where the trial balance reports ${money(facts.trialBalance.totalDebitCents)} / ${money(facts.trialBalance.totalCreditCents)}. The figures came from the same report, so the difference is in how they were written to the file.`
    },
  },
  {
    code: 'detail_ties_to_balances',
    clause: '§11 — export totals reconcile to Accountrix source reports',
    severity: 'red',
    scope: 'always',
    because:
      'The reconciliation a firm actually performs. Two files in one package — balances per account ' +
      'and the lines behind them — read by two queries whose filters were written separately, so a ' +
      'date comparison that is exclusive at one end or a join that drops a retired account shows up ' +
      'here as a difference. Red because a package whose halves do not tie is worse than no ' +
      'package: the firm has to work out which half to believe.',
    detect: (facts) => {
      if (facts.detail === null) return null
      const debitGap = facts.detail.totalDebitCents - facts.trialBalance.totalDebitCents
      const creditGap = facts.detail.totalCreditCents - facts.trialBalance.totalCreditCents
      if (debitGap === 0 && creditGap === 0) return null
      return `The general ledger detail foots to ${money(facts.detail.totalDebitCents)} / ${money(facts.detail.totalCreditCents)} and the trial balance to ${money(facts.trialBalance.totalDebitCents)} / ${money(facts.trialBalance.totalCreditCents)}. The two halves of this package do not tie, so the detail is missing lines the balances include or includes lines they do not.`
    },
  },
  {
    code: 'accounts_mapped',
    clause: '§11 — all required accounts have target mappings',
    severity: 'red',
    scope: 'mapped-destination',
    because:
      'An unmapped account in a tax or workpaper import does not go somewhere approximate; it goes ' +
      'nowhere, and the target’s own total then differs from the trial balance by exactly that ' +
      'account. The accountant finds it by footing two reports, which is the work the export was ' +
      'supposed to save.',
    detect: (facts, destination) => {
      if (facts.unmappedAccountCount === null) {
        return `No account mapping has been established for ${destination.product}. Accountrix account numbers are its own; the target needs its own codes, and §10’s saved mappings are what supply them.`
      }
      return facts.unmappedAccountCount === 0
        ? null
        : `${facts.unmappedAccountCount} account${facts.unmappedAccountCount === 1 ? '' : 's'} have no ${destination.product} mapping. Unmapped accounts are dropped rather than approximated, so the target’s trial balance would differ from this one by exactly their balances.`
    },
  },
  {
    code: 'tax_codes_present',
    clause: '§11 — all required tax codes are present',
    severity: 'red',
    scope: 'mapped-destination',
    because:
      'Same shape as the account mapping and a different consequence: a balance with no tax code ' +
      'lands in the target as an unassigned amount, which does not appear on a return line at all. ' +
      'A return prepared from it is understated and foots.',
    detect: (facts, destination) => {
      if (facts.missingTaxCodeCount === null) {
        return `No tax-code mapping has been established for ${destination.product}. Which codes it requires — return lines, M-1 and M-2 treatment, entity mappings — is what §13’s integration worksheet is for.`
      }
      return facts.missingTaxCodeCount === 0
        ? null
        : `${facts.missingTaxCodeCount} balance${facts.missingTaxCodeCount === 1 ? '' : 's'} have no ${destination.product} tax code. They import as unassigned amounts, which appear on no return line, so the return would be understated and would still foot.`
    },
  },
  {
    code: 'format_version_confirmed',
    clause: '§10 — warnings when the target vendor changes its import specification',
    severity: 'yellow',
    scope: 'mapped-destination',
    because:
      'A vendor changing its import format is not something these books did wrong, and holding an ' +
      'export back on a suspicion would strand a firm at a filing deadline over a field order. ' +
      'Telling them which adapter version produced the file is what lets them judge it.',
    detect: (facts, destination) =>
      facts.formatVersionConfirmed === true
        ? null
        : `The ${destination.product} import format this adapter targets has not been confirmed against the vendor’s current documentation. If the file is rejected, the format is the first thing to re-check — §13’s worksheet records which documentation the adapter was built from.`,
  },
]

/** The check a code names. Throws on one nobody declared. */
export function checkFor(code: string): ReadinessCheck {
  const found = READINESS_CHECKS.find((check) => check.code === code)
  if (!found) {
    throw new RegistryError({
      registry: 'READINESS_CHECKS',
      key: code,
      message:
        `No readiness check is declared as "${code}". Exporter spec §11 is the list, and a new ` +
        'check is an entry there with the clause it implements and an argument for its severity — ' +
        'red stops an export and yellow does not, and which one it is is the whole decision.',
    })
  }
  return found
}

/**
 * Whether a destination needs Accountrix's accounts and tax codes translated.
 *
 * Derived from `kind` rather than declared per destination, because it is a
 * property of what the product *is*: a tax program needs return-line codes and a
 * workpaper program needs a grouped trial balance, and neither can use
 * `4000 — Sales` as it stands. The universal package can, which is why it is the
 * only thing exportable today.
 */
export function requiresMapping(kind: DestinationKind): boolean {
  switch (kind) {
    case 'tax':
    case 'workpapers':
    case 'firm-or-erp':
      return true
    case 'universal':
      return false
  }
}

/** A check that fired, with the sentence it fired with. */
export type Exception = {
  code: string
  severity: Severity
  clause: string
  message: string
}

export type Assessment = {
  status: Readiness
  exceptions: Exception[]
  destination: ExportDestination
  /** True when nothing red fired — the export may proceed. */
  mayProceed: boolean
}

/**
 * The green / yellow / red status §11 asks for, with its exceptions.
 *
 * Green is the absence of exceptions and not a check that passed, which matters:
 * adding a yellow check cannot turn a green package red, and a package with one
 * yellow is not described as clean.
 */
export function assess(facts: PackageFacts): Assessment {
  const destination = destinationFor(facts.destinationKey)
  const mapped = requiresMapping(destination.kind)

  const exceptions: Exception[] = []
  for (const check of READINESS_CHECKS) {
    if (check.scope === 'mapped-destination' && !mapped) continue
    const message = check.detect(facts, destination)
    if (message === null) continue
    exceptions.push({
      code: check.code,
      severity: check.severity,
      clause: check.clause,
      message,
    })
  }

  // Worst first, so the report reads in the order somebody would act in, and
  // within a severity in registry order so two runs of the same books produce
  // the same report.
  exceptions.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1))

  const red = exceptions.some((exception) => exception.severity === 'red')
  const status: Readiness = red ? 'red' : exceptions.length > 0 ? 'yellow' : 'green'

  return { status, exceptions, destination, mayProceed: !red }
}

/**
 * The exception report, as §11's *"human-readable"* asks.
 *
 * Plain text rather than a structure, because the thing it has to survive is
 * being pasted into an email to a client. The `Assessment` is the structure.
 */
export function exceptionReport(assessment: Assessment): string {
  const heading = `${assessment.status.toUpperCase()} — export to ${assessment.destination.product}`

  if (assessment.exceptions.length === 0) {
    return `${heading}\n\nEvery pre-export check passed. The books balance, the opening balance carries forward, the entity and period are complete, and the file foots to the trial balance for the same period.\n`
  }

  const verdict = assessment.mayProceed
    ? 'The export may proceed. These are things the firm should know rather than reasons to hold it:'
    : 'The export is held. Each red item below has to be resolved first; the yellow ones are for information.'

  const items = assessment.exceptions
    .map(
      (exception, index) =>
        `${index + 1}. [${exception.severity.toUpperCase()}] ${exception.message}\n   (${exception.clause})`,
    )
    .join('\n\n')

  return `${heading}\n\n${verdict}\n\n${items}\n`
}
