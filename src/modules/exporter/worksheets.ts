/**
 * What has been found out about each destination, and how far to trust it (Phase 159).
 *
 * Exporter spec §13 requires, before any adapter code, *"a one-page integration
 * worksheet"* answering twelve questions and citing *"what official vendor
 * documentation supports the decision."* Phase 159 did that research for all
 * fourteen Priority 1 targets; the worksheets are in `docs/exporter/worksheets/`
 * and this registry is what the code knows about them.
 *
 * ## The distinction this registry exists to hold
 *
 * **Not one worksheet is `verified`, and that is the finding, not a formality.**
 *
 * The research was done in an environment whose egress policy blocks every
 * vendor documentation host — `accountants.intuit.com`, `developer.intuit.com`,
 * `tax.thomsonreuters.com`, `support.cch.com`, `help-engagement.cchaxcess.com`,
 * `drakesoftware.com`, `documentation.caseware.com`, `riahelp.com`, and every
 * other host tried. Web *search* worked and summarised those pages; fetching
 * them did not.
 *
 * So every answer rests on a summary of a page nobody on this side opened. For
 * most purposes that is good research. For §13's purpose it is specifically not
 * enough, because §13 is a clause about having read the documentation — and a
 * worksheet promoted without reading it would be this project's oldest defect
 * (a declaration argued from a fact that is not a fact, Phases 110 and 125) in
 * the register whose entire job is to be the thing a reader trusts.
 *
 * `draft` therefore means: the research is done, the findings are written down
 * with their provenance, and the adapter still waits. `adapterMayBeBuilt`
 * refuses a `draft` with a different sentence from the one it gives a
 * destination with no worksheet at all, because *"nobody has looked"* and
 * *"somebody looked and could not open the page"* are different problems with
 * different next steps.
 *
 * ## Why `integration` is derived from here rather than stored on the destination
 *
 * Phase 158 put `integration: IntegrationState` on each `ExportDestination`.
 * That was one field too many the moment worksheets existed: the worksheet
 * establishes what the integration path is, so storing it on the destination as
 * well is two answers to one question — and the one that would drift is the
 * copy, silently, into a product decision about what to offer a firm.
 *
 * So `ExportDestination` no longer carries it and `integrationFor` reads it from
 * the worksheet, with `'unresearched'` for a destination that has none. One
 * place says what is known.
 */

import { RegistryError } from '@/modules/errors/registry'

/** How far a worksheet's answers may be trusted. */
export type WorksheetStatus =
  /**
   * Researched and written up, with each answer's provenance marked, and not
   * checked against a page anybody opened.
   *
   * Does not authorise adapter code.
   */
  | 'draft'
  /**
   * Somebody opened the cited vendor pages, confirmed each answer, and obtained
   * a sample file or sandbox where the vendor offers one.
   *
   * Authorises adapter code. Carries `verifiedOn` and `verifiedBy`.
   */
  | 'verified'

/** What the research concluded the integration path is. */
export type IntegrationFinding =
  /** A file the firm imports, by a route the vendor documents. */
  | 'file-import'
  /** An API or SDK Accountrix could call. */
  | 'programmatic'
  /**
   * The research established that there is **no** route a third party can take
   * today.
   *
   * A distinct answer from `file-import` with open questions, and the honest one
   * for two of the fourteen: UltraTax CS imports only from a closed list of
   * named vendors, and ProConnect Tax's only documented trial-balance ingress is
   * from QuickBooks Online Accountant inside Intuit's own stack. Neither is
   * waiting on more searching; both are waiting on a vendor answering a
   * question.
   */
  | 'no-third-party-path'

export type Worksheet = {
  /** The `EXPORT_DESTINATIONS` key this worksheet is about. */
  destinationKey: string
  status: WorksheetStatus
  finding: IntegrationFinding
  /** Path under `docs/`, so a refusal can tell somebody where to read. */
  path: string
  /** One sentence: the recommended path, as the worksheet concluded it. */
  recommendation: string
  /**
   * What must be confirmed before this becomes an adapter.
   *
   * Not a formality either: the worksheet's own "what must be confirmed"
   * section, reduced to the single item that would change the design if it came
   * back the wrong way. It goes in the refusal, so somebody reading why they
   * cannot export knows what question is outstanding.
   */
  blocker: string
  /** Whether a vendor approval, programme or form stands in front of the path. */
  needsVendorApproval: boolean
  /** Set only on a `verified` worksheet. */
  verifiedOn?: string
  verifiedBy?: string
}

/**
 * The fourteen Priority 1 worksheets (Exporter spec §13).
 *
 * Ordered by how close each is to being buildable, worst last, because that is
 * the order somebody planning the next phase wants to read them in — and because
 * a registry sorted by priority would put the two with no path at the top.
 */
export const WORKSHEETS: readonly Worksheet[] = [
  {
    destinationKey: 'caseware-working-papers',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/caseware-working-papers.md',
    recommendation:
      'Two CSV files Accountrix already produces: chart of accounts plus trial balance for one ' +
      'component, general ledger detail for the other. Its import wizard takes plain CSV and its ' +
      'one-file-per-component rule is the split the universal package already has.',
    blocker:
      'The file-requirements page was not reached, so the column names, header handling and ' +
      'debit/credit convention are unconfirmed.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'caseware-cloud',
    status: 'draft',
    finding: 'programmatic',
    path: 'docs/exporter/worksheets/caseware-cloud.md',
    recommendation:
      'The CSV import first, then the REST API — and this is the only target whose API needs no ' +
      'permission from the vendor: the firm registers its own API client and Caseware’s usage ' +
      'policy expressly allows a third party to build against customer-issued credentials.',
    blocker:
      'That there is a trial-balance endpoint is an inference from the product’s capabilities ' +
      'rather than something the research established. If it is wrong this target is file-import.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'cch-axcess-engagement',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/cch-axcess-engagement.md',
    recommendation:
      'An .xlsx with one worksheet, accounts from row 2, and separate current-period debit and ' +
      'credit columns — both required. Up to 40,000 accounts. CSV also works through the Data ' +
      'Import Wizard, so an adapter can ship before a spreadsheet writer exists.',
    blocker:
      'Account *name* must be unique, and Accountrix guarantees unique numbers rather than unique ' +
      'names — two accounts may legitimately be called "Miscellaneous".',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'cch-prosystem-fx-engagement',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/cch-prosystem-fx-engagement.md',
    recommendation:
      'An Excel trial balance with Account # first, Description second, and one signed balance ' +
      'column — credits negative or parenthesised. The opposite convention from CCH Axcess ' +
      'Engagement, which is the same vendor.',
    blocker:
      'Whether the import maps columns by position or by name, which decides whether the file ' +
      'carries a header row.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'cch-prosystem-fx-tax',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/cch-prosystem-fx-tax.md',
    recommendation:
      'G/L Direct with a custom import template: tab-delimited or comma-delimited text, no header, ' +
      'no footer, no total lines, no dollar signs, no thousands separators, minus sign rather than ' +
      'parentheses. The firm defines the template once; no vendor relationship needed.',
    blocker:
      'Whether a tax code column is required, or whether the preparer maps accounts to return ' +
      'lines in the grid after import — which decides whether §10’s mapping store comes first.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'cch-axcess-tax',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/cch-axcess-tax.md',
    recommendation:
      'The same G/L Direct file as ProSystem fx Tax. There is a real REST API behind Wolters ' +
      'Kluwer’s Open Integration Platform, and it is the right long-term answer once a customer ' +
      'sponsors the credential request — the file needs nobody’s permission today.',
    blocker:
      'Whether Axcess G/L Direct has the same file rules as ProSystem fx. The two are documented ' +
      'separately and this worksheet assumes they match.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'workpapers-cs',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/workpapers-cs.md',
    recommendation:
      'A spreadsheet for the Spreadsheet Import Wizard. Worth more than its own import: it ' +
      'transfers adjusted balances onward to UltraTax CS and GoSystem Tax RS, which is the route ' +
      'into UltraTax that does not require being on a closed vendor list.',
    blocker:
      'The wizard’s column contract. The documented pages describe importing from ATB and from ' +
      'QuickBooks-produced spreadsheets; whether a generic spreadsheet is accepted, and with which ' +
      'headings, is unconfirmed.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'accounting-cs',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/accounting-cs.md',
    recommendation:
      'A chart-of-accounts spreadsheet with balances, built from the published sample. The only ' +
      'one of the fourteen with a documented transaction-level import, so the only plausible home ' +
      'for §5’s general ledger detail.',
    blocker:
      'Re-importing an existing account zeroes its balances for the dates covered and then imports ' +
      'only what is in the file. An adapter that gets this wrong deletes a client’s balances ' +
      'rather than failing.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'gosystem-tax-rs',
    status: 'draft',
    finding: 'programmatic',
    path: 'docs/exporter/worksheets/gosystem-tax-rs.md',
    recommendation:
      'The built-in Trial Balance’s spreadsheet import first; the API second. Thirty-eight ' +
      'documented REST APIs sit behind a developer account and a completed API request form, and ' +
      'their documented purpose is return-level automation rather than delivering a trial balance.',
    blocker:
      'The Trial Balance is documented for 1065 and 1120 returns. If it really is limited to two ' +
      'entity types, that materially narrows this target.',
    needsVendorApproval: true,
  },
  {
    destinationKey: 'lacerte',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/lacerte.md',
    recommendation:
      'An Excel or CSV trial balance for the Trial Balance Utility. Intuit publishes a Lacerte SDK ' +
      '— an ODBC driver and a COM/.NET library — and it is the wrong path for a web application: ' +
      'reaching it means shipping a Windows agent the firm installs beside their tax software.',
    blocker:
      'The account Type column takes A, L, R or E. Accountrix has five account types and equity ' +
      'has no letter in that list.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'drake-tax',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/drake-tax.md',
    recommendation:
      'A sheet shaped like the data region of Drake’s own template, for the preparer to paste in. ' +
      'The template is generated by Drake per client, lives in the software’s TB folder, carries ' +
      'macros, and modifying it is documented as corrupting the import — so it is a file Accountrix ' +
      'would have to be handed rather than a format it can implement.',
    blocker:
      'Whether values pasted into the vendor’s macro-bearing template survive, and what the exact ' +
      'data region is.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'proseries',
    status: 'draft',
    finding: 'file-import',
    path: 'docs/exporter/worksheets/proseries.md',
    recommendation:
      'Do not build this yet. Every substantive answer is secondary — a 2012 trade review and ' +
      'community threads — and three separate threads report the trial balance import breaking ' +
      'across product years. Leave ProSeries on the universal package.',
    blocker:
      'Whether the current product still accepts .txf from "any accounting program". If yes this ' +
      'target goes from worst to best, because .txf is a published interchange format rather than ' +
      'a vendor’s private layout. If no, it stays last.',
    needsVendorApproval: false,
  },
  {
    destinationKey: 'ultratax-cs',
    status: 'draft',
    finding: 'no-third-party-path',
    path: 'docs/exporter/worksheets/ultratax-cs.md',
    recommendation:
      'Reach it indirectly, through Caseware Working Papers or Workpapers CS, both of which export ' +
      'onward to UltraTax by routes their own vendors document. UltraTax imports from a closed menu ' +
      'of named vendors — Utilities → Third Party → <vendor> — and Accountrix is not on it.',
    blocker:
      'How a product joins that third-party list, which is a question for Thomson Reuters rather ' +
      'than more research. The claim that the list is closed is itself the least well sourced thing ' +
      'in the worksheet and the most consequential, so confirm it first.',
    needsVendorApproval: true,
  },
  {
    destinationKey: 'proconnect',
    status: 'draft',
    finding: 'no-third-party-path',
    path: 'docs/exporter/worksheets/proconnect.md',
    recommendation:
      'The universal package, and say so plainly. Every documented trial-balance route into ' +
      'ProConnect runs QuickBooks Online Accountant → Prep for Taxes → Books to Tax, inside ' +
      'Intuit’s own stack, with no file leaving it and no third-party entry point.',
    blocker:
      'Whether Intuit offers any third-party trial-balance ingress to ProConnect at all. No amount ' +
      'of searching answers this one.',
    needsVendorApproval: true,
  },
]

/** The worksheet for a destination, or `null` when none has been written. */
export function worksheetFor(destinationKey: string): Worksheet | null {
  return WORKSHEETS.find((row) => row.destinationKey === destinationKey) ?? null
}

/** The worksheet for a destination. Throws when none exists. */
export function requireWorksheet(destinationKey: string): Worksheet {
  const found = worksheetFor(destinationKey)
  if (!found) {
    throw new RegistryError({
      registry: 'WORKSHEETS',
      key: destinationKey,
      message:
        `No integration worksheet is declared for "${destinationKey}". Exporter spec §13 requires ` +
        'one before production code — twelve questions answered and the official vendor ' +
        'documentation that supports each answer — so a new one is a page in ' +
        'docs/exporter/worksheets/ and an entry in that registry.',
    })
  }
  return found
}

/** Worksheets somebody has checked against the pages they cite. */
export function verifiedWorksheets(): Worksheet[] {
  return WORKSHEETS.filter((row) => row.status === 'verified')
}

/**
 * Whether a destination's own coherence rules hold.
 *
 * Not type-checkable, because each clause relates two fields. Asserted over
 * every entry in `tests/export-worksheets.test.ts`.
 */
export function worksheetStands(worksheet: Worksheet): string[] {
  const faults: string[] = []

  if (worksheet.status === 'verified' && (!worksheet.verifiedOn || !worksheet.verifiedBy)) {
    faults.push(
      `${worksheet.destinationKey} is verified and does not say when or by whom. Verification is ` +
        'somebody opening the cited pages, so it has a date and a name or it did not happen.',
    )
  }
  if (worksheet.status === 'draft' && (worksheet.verifiedOn || worksheet.verifiedBy)) {
    faults.push(
      `${worksheet.destinationKey} is a draft carrying verification details. One of the two is ` +
        'wrong, and the dangerous reading is that it was verified and somebody forgot to promote it.',
    )
  }
  if (!worksheet.path.startsWith('docs/exporter/worksheets/')) {
    faults.push(`${worksheet.destinationKey} does not point at a worksheet page.`)
  }
  if (worksheet.finding === 'no-third-party-path' && !worksheet.needsVendorApproval) {
    faults.push(
      `${worksheet.destinationKey} has no third-party path and claims to need no vendor approval. ` +
        'If there is no route a third party can take, the route runs through the vendor by ' +
        'definition.',
    )
  }
  if (worksheet.blocker.trim().length === 0) {
    faults.push(
      `${worksheet.destinationKey} names nothing outstanding. A worksheet with no open question is ` +
        'either verified or has not been read closely enough to find one.',
    )
  }

  return faults
}
