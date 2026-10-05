/**
 * Where a client's books may be exported to, and where they may not (Phase 158).
 *
 * From the Accountrix Plus Professional Accountant Export Engine specification.
 * Two registries, and the first one is the point.
 *
 * ## The exclusion is a product decision, so it is a constraint and not a note
 *
 * Exporter spec §2 names a list of products that must not be export
 * destinations, and §15's first acceptance criterion is *"Direct competitor
 * bookkeeping products are not presented as export destinations."* A sentence in
 * a document cannot enforce that; the next person to add a destination will not
 * have read it.
 *
 * So the excluded products are declared here with their reason, `mayExportTo`
 * refuses them, and a test asserts that no entry in `EXPORT_DESTINATIONS`
 * appears in `EXCLUDED_DESTINATIONS`. A constraint beats a check (Phase 116),
 * and a check beats a paragraph.
 *
 * The exclusion is **not** a claim that these products are bad or that their
 * formats are unknowable. §2 says so itself: *"These products may still be
 * researched as source-data references or migration sources."* Reading
 * QuickBooks to bring books *in* is a different act from pushing books *out* to
 * it, and only the second is refused.
 *
 * ## The targets are declared unresearched, on purpose
 *
 * Exporter spec §7 is blunt: *"Do not assume an API exists. Professional tax and
 * workpaper products often rely on vendor-specific import files, trial-balance
 * mappings, desktop utilities, SDKs, partner programs, or controlled
 * integrations."* And §13 requires a one-page integration worksheet, citing
 * official vendor documentation, **before** adapter code is written.
 *
 * Phase 158 therefore marked every target `unresearched` and Phase 159 did the
 * research: fourteen worksheets in `docs/exporter/worksheets/`, registered in
 * `worksheets.ts`. **Not one of them is verified**, because the research ran in
 * an environment whose egress policy blocked every vendor documentation host, so
 * every answer rests on a summary of a page nobody opened. §13 is a clause about
 * having read the documentation, so `adapterMayBeBuilt` still refuses all
 * fourteen — with a different sentence from before, because "nobody has looked"
 * and "somebody looked and could not open the page" are different problems.
 *
 * What the research found, which is the argument for having done it this way:
 * **twelve of fourteen are file imports**, one of the two programmatic paths
 * needs a vendor's approval, and two targets have no third-party route at all.
 * An exporter built on the assumption that professional software is reached
 * through APIs would have been wrong about twelve of fourteen. Writing
 * `api: 'REST'` against any of them would have been this project's oldest defect
 * — a declaration argued from a fact that is not a fact (Phases 110, 125) — in
 * the one place where being wrong means a firm's trial balance silently fails to
 * arrive.
 */

import { RegistryError } from '@/modules/errors/registry'
import { worksheetFor } from './worksheets'

/** Why a product is not an export destination. */
export type ExclusionGround =
  /**
   * It is an owner-facing bookkeeping product Accountrix Plus competes with.
   *
   * Exporter spec §1: the engine *"must NOT be designed primarily to send data
   * into direct competitors"*, because the product's own market is everyday
   * small-business bookkeeping.
   */
  | 'direct-competitor'

export type ExcludedDestination = {
  /**
   * The key this product would have had, had it been a destination.
   *
   * It is here so that asking for it gets the **decision** rather than
   * `RegistryError`'s "nobody declared that". A caller who asks for
   * `quickbooks-online` has not made a typo; they have asked a question with an
   * answer, and the answer is a sentence somebody wrote on purpose.
   */
  key: string
  /** The product, as the specification names it. */
  product: string
  ground: ExclusionGround
  /** Why, in terms somebody deciding can weigh rather than defer to. */
  because: string
}

/**
 * Products that are not export destinations (Exporter spec §2).
 *
 * Named individually rather than caught by a rule, because "is this a
 * competitor" is a business judgement and a regex over product names would
 * either miss the next one or refuse something legitimate. §2 says the list may
 * be revisited by *"a future business decision"*, which is a decision somebody
 * makes and records here — not a default the code drifts into.
 */
export const EXCLUDED_DESTINATIONS: readonly ExcludedDestination[] = [
  {
    key: 'quickbooks-online',
    product: 'QuickBooks Online',
    ground: 'direct-competitor',
    because:
      'The product Accountrix Plus most directly replaces. Exporting a client’s books into it ' +
      'would be building the migration path off this platform as a feature of this platform. Note ' +
      'that the opposite direction is explicitly allowed by §2 — QuickBooks as a source to read ' +
      'books *in* from is a migration tool, and this session even has its connector available for ' +
      'exactly that.',
  },
  {
    key: 'quickbooks-desktop',
    product: 'QuickBooks Desktop',
    ground: 'direct-competitor',
    because:
      'The same product family and the same reason. Listed separately because its import path is ' +
      'an entirely different thing — IIF and QBXML against a local file — so somebody researching ' +
      'adapters would otherwise find it unlisted and assume it had not been considered.',
  },
  {
    key: 'freshbooks',
    product: 'FreshBooks',
    ground: 'direct-competitor',
    because:
      'Owner-facing invoicing and bookkeeping for small service businesses, which is the market ' +
      'Accountrix Plus is built for. §1 excludes it by that description rather than by size.',
  },
  {
    key: 'xero',
    product: 'Xero',
    ground: 'direct-competitor',
    because:
      'Small-business bookkeeping with an accountant-facing partner programme attached. The ' +
      'partner programme is what makes it tempting to treat as a professional destination, and §2 ' +
      'names it anyway: the product a client keeps their books in is a competitor whoever else ' +
      'logs into it.',
  },
  {
    key: 'wave',
    product: 'Wave',
    ground: 'direct-competitor',
    because:
      'Free owner-facing bookkeeping, and the clearest case in the list — a product whose whole ' +
      'proposition is being the small business’s ledger.',
  },
  {
    key: 'zoho-books',
    product: 'Zoho Books',
    ground: 'direct-competitor',
    because:
      'Owner-facing bookkeeping inside a wider business suite. The suite is not the point; the ' +
      'ledger is, and §2 names the ledger.',
  },
  {
    key: 'sage-accounting',
    product: 'Sage Accounting (small-business bookkeeping products)',
    ground: 'direct-competitor',
    because:
      'Qualified in §2 as *"Sage Accounting products positioned primarily as small-business ' +
      'bookkeeping replacements"*, which is a narrower exclusion than the vendor. Sage Intacct is ' +
      'a Priority 2 **target** in §3 — same vendor, different product, different market — so this ' +
      'entry is about a product’s position and not a company’s name.',
  },
]

/**
 * The exclusion a key or a product name matches, or `null`.
 *
 * Both, because the two callers ask differently: a dropdown asks by key and a
 * person typing into a search box asks by name, and the answer is the same
 * decision either way.
 */
export function exclusionFor(keyOrProduct: string): ExcludedDestination | null {
  const wanted = keyOrProduct.trim().toLowerCase()
  return (
    EXCLUDED_DESTINATIONS.find(
      (row) => row.key === wanted || row.product.toLowerCase() === wanted,
    ) ?? null
  )
}

/**
 * What is known about how a destination can actually be reached.
 *
 * Exporter spec §7's point, as a type: the absence of research is a state the
 * code can hold, rather than something a comment hopes somebody remembers.
 *
 * **Derived from the worksheet, never stored on a destination.** Phase 158 put
 * this on `ExportDestination` and Phase 159 took it off, because once worksheets
 * existed the destination's copy was a second answer to a question the worksheet
 * already answers — and the copy is the one that drifts, silently, into a
 * product decision about what to offer a firm. `integrationFor` is the reader.
 */
export type IntegrationState =
  /**
   * Nobody has done §13's worksheet for this product yet.
   *
   * The honest default and the only value the specification permits before
   * research. `adapterMayBeBuilt` refuses an adapter for one of these.
   */
  | 'unresearched'
  /**
   * A worksheet exists and has not been checked against the pages it cites.
   *
   * Phase 159's finding, and the state all fourteen Priority 1 targets are in:
   * the research is done and written up, and every answer rests on a summary of
   * a vendor page that the egress policy would not let anybody open. §13 is a
   * clause about having read the documentation, so this is short of it.
   */
  | 'researched-unverified'
  /**
   * The worksheet is verified and says the path is a generated file plus
   * instructions (§8's `generateManualImportInstructions`).
   */
  | 'file-import'
  /** The worksheet is verified and names a programmatic path. */
  | 'programmatic'

export type DestinationKind =
  /** Professional tax preparation (§3, most of Priority 1). */
  | 'tax'
  /** Trial balance, audit, review, engagement workpapers (§3). */
  | 'workpapers'
  /** Firm or larger-client accounting and ERP environments (§3, Priority 2). */
  | 'firm-or-erp'
  /** The universal package every firm can use (§4). */
  | 'universal'

export type ExportDestination = {
  /** Stable key, used in the audit log and in saved mappings. */
  key: string
  product: string
  vendor: string
  kind: DestinationKind
  /** 1 or 2, from §3's own column. `null` for the universal package. */
  priority: 1 | 2 | null
  /** What a firm uses it for, in §3's words. */
  use: string
}

/**
 * The professional systems a firm may be exporting to (Exporter spec §3, §4).
 *
 * Configurable rather than hard-coded, which is §15's second acceptance
 * criterion — the product offers what this list says and nothing else, so
 * enabling a destination is an entry here rather than a branch somewhere.
 *
 * The list carries no integration state. What is known about reaching each one
 * lives in `WORKSHEETS` and is read through `integrationFor`, because the
 * worksheet is what establishes it and a second copy here is a second answer to
 * one question (Phase 159).
 */
export const EXPORT_DESTINATIONS: readonly ExportDestination[] = [
  {
    key: 'universal',
    product: 'Universal accountant package',
    vendor: 'Accountrix Plus',
    kind: 'universal',
    priority: null,
    use: 'Any firm, any system — CSV and delimited text plus a reporting package',
  },

  // Priority 1 — professional tax preparation (§3).
  { key: 'lacerte', product: 'Lacerte Tax', vendor: 'Intuit', kind: 'tax', priority: 1, use: 'Professional tax preparation' },
  { key: 'proseries', product: 'ProSeries Tax', vendor: 'Intuit', kind: 'tax', priority: 1, use: 'Professional tax preparation' },
  { key: 'proconnect', product: 'ProConnect Tax', vendor: 'Intuit', kind: 'tax', priority: 1, use: 'Professional tax preparation' },
  { key: 'ultratax-cs', product: 'UltraTax CS', vendor: 'Thomson Reuters', kind: 'tax', priority: 1, use: 'Professional tax preparation' },
  { key: 'gosystem-tax-rs', product: 'GoSystem Tax RS', vendor: 'Thomson Reuters', kind: 'tax', priority: 1, use: 'Enterprise professional tax' },
  { key: 'cch-axcess-tax', product: 'CCH Axcess Tax', vendor: 'Wolters Kluwer', kind: 'tax', priority: 1, use: 'Professional / enterprise tax' },
  { key: 'cch-prosystem-fx-tax', product: 'CCH ProSystem fx Tax', vendor: 'Wolters Kluwer', kind: 'tax', priority: 1, use: 'Professional tax' },
  { key: 'drake-tax', product: 'Drake Tax', vendor: 'Drake Software', kind: 'tax', priority: 1, use: 'Professional tax preparation' },

  // Priority 2 — professional tax (§3).
  { key: 'atx', product: 'ATX', vendor: 'Wolters Kluwer', kind: 'tax', priority: 2, use: 'Professional tax preparation' },
  { key: 'taxwise', product: 'TaxWise / TaxWise Online', vendor: 'Wolters Kluwer', kind: 'tax', priority: 2, use: 'Professional tax preparation' },

  // Priority 1 — workpapers, trial balance and engagement (§3).
  { key: 'caseware-working-papers', product: 'Caseware Working Papers', vendor: 'Caseware', kind: 'workpapers', priority: 1, use: 'Trial balance, audit, review, workpapers' },
  { key: 'caseware-cloud', product: 'Caseware Cloud / Engagements', vendor: 'Caseware', kind: 'workpapers', priority: 1, use: 'Cloud audit and engagement workpapers' },
  { key: 'cch-axcess-engagement', product: 'CCH Axcess Engagement', vendor: 'Wolters Kluwer', kind: 'workpapers', priority: 1, use: 'Cloud engagement / workpapers' },
  { key: 'cch-prosystem-fx-engagement', product: 'CCH ProSystem fx Engagement', vendor: 'Wolters Kluwer', kind: 'workpapers', priority: 1, use: 'Engagement / workpapers' },
  { key: 'workpapers-cs', product: 'Workpapers CS', vendor: 'Thomson Reuters', kind: 'workpapers', priority: 1, use: 'Workpapers and trial balance' },
  { key: 'accounting-cs', product: 'Accounting CS', vendor: 'Thomson Reuters', kind: 'workpapers', priority: 1, use: 'Professional accounting / trial balance' },

  // Priority 2 — audit workflow, firm and ERP (§3).
  { key: 'tr-cloud-audit-suite', product: 'Cloud Audit Suite', vendor: 'Thomson Reuters', kind: 'workpapers', priority: 2, use: 'Audit workflow and engagement' },
  { key: 'sage-intacct', product: 'Sage Intacct', vendor: 'Sage', kind: 'firm-or-erp', priority: 2, use: 'Mid-market / firm and client accounting ecosystem' },
  { key: 'netsuite', product: 'NetSuite', vendor: 'Oracle', kind: 'firm-or-erp', priority: 2, use: 'ERP / larger client accounting environment' },
  { key: 'dynamics-365-bc', product: 'Dynamics 365 Business Central', vendor: 'Microsoft', kind: 'firm-or-erp', priority: 2, use: 'ERP / larger client accounting environment' },
]

/** The destination a key names. Throws on one nobody declared. */
export function destinationFor(key: string): ExportDestination {
  const found = EXPORT_DESTINATIONS.find((row) => row.key === key)
  if (!found) {
    throw new RegistryError({
      registry: 'EXPORT_DESTINATIONS',
      key,
      message:
        `No export destination is declared for "${key}". Destinations are configurable rather ` +
        'than hard-coded (Exporter spec §15), so a new one is an entry in that registry — and a ' +
        'competitor bookkeeping product is not one, whatever key it is asked for under.',
    })
  }
  return found
}

/**
 * What is known about reaching a destination, read from its worksheet.
 *
 * The universal package is the one destination with no worksheet and a known
 * path, because §4's package is Accountrix's own file rather than somebody
 * else's import — there is no vendor to research. Every other key without a
 * worksheet is `unresearched`.
 */
export function integrationFor(key: string): IntegrationState {
  if (key === 'universal') return 'file-import'

  const worksheet = worksheetFor(key)
  if (!worksheet) return 'unresearched'
  if (worksheet.status === 'draft') return 'researched-unverified'

  // A verified worksheet reports what it found. `no-third-party-path` is not an
  // integration state: a verified worksheet saying there is no route means the
  // destination cannot be offered, which is what `unresearched` already means
  // for the purpose of offering it — and the refusal below says which it is.
  return worksheet.finding === 'programmatic' ? 'programmatic' : 'file-import'
}

/** Destinations a firm may actually be offered today. */
export function offerableDestinations(): ExportDestination[] {
  return EXPORT_DESTINATIONS.filter((row) => {
    const state = integrationFor(row.key)
    if (state === 'unresearched' || state === 'researched-unverified') return false
    return worksheetFor(row.key)?.finding !== 'no-third-party-path'
  })
}

/**
 * Whether a destination may be exported to at all.
 *
 * Four refusals now, and keeping them apart is the point. An excluded product is
 * a **decision** and will not change by doing more work. An unresearched one is
 * an **absence of research**. One with a draft worksheet is an absence of
 * *verification*, and the refusal can name the question that is outstanding. And
 * a verified worksheet that found no third-party route is a **finding**: the
 * work was done and the answer is that the vendor has to open a door.
 *
 * Four sentences rather than one "not supported", because each tells somebody a
 * different thing about what would change it — which is Phase 119's rule that a
 * refusal is worth writing when a person can act on it.
 */
export function mayExportTo(key: string): { ok: true; destination: ExportDestination } | { ok: false; why: string } {
  const excluded = exclusionFor(key)
  if (excluded) {
    return {
      ok: false,
      why:
        `${excluded.product} is not an export destination. ${excluded.because} The books can be ` +
        'exported as a universal accountant package instead, which any system can read.',
    }
  }

  const destination = destinationFor(key)
  const worksheet = worksheetFor(key)

  if (!worksheet && key !== 'universal') {
    return {
      ok: false,
      why:
        `${destination.product} is a planned destination and nobody has established how it ` +
        'actually accepts a trial balance yet. The specification is explicit that an API must not ' +
        'be assumed — professional tax and workpaper products often import through a vendor file, ' +
        'a desktop bridge or a partner programme — so an adapter waits on a worksheet citing that ' +
        'vendor’s own documentation. Export the universal package in the meantime.',
    }
  }

  if (worksheet && worksheet.finding === 'no-third-party-path') {
    return {
      ok: false,
      why:
        `${destination.product} has been researched and has no route a third party can take. ` +
        `${worksheet.recommendation} The outstanding question is one for the vendor rather than ` +
        `for more searching: ${worksheet.blocker} See ${worksheet.path}.`,
    }
  }

  if (worksheet && worksheet.status === 'draft') {
    return {
      ok: false,
      why:
        `${destination.product} has been researched and the research has not been checked against ` +
        'the vendor’s own pages, so no adapter has been written. ' +
        `What it found: ${worksheet.recommendation} ` +
        `Outstanding: ${worksheet.blocker} See ${worksheet.path}. ` +
        'Export the universal accountant package in the meantime — any professional system can ' +
        'read it.',
    }
  }

  return { ok: true, destination }
}

/**
 * Whether an adapter may be written for this destination.
 *
 * Separate from `mayExportTo` because it answers a developer rather than an
 * accountant, and because it is the gate Exporter spec §13 asks for: *"the
 * coding agent must first produce a one-page integration worksheet before
 * writing production code."*
 */
export function adapterMayBeBuilt(key: string): { ok: true } | { ok: false; why: string } {
  const excluded = exclusionFor(key)
  if (excluded) {
    return {
      ok: false,
      why: `${excluded.product} is excluded by Exporter spec §2. ${excluded.because}`,
    }
  }

  const destination = destinationFor(key)
  const worksheet = worksheetFor(key)

  if (!worksheet && key !== 'universal') {
    return {
      ok: false,
      why:
        `No integration worksheet exists for ${destination.product}. Exporter spec §13 requires ` +
        'one before production code: whether there is a public or partner API, whether a desktop ' +
        'SDK or bridge is needed, whether it imports a trial balance or GL detail or adjusting ' +
        'entries, which file formats it accepts, which tax and account codes it requires, what ' +
        'vendor approval or certification applies, and which official documentation supports each ' +
        'answer. Until that exists an adapter would be a guess at somebody else’s format.',
    }
  }

  if (worksheet && worksheet.status === 'draft') {
    return {
      ok: false,
      why:
        `The ${destination.product} worksheet is a draft. Every answer in it rests on a summary of ` +
        'a vendor page that nobody opened — the research environment’s egress policy blocked every ' +
        'vendor documentation host — and §13 is a clause about having read the documentation. ' +
        `Verifying it means opening the pages ${worksheet.path} cites, confirming each answer, and ` +
        'getting a sample file or sandbox where the vendor offers one. The question most likely to ' +
        `change the design: ${worksheet.blocker}`,
    }
  }

  return { ok: true }
}

/*
  There was a `refuseDestination(key): Refusal` here, and it is gone.

  It wrapped `mayExportTo`'s `why` in a `Refusal` and threw a bare `Error` when
  asked to refuse something that was allowed. Nothing called it: `service.ts`
  does `throw new Refusal(allowed.why)` at the two places that need it, because
  that is one line and reads in place. So it was Phase 49's rule — a function
  with no caller is a feature that does not exist — and `refusal-audience.test.ts`
  found it by the only part of it that did anything, the bare throw.

  Noted rather than silently deleted, because the sentence it would have carried
  is the useful part and it already lives in `mayExportTo`.
*/
