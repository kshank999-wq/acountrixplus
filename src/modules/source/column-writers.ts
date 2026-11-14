import { readFileSync } from 'node:fs'
import { RegistryError } from '@/modules/errors/registry'
import { declarationOf, withoutComments } from './enclosing'
import { readableSource, sourceFiles } from './isolation-scan'

/**
 * Columns something reads that nothing lets a person fill in (Phase 201).
 *
 * ## Why this exists
 *
 * Phase 200 set out to give one prompt the company's own words and found a
 * column with no editor. The narrow check written for that — a form's field
 * list against the table's columns — **named two more on its first run**, and
 * both were worse: `letterhead.ts` reads `addressLine2` and `country` and puts
 * them on every document a client sees, so a business with a second address
 * line could not put it on its own letterhead.
 *
 * Three in one phase, found by accident of writing one check against one
 * form. ADR 0200 said that was no longer a coincidence worth closing one at a
 * time, and this is the class measured: **2,179 columns across 185 tables**,
 * independently of any one screen's vocabulary.
 *
 * ## Why a register rather than an assertion
 *
 * Because *"has a writer"* is **not decidable** by reading the source. Seven
 * mechanisms write a column in a way no pattern sees. Five were fixable, and
 * fixing each one revealed the next:
 *
 * | | |
 * | --- | --- |
 * | object literal in a callback | `.values(rows.map((r) => ({ … })))` |
 * | shorthand property | `{ companyId, transactionId }` — no colons at all |
 * | literal built into a variable | `const rows = …; .values(rows)` |
 * | a declaration spanning lines | what Phase 197's `declarationOf` stopped at the first line of |
 * | the table itself held in a variable | `const table = kind === 'customer' ? customers : vendors` |
 *
 * The last two are not:
 *
 * | | |
 * | --- | --- |
 * | a spread | `.values({ companyId, ...input })` writes every key of a type |
 * | a helper's return | `.values(decisionFor(input))` |
 *
 * A spread means "whatever that type has", and resolving it needs the
 * typechecker rather than a regex. So this scan produces **candidates**, and
 * the register's rule is that every candidate is either **declared** — with
 * the writer named — or **fixed**. That is Phase 139's device: a register that
 * says what it does not cover beats one that looks complete.
 *
 * ## The eighth mechanism, and the one that was costing findings
 *
 * The seven above all hide a **writer**, so the scan over-reports and each
 * entry argues one down. Phase 210 found an eighth that hid a **reader**, and
 * it worked the other way: `writerCandidates` would not look at a column
 * unless some query *named* it as `tableVar.column`, and a projectionless
 * `select()` names nothing while reading everything. Seventy-two columns had
 * never been examined at all.
 *
 * `readNames` below has the correction and the argument. What it cost is the
 * measurement: **sixteen of the seventy-two have no writer anywhere.** Of the
 * thirty tables that carried an `isActive`, twenty-four name it in a query and
 * **all twenty-four have a writer**; six never name it and **five of those six
 * had none**. So every defect of that class sat inside a blind spot covering
 * six tables of thirty.
 *
 * The sixth is the control, and it is why this is stated as a correlation
 * rather than a cause: `cost_codes` has the identical shape — `listCostCodes`
 * selects every row and filters `row.isActive` in JavaScript — and
 * `updateCostCode` writes the column anyway. The query shape does not cause a
 * missing writer. It hides whether there is one, and five times out of six
 * there was not.
 *
 * ## What it does not claim
 *
 * That a column with a writer is reachable by a *person*. `logoAssetId` is
 * written through a spread from a form, and `messageId` on a notification is
 * written by a helper from the push provider's own answer — the scan cannot
 * tell those apart, and `because` is where the difference is stated. Every
 * entry below was confirmed by reading the writer, not by the scan.
 *
 * ## What it found
 *
 * **93 candidates and 12 findings covering 13 columns**, which is the first
 * time this register has carried one. (96 and 14 over 16 when Phase 210 wrote
 * them: Phase 211 answered one of the findings by establishing that
 * `bill_lines.item_id` had never been a defect — what it was for is recorded
 * on the goods receipt line — and dropped the column, so it is gone from the
 * numerator and the denominator both. Phase 212 closed another, the two
 * `projects` columns, and found while doing so that the entry's stated reason
 * was false: it named a reader for `endDate` that is a function parameter of
 * the same name, so the register had been right about the column and wrong
 * about why since the day it was written.) A closed one is **absent** from this
 * register, because the scan no longer reports it — which is what proves an
 * editor reaches the column rather than only existing, and the tests assert
 * that absence by name.
 *
 * Phase 201 closed `organizations.sizeBand`, a segment filter that could only
 * ever match nothing, and `service_items.inventoryAccountId`, a per-item
 * posting account read in three places and set only by the seed.
 *
 * Phase 202 narrowed the exclusion above and closed three more:
 * `memberships.permissionOverrides` (ADR 0201's nomination),
 * `memberships.isActive` — §14's *revocation*, read on every request and
 * writable by nothing — and `organizations.tags`, `sizeBand`'s sibling and
 * the second segment filter with no writer.
 *
 * Phase 203 closed `gift_cards.isActive` — the one of the six switches where
 * the thing nobody could turn off was money, and the reason it needed a phase
 * rather than an entry is that stopping a card with a balance on it is a
 * decision about where that balance went.
 *
 * Phase 204 closed the other two **enforced** switches:
 * `cash_drawers.isActive`, which `openShift` refuses on, and
 * `practices.isActive`, which four queries filter on — including
 * `practicesFor`, so an inactive firm leaves its own members' list and none of
 * them can switch into it again.
 *
 * Phase 205 closed the last two, the **projection-only** pair: a writer *and*
 * a filter each, since a writer alone would have handed somebody a control
 * with no effect. All six `isActive` switches the narrowed exclusion exposed
 * are now closed, in the order reading their readers established — the three
 * enforced ones first, because for those the whole gap was the writer.
 *
 * Phase 208 closed the last one, `vendors.organizationId` — the supplier who
 * is also a client, which one module exists for and no screen could produce.
 * It had been declared in five consecutive ADRs on the argument that the
 * vendor correction screen is a registry of **text fields**, so a link to a
 * CRM record would need that registry to learn a new kind of field. The
 * customer side of the same link is not a field either, so it never did: it is
 * an act, like the merge that already sits beside that form.
 *
 * Phase 210 corrected the read rule and the empty-findings claim above went
 * with it. Five of what it exposed were closed in the same phase — an employee
 * who could not leave, a tax code that could not be retired, a practitioner
 * the booking path refused and nothing could stand down, and the two address
 * columns on every client document that this register was *created for* and
 * had never been able to report. Two more were removed, having neither a
 * writer nor a reader. Sixteen are below, under their own heading, each
 * naming what reads it.
 */

/** Where a candidate stands. */
export type WriterVerdict =
  /** Something writes it; the scan cannot see the write. The entry says where. */
  | 'written'
  /**
   * Nothing writes it, and that is a defect with a decision recorded.
   *
   * No entry carried this verdict from Phase 208 to Phase 210. It was kept
   * rather than deleted on Phase 157's rule — an unused declaration stays when
   * it *accuses* — and the argument for keeping it was that the next person to
   * find a column nothing can fill should not have to invent the word again.
   *
   * **Twelve entries carry it now.** Correcting the read rule in Phase 210
   * reported seventy-two columns the scan had never looked at, sixteen of them
   * written by nothing; Phase 211 took one back off, having measured that the
   * thing it was for lives on another table. Two phases of an empty section
   * was the cost of the vocabulary being ready when the measurement arrived.
   */
  | 'unwritable'

export type ColumnWriter = {
  /** The table's SQL name, as `pgTable` declares it. */
  table: string
  /** The columns of that table this entry accounts for, by property name. */
  columns: readonly string[]
  verdict: WriterVerdict
  /** For `written`: the file that writes them. Empty for `unwritable`. */
  // (Empty on all twelve `unwritable` entries, which is what the verdict means.)
  writtenBy: string
  /** Why, argued from what the code does rather than from what it looks like. */
  because: string
}

/**
 * Grouped by the mechanism rather than one entry per column.
 *
 * Five of the `asset_links` subject columns are written by one spread of one
 * helper, and nine of `notification_log`'s by one call. Twenty-seven entries
 * each repeating the same sentence would be a register nobody reads, which is
 * the failure mode Phase 101's device is supposed to avoid rather than cause.
 * The argument is per mechanism because that is the unit at which it differs.
 */
export const COLUMN_WRITERS: readonly ColumnWriter[] = [
  // --- Written, through something no pattern sees ---------------------------
  {
    table: 'asset_links',
    columns: ['campaignId', 'contactId', 'customerId', 'opportunityId', 'organizationId'],
    verdict: 'written',
    writtenBy: 'src/modules/studio/asset-links.ts',
    because:
      'All five written by `...subjectAssignment(input.subject)`, which sets exactly one of them ' +
      'per link and nulls the rest — the column names appear nowhere at the write. This group is ' +
      'why the scan is a candidate list: five columns of one table looked unwritable and all ' +
      'five are written by one spread, which nearly went into an earlier draft of this phase as ' +
      "a rediscovery of the known gap that four of the five kinds have no *attach control*. " +
      'That gap is real and is about the interface; these columns are not it.',
  },
  {
    table: 'bank_transaction_revisions',
    columns: [
      'amountCents',
      'description',
      'merchantName',
      'pending',
      'postedDate',
      'previousAmountCents',
      'previousPending',
      'previousPostedDate',
      'providerCategory',
    ],
    verdict: 'written',
    writtenBy: 'src/modules/banking/revision-service.ts',
    because:
      'Written by `...incoming` and `...previous` — the feed\'s new figures and the ones they ' +
      'replace, spread side by side so a held revision records both. Nothing a person types by ' +
      'definition: a revision is what the bank said changed, and a field offering to edit it ' +
      'would be inventing a bank statement. Six of the nine joined this entry in Phase 210 with ' +
      'the read rule corrected: this table is read by a projectionless `select()`, so until then ' +
      'only the three the inbox names column-wise were visible.',
  },
  {
    table: 'bank_transactions',
    columns: ['raw'],
    verdict: 'written',
    writtenBy: 'src/modules/banking/sync.ts',
    because:
      'Written as `raw: transaction.raw ?? null` inside the `.map` that builds `const rows`, and ' +
      'the insert is `.values(rows)` — a bare identifier whose declaration resolves to ' +
      '`input.transactions`, not to the literal. Two of the seven mechanisms compounding: the ' +
      "literal is in a variable *and* inside a callback. It holds the provider's own payload for " +
      'a row, which is evidence rather than a field.',
  },
  {
    table: 'brand_kits',
    columns: [
      'accentColor',
      'baseSizePt',
      'bodyFont',
      'headingFont',
      'logoAssetId',
      'mutedColor',
      'primaryColor',
      'surfaceColor',
      'textColor',
    ],
    verdict: 'written',
    writtenBy: 'src/modules/studio/service.ts',
    because:
      'Written by `.values({ companyId: ctx.companyId, ...input })` and `.set({ ...input })`, so ' +
      'the column name appears nowhere at the write — the spread carries every field of ' +
      "`BrandKitInput`, which has all nine. Reachable by a person: the brand kit editor is a " +
      'colour and type picker and these are what it picks. This is the mechanism that makes the ' +
      'scan a candidate list rather than an assertion, because resolving a spread needs the ' +
      'typechecker.',
  },
  {
    table: 'company_profiles',
    columns: [
      'addressLine1',
      'addressLine2',
      'city',
      'country',
      'dba',
      'description',
      'documentFooter',
      'email',
      'paymentInstructions',
      'phone',
      'postalCode',
      'region',
      'tagline',
      'taxId',
      'website',
    ],
    verdict: 'written',
    writtenBy: 'src/app/actions/studio.ts, src/modules/studio/service.ts',
    because:
      'Written by `saveProfile`, which spreads `...input` of type `ProfileInput`. Three of these ' +
      '— `description`, `addressLine2` and `country` — were written by **nothing** until Phase ' +
      '210 despite having a field on the Design Center form since Phase 200, because ' +
      "`saveProfileAction`'s zod schema omitted them and a zod object strips what it does not " +
      'declare. The box accepted typing, the save reported success and the value was dropped. ' +
      'The register this file holds was created for exactly those two address columns and could ' +
      'not see them, which is Phase 210.',
  },
  {
    table: 'contacts',
    columns: ['notes'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'Both inserts list their columns and neither lists this one; the two updates set ' +
      '`suppressedAt` and `emailConsent`. A contact cannot be annotated. The CRM keeps notes ' +
      'against an organisation, an opportunity and an activity, so the gap is narrow — but a ' +
      'per-person note is what a salesperson reaches for first, and nothing anywhere writes it.',
  },
  {
    table: 'customers',
    columns: ['addressLine2'],
    verdict: 'written',
    writtenBy: 'src/modules/receivables/service.ts',
    because:
      'Written by `...normaliseParty(input)` — a **helper\'s return**, the mechanism no regex ' +
      'resolves. `createCustomer` and `updateCustomer` both accept it and the correction form ' +
      'offers it, which Phase 45 added when it found `modules/pdf/invoice.ts` reading an address ' +
      'nothing wrote.',
  },
  {
    table: 'design_documents',
    columns: [
      'marginBottomPt',
      'marginLeftPt',
      'marginRightPt',
      'marginTopPt',
      'showPageNumbers',
    ],
    verdict: 'written',
    writtenBy: 'src/modules/design/documents.ts',
    because:
      'Written by `...(input.settings ?? {})` in `updateDocument`, where `settings` is the page ' +
      "setup panel's own object — a spread of a nested property, so no key is visible at the " +
      'write. The designer sets margins and page numbering there and nowhere else.',
  },
  {
    table: 'communications',
    columns: ['customerId', 'vendorId'],
    verdict: 'written',
    writtenBy: 'src/modules/engagement/outbound.ts',
    because:
      'Written by `...columnsFor(party)`, the helper Phase 93 added so a sent letter lands on the ' +
      'right record — a remittance on the supplier, an invoice on the customer, and never the ' +
      'other way. An earlier draft of this phase reported these two as a panel empty since Phase ' +
      '93 and **changed the reader**, on the strength of the two inserts in ' +
      '`engagement/communications.ts` setting neither. The writer is in a different module, and ' +
      'the claim was reverted before it shipped: reading the flagged column is the whole method, ' +
      'and reading only the file the reader lives in is not reading it.',
  },
  {
    table: 'notification_log',
    columns: [
      'body',
      /** Added to this entry in Phase 202, with the exclusion narrowed. */
      'channel',
      'companyId',
      'detail',
      'messageId',
      'outcome',
      'practiceId',
      /** Three more in Phase 210, with the read rule corrected. */
      'provider',
      'subscriptionId',
      'title',
      'topic',
      'url',
      'userId',
    ],
    verdict: 'written',
    writtenBy: 'src/modules/mobile/notifications.ts',
    because:
      'All thirteen written by `.values(decisionFor(input))` — one helper builds the whole row, so no ' +
      'key is visible at the call and every column of the table is a candidate at once. None is ' +
      'typed by anybody: this is the record of what was sent, to whom, on which topic, and what ' +
      'the push provider answered, which is why nothing in the interface offers any of it and ' +
      'why that is correct rather than a gap. The preference row below is where a person ' +
      'expresses an opinion about a topic.',
  },
  {
    table: 'notification_preferences',
    columns: ['practiceId'],
    verdict: 'written',
    writtenBy: 'src/modules/mobile/notifications.ts',
    because:
      'Written by `...columnsFor(audience)`, which sets the company or the practice depending on ' +
      'whose preference it is — a staff member of an accounting practice has preferences about ' +
      'the practice and about each client company, and the pair of columns is how one row says ' +
      'which. Set by the act of expressing a preference rather than typed as a value.',
  },
  {
    table: 'proposal_items',
    columns: [
      'amountCents',
      'chartAccountId',
      'description',
      'isOptional',
      'itemId',
      'quantityMilli',
      'sortOrder',
      'unitPriceCents',
    ],
    verdict: 'written',
    writtenBy: 'src/modules/crm/proposals.ts',
    because:
      'Written by `...item` inside `items.map((item) => ({ companyId, proposalId, ...item }))` — ' +
      'a spread **inside a callback**, which is two of the seven mechanisms at once. Three are ' +
      'typed by a person on the proposal line editor: the wording, the revenue account, and the ' +
      'catalogue item the line came from. The other three joined this entry in Phase 202 with ' +
      'the default exclusion narrowed, and are computed rather than typed — the line total, its ' +
      'position, and whether the client may decline it, which `acceptance.ts` reads to decide ' +
      'what a signature actually agreed to. The quantity and unit price joined in Phase 210 with ' +
      'the read rule corrected; both are typed on the line editor.',
  },
  {
    table: 'proposals',
    columns: ['discountCents', 'taxCents'],
    verdict: 'written',
    writtenBy: 'src/modules/crm/proposals.ts',
    because:
      'Written by `...totals`, the object `proposalTotals` returns, at the insert and again on ' +
      'every re-price. Derived from the lines rather than typed, which is the point — a discount ' +
      "typed over a total that disagrees with the lines is the defect Phase 209 found in the " +
      "invoice composer's tax.",
  },
  {
    table: 'security_policies',
    columns: ['lockoutMinutes', 'maxFailedAttempts', 'requireMfa', 'sessionTtlDays'],
    verdict: 'written',
    writtenBy: 'src/app/actions/security.ts',
    because:
      'Written by `...parsed` at both the insert and the update, where `parsed` is the security ' +
      "settings form's own zod output. Worth saying out loud that these four are *settable*, " +
      'because a password policy nothing could change would be the most serious finding this ' +
      'register has ever held — and the only reason they look unwritten from here is that one ' +
      'spread carries the lot.',
  },
  {
    table: 'service_items',
    columns: ['defaultProposalCopy', 'description', 'isTaxable'],
    verdict: 'written',
    writtenBy: 'src/modules/studio/service.ts',
    because:
      '`createServiceItem` spreads `...input`, whose `ServiceItemInput` has all three, and the ' +
      'Design Center catalogue form sets them. Worth the entry because `inventoryAccountId` on ' +
      'this same table was a real finding: two columns of one table, one written through a spread ' +
      'and one written nowhere, indistinguishable from the scan and three lines apart in the ' +
      'schema. `isTaxable` is read by nothing — Phase 209 made the invoice line carry its own ' +
      'tax code, which is the per-line answer this per-item flag was a guess at.',
  },
  {
    table: 'vendors',
    columns: ['addressLine2', 'notes'],
    verdict: 'written',
    writtenBy: 'src/modules/receivables/service.ts',
    because:
      'Written by `...normaliseParty(input)`, as on `customers` above, and both are on the ' +
      'supplier correction form. The helper trims and nulls every string it is handed, which is ' +
      'why it exists and why the scan cannot see through it.',
  },

  // --- Unwritable, and recorded as findings ---------------------------------
  //
  // Empty from Phase 208 to Phase 210, when correcting the read rule above
  // reported seventy-two columns the scan had never looked at and **sixteen of
  // them have no writer at all.** The verdict was kept through two phases on
  // Phase 157's rule — an unused declaration stays when it accuses — and this
  // is what it was kept for.
  //
  // One of the sixteen was never a defect: `bill_lines.item_id` was a copy of
  // the invoice column, docstring included, on the side of the books where
  // nothing is sold, and what it was for is already recorded on the goods
  // receipt line that posts the stock. Phase 211 dropped it, which is why this
  // section holds thirteen entries over fifteen columns.
  //
  // Five of the sixteen were fixed in the phase that found them, and so are
  // absent: `employees.isActive` and `endDate`, `tax_codes.isActive`,
  // `practitioners.isActive`, and `company_profiles.addressLine2` with
  // `country` (which moved up to the `written` entry above). Two more were
  // **removed** — `segments.isActive` and `vehicles.isActive` had no reader
  // either, which is Phase 49's shape and takes a migration rather than an
  // entry.
  //
  // What is left is here. The order is the scan's, and each entry says what
  // reads the column, because a finding whose reader is nothing is a different
  // and smaller problem than a finding whose reader is a client-facing
  // document.
  {
    table: 'ai_requests',
    columns: ['cacheHit'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'The AI cost ledger records provider, model, both token counts and the cost in micros, and ' +
      '`cache_hit` beside them is set by nothing and read by nothing. `cachedInputTokens` is ' +
      'written and carries the same information better, so this is the earlier draft of that idea ' +
      'left in the table.',
  },
  {
    table: 'background_jobs',
    columns: ['startedAt'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'The queue writes `status`, `attempts`, `lockedBy`, `lockedAt`, `finishedAt` and ' +
      '`lastError`, and never this. So a job has a finish time and no start time, and how long ' +
      'anything took cannot be answered — `lockedAt` is the nearest thing and means something ' +
      'else, because a job relocked after a crash moves it.',
  },
  {
    table: 'billable_expenses',
    columns: ['writeOffReason'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'A disbursement can be marked billed, and there is no way to say it will not be billed and ' +
      'why. The column names the decision and nothing records it, so an expense that will never ' +
      'be recharged sits on the unbilled list for good.',
  },
  {
    table: 'company_profiles',
    columns: ['credentials'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'The sharpest of these, because it has been used as an **argument**. ' +
      "`modules/studio/team.ts` says §15's certifications are covered: *\"the measurement held: " +
      '`company_profiles.credentials` covers licences, certifications, insurance and ' +
      'memberships"*. Nothing writes it, nothing reads it, and ' +
      '`tests/a-voice-to-adapt-to.test.ts` excludes it from the form check as *"a structured ' +
      'list with its own editor and its own add/remove controls"*, which does not exist. ' +
      'An exclusion that excuses a site, which is ADR 0134 in the test that cites ADR 0134.',
  },
  {
    table: 'document_templates',
    columns: ['industry', 'isSystem'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '`saveAsTemplate` writes the key, name, description, kind and blocks. These two are what ' +
      'would make a template *shipped* rather than a copy of somebody\'s own document — the ' +
      'industry it suits and whether the product supplied it — and both are read by the template ' +
      'gallery, which therefore shows every template as the company\'s own.',
  },
  {
    table: 'employees',
    columns: ['notes'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'The one column of this table Phase 210 did not close. `isActive` and `endDate` now have a ' +
      'writer and this does not, and it is left open deliberately rather than bundled in: a free ' +
      'text field on a payroll record is where somebody writes something about a person that ' +
      'payroll is the wrong place to keep, and what belongs there needs deciding before a box ' +
      'appears.',
  },
  {
    table: 'goods_receipts',
    columns: ['journalEntryId'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'A receipt records that stock arrived and `receipt-billing.ts` posts the accrual, and the ' +
      'column that would point from the document to its entry is set by neither. So the receipt ' +
      'can be read and the posting it caused cannot be found from it — the drill-down every ' +
      'other document in this system has.',
  },
  {
    table: 'organizations',
    columns: ['notes'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'The field registry lists it: `ORGANIZATION_FIELDS` has `{ key: \'notes\', label: ' +
      "'Notes' }`, so `describeChanges` can name a change to it. `organizationSchema` does not " +
      'have it and `updateOrganization`\'s input type does not either, so the change it would ' +
      'describe cannot happen. A registry wider than the write path, which is the same shape as ' +
      "the Design Center's three dropped boxes and the reason this phase reads the whole chain.",
  },
  /*
    `projects.endDate` and `projects.notes` were here from Phase 210 until Phase
    212, which gave them a writer — `setJobStatus` in `jobs/lifecycle.ts`, one
    act for the status, the end date and the note, so that no two of them can
    disagree about whether the job is over.

    The sentence that entry ended on is worth keeping, because it was false and
    it was load-bearing. It said: *"`jobs/reports.ts` reads the end date into
    every date range it builds."* It does not. `jobs/reports.ts` has exactly one
    `endDate` and it is a function parameter — a caller-supplied window for a
    ledger query, named the same and related to nothing. Nothing in `src/` names
    `projects.endDate` at all; four projectionless `select()`s fetch it and no
    property access consults it.

    ADR 0211 then built its nomination on that sentence: *"the column is read —
    the register's entry for it names what reads it — so this is not Phase 49's
    shape and a migration is not the answer."* The conclusion held and the
    reason did not, which is the part worth a paragraph. Phase 210 taught this
    scan that a projectionless `select()` **is** a read, correctly, because the
    SQL fetches the column. The first register entry written after that
    correction then used "it is read" as an argument about a column no reader
    consults. A correction to what the scan can see created a new way for an
    entry to be wrong, and only prose can catch that: a column is worth writing
    because something is waiting for the answer, not because a query carries it
    back.

    What was waiting for the answer was `projects.status`, which this scan could
    not see at all — see `paintedStates` below.
  */
  {
    table: 'repair_orders',
    columns: ['journalEntryId'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'As `goods_receipts.journalEntryId` above: the order records the work and carries the ' +
      'invoice it raised, and the column for the entry behind it is written by nothing. Two ' +
      'tables with the same missing link suggests the shape is a habit rather than an oversight.',
  },
  {
    table: 'tax_codes',
    columns: ['effectiveTo'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '`effectiveFrom` is written at creation and this is its pair: the day a rate stopped ' +
      'applying. Phase 210 gave this table `isActive` a writer and deliberately did **not** ' +
      'write this one from the same control, because retiring a code and superseding a rate are ' +
      'different acts — the second needs the successor to exist and `priceDocumentTax` to choose ' +
      'between them by date. Giving it half a meaning would be worse than leaving it here.',
  },
  {
    table: 'team_members',
    columns: ['userId'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      'Phase 183 added it with its reason stated in the module: *"`userId` is optional so a bio ' +
      'can name the account it describes where there is one, which is what a future \'write your ' +
      'own bio\' screen needs"*. That screen has not been built, so the column is an argument for ' +
      'a feature rather than a gap in one — and it is here rather than excused because the next ' +
      'reader should find that out from the register and not from the history.',
  },
]

/** The entry accounting for one column, or a refusal naming it. */
export function columnWriterFor(table: string, column: string): ColumnWriter {
  const found = COLUMN_WRITERS.find(
    (row) => row.table === table && row.columns.includes(column),
  )
  if (found) return found

  throw new RegistryError({
    registry: 'COLUMN_WRITERS',
    key: `${table}.${column}`,
    message:
      `No writer is declared for "${table}.${column}". A column something reads and nothing ` +
      'writes is either a defect or a write the scan cannot see — and which of those it is has ' +
      'to be said by a person, because a spread and a missing editor look identical from here.',
  })
}

/** A column the scan cannot see a writer for. */
export type WriterCandidate = { table: string; column: string }

type SchemaColumn = {
  systemSet: boolean
  /**
   * The column's own declaration text, from its property name to the next
   * one's. Carried since Phase 212, which needed `enum:` and `.default(` to ask
   * whether a column is a **state** or a **record** — see `paintedStates`.
   */
  declaration: string
}

/**
 * Every table's columns, with whether the **database** is their author.
 *
 * Phase 201 excluded any column carrying a default, on the argument that the
 * database supplies it so nothing has to. That was too wide, and it is what
 * hid this phase's subject: `memberships.isActive` is
 * `boolean().notNull().default(true)`, read on **every request** to decide
 * whether somebody still has access, and nothing could set it false — §14's
 * *revocation* as a mechanism with no handle.
 *
 * The distinction Phase 202 draws is between a default that is the **whole
 * answer** and a default that is a **starting value for a state**. A
 * `defaultRandom()` primary key and a `defaultNow()` timestamp are the first:
 * nothing should ever write them, and a scan reporting them would be a
 * register of 195 excuses. A `.default(true)` boolean is the second, and a
 * state nothing can change is a switch painted on.
 *
 * So only `defaultRandom()` and `defaultNow()` are excluded, and the
 * narrowing took the census from 27 candidates to 35 — eight columns of
 * exactly the kind Phase 201 was built to find, which its own exclusion had
 * made invisible. Six of the eight are an `isActive` nothing can turn off.
 *
 * ## `generatedAlwaysAs`, added in Phase 210
 *
 * The same test, applied to a third case. `evidence_subjects.subjectType` and
 * `subjectId` are `GENERATED ALWAYS AS … STORED`: the database computes them
 * from the twelve kind columns and **refuses** a write, which is the strongest
 * form of "the whole answer" there is. Reporting one would be asking for an
 * editor Postgres would reject, and declaring it would be an excuse for a
 * column that is working exactly as designed.
 */
function schemaColumns(): Map<string, { sqlName: string; columns: Map<string, SchemaColumn> }> {
  const tables = new Map<string, { sqlName: string; columns: Map<string, SchemaColumn> }>()

  for (const file of sourceFiles('src/db/schema')) {
    const src = readFileSync(file, 'utf8')

    for (const m of src.matchAll(/export const (\w+) = pgTable\(\s*'([^']+)',\s*\{/g)) {
      const body = balanced(src, src.indexOf('{', m.index + m[0].length - 1))
      const columns = new Map<string, SchemaColumn>()

      for (const c of body.matchAll(/^\s{4}(\w+):\s*\w+\(/gm)) {
        const own = new RegExp(String.raw`^\s{4}${c[1]}:[\s\S]*?(?=^\s{4}\w+:|$)`, 'm').exec(body)
        const declaration = own?.[0] ?? ''
        columns.set(c[1], {
          systemSet: /defaultNow\(|defaultRandom\(|generatedAlwaysAs\(/.test(declaration),
          declaration,
        })
      }

      tables.set(m[1], { sqlName: m[2], columns })
    }
  }

  return tables
}

/** From an opening brace or bracket to its match, bounded. */
function balanced(src: string, from: number): string {
  let depth = 0

  for (let at = from; at < src.length && at < from + 40_000; at++) {
    const char = src[at]
    if (char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '}' || char === ')' || char === ']') {
      depth -= 1
      if (depth === 0) return src.slice(from, at + 1)
    }
  }

  return src.slice(from, Math.min(from + 40_000, src.length))
}

/**
 * Every column this file reads, by the two spellings a read has.
 *
 * ## `tableVar.column`, which is what Phase 201 counted
 *
 * Drizzle spells a projection, a `where` and an `orderBy` the same way, so a
 * column named that way is read, and the name is right there to match.
 *
 * ## A projectionless `select()`, which is what Phase 210 adds
 *
 * `select()` with no argument compiles to `select *`. It reads **every column
 * of the table** and names none of them, and the row's columns are then reached
 * as properties — `row.isActive`, `profile?.country` — which carry no table to
 * key on. Phase 201's rule therefore skipped those columns *before* applying
 * any exclusion: `if (!named.has(key)) continue` ran first, so a column no
 * query named could not be a candidate however unwritable it was.
 *
 * That is not a blind spot of the same kind as a spread. A spread hides a
 * **writer**, so the scan over-reports and the register argues each one down. A
 * projectionless select hid a **reader**, so the scan under-reported and said
 * nothing at all — and ADR 0134's rule is that a silent miss is the better
 * half of a bad pair only when somebody knows about it. Nobody did.
 *
 * What the correction claims is exactly what the SQL does: the query fetched
 * the column. Whether any JavaScript then looks at it is a further question,
 * and where the answer is no, the entry below says so — `segments.isActive` was
 * fetched by a `select()` and consulted by nothing, which is Phase 49's class
 * rather than this one.
 *
 * Measured: **29 candidates became 96.** Every `isActive` with no writer
 * anywhere was on one of the six tables, of thirty carrying one, that no query
 * ever named — and the sixth of those six has a writer, which is the control
 * that keeps this a statement about what the scan could see rather than about
 * what developers do.
 */
function readNames(file: string, tables: ReturnType<typeof schemaColumns>): Set<string> {
  const src = readableSource(file)
  const named = new Set<string>()

  for (const m of src.matchAll(/\b(\w+)\.(\w+)\b/g)) named.add(`${m[1]}.${m[2]}`)

  /*
    The bound on the gap is what keeps this honest. Between `select()` and its
    `.from(T)` sits at most a `$dynamic()`, a comment already stripped, or
    nothing; 400 characters is room for all of them and far short of the next
    statement. A `select({ … })` does not match at all, which is the point — a
    projection names its columns and is already counted above.
  */
  for (const m of src.matchAll(/select\(\s*\)[\s\S]{0,400}?\.from\(\s*(\w+)\s*\)/g)) {
    const table = tables.get(m[1])
    if (!table) continue
    for (const column of table.columns.keys()) named.add(`${m[1]}.${column}`)
  }

  return named
}

/**
 * Every write this tree makes, by table and column, in one pass.
 *
 * Extracted in Phase 212, which needed a third reading of the same scan and
 * found two copies of it already — `writerCandidates` keeping one set of
 * writable keys, `insertOnlyColumns` keeping two, and the twenty lines that
 * fill them identical in both. A third copy would have made the mechanism
 * three places to correct, and every correction to this scan so far has been
 * to the mechanism.
 *
 * `literals` is the part that is new rather than moved: for each key, the
 * right-hand side of every write of it, as source text. A caller can then ask
 * whether a column is only ever written the **same literal** — which is what
 * tells a state apart from a record, and what two of the three callers do not
 * need.
 */
type WriteSites = {
  /** Keys a `.values(` names. */
  inserted: Set<string>
  /** Keys a `.set(` names. */
  updated: Set<string>
  /** Keys something reads, by either spelling `readNames` accepts. */
  named: Set<string>
  /** Per key, the source text of every right-hand side written to it. */
  literals: Map<string, string[]>
}

function writeSites(tables: ReturnType<typeof schemaColumns>): WriteSites {
  const sites: WriteSites = {
    inserted: new Set(),
    updated: new Set(),
    named: new Set(),
    literals: new Map(),
  }

  for (const dir of ['src/modules', 'src/app'] as const) {
    for (const file of sourceFiles(dir)) {
      const whole = withoutComments(readFileSync(file, 'utf8'))

      for (const m of whole.matchAll(/\.(insert|update)\(\s*(\w+)\s*\)\s*\.(values|set)\(/g)) {
        const into = m[1] === 'insert' ? sites.inserted : sites.updated

        /*
          The table, resolved when it is held in a variable — Phase 197's
          finding, and the fifth mechanism this scan hit.

          `receivables/service.ts` writes a customer or a vendor through
          `const table = kind === 'customer' ? customers : vendors`, so
          `.insert(table)` named `table` and every column of `vendors` looked
          unwritten. Keying by table made the scan sharper and immediately
          exposed this, which is the shape of the whole phase: each correction
          to "what counts as a writer" reveals the next.

          Resolved the way `isolation-scan` resolves it, through the same
          `declarationOf` — the second caller for that primitive, which is the
          argument for having put it in a shared module rather than in the scan
          that first needed it, and the reason Phase 197's end-of-line
          shortcut came out.
        */
        const targets = tables.has(m[2])
          ? [m[2]]
          : [...declarationOf(whole, m.index, m[2]).matchAll(/\b(\w+)\b/g)]
              .map((t) => t[1])
              .filter((name) => tables.has(name))

        const open = whole.indexOf('(', whole.indexOf(m[3], m.index) + m[3].length)
        let argument = balanced(whole, open).slice(1, -1)

        const bare = /^\s*(\w+)\s*$/.exec(argument)
        if (bare) {
          const declared = declarationOf(whole, m.index, bare[1])
          if (declared) argument = declared
        }

        for (const target of targets) {
          /*
            The two key patterns are exactly as Phase 201 left them, and the
            right-hand side is read in a second pass rather than by widening
            them. Widening looks tidier and is not equivalent: `foo: bar ? x :
            y` lets one pattern consume the ternary's colon, so `x` stops being
            matched as a key. That is a *better* answer — `x` was never a
            column — but it is a different one, and a scan whose census moves
            because somebody made it read more neatly is a scan nobody can
            compare across phases.
          */
          for (const k of argument.matchAll(/(\w+)\s*:/g)) into.add(`${target}.${k[1]}`)
          for (const k of argument.matchAll(/[{,]\s*(\w+)\s*(?=[,}])/g)) {
            into.add(`${target}.${k[1]}`)
          }

          for (const k of argument.matchAll(/(\w+)\s*:\s*([^,\n}]*)/g)) {
            record(sites.literals, `${target}.${k[1]}`, k[2].trim())
          }
          /*
            A shorthand property — `{ enabled }` — names the column and says
            nothing about what reaches it, so it is recorded as a write whose
            right-hand side cannot be read rather than as no write at all.
          */
          for (const k of argument.matchAll(/[{,]\s*(\w+)\s*(?=[,}])/g)) {
            record(sites.literals, `${target}.${k[1]}`, '')
          }
        }
      }

      for (const key of readNames(file, tables)) sites.named.add(key)
    }
  }

  return sites
}

function record(into: Map<string, string[]>, key: string, value: string): void {
  const list = into.get(key)
  if (list) list.push(value)
  else into.set(key, [value])
}

/**
 * Columns the scan cannot see a writer for.
 *
 * `read` is what `readNames` above defines: `tableVar.column` named anywhere
 * outside the schema, or any column of a table a projectionless `select()`
 * reads.
 *
 * `settable` is a key inside the balanced **argument** of a `.values(` or
 * `.set(`, with the five resolvable mechanisms handled: a callback's object
 * literal and an array are inside that argument; shorthand properties are
 * matched without a colon; a bare identifier is resolved through
 * `declarationOf`, which finds the *nearest preceding* declaration rather than
 * the file's first; and that declaration now runs to the end of the expression
 * rather than the end of its line, which is Phase 201's correction to Phase
 * 197's primitive and removed four false positives on `document_tax_lines`
 * alone.
 *
 * Keyed by **table and column**, not by column name alone. The first version
 * kept a set of names, so `notification_log.topic` counted as written because
 * `notification_preferences.topic` is — and in that case it happens to be true,
 * which is exactly why the looseness was worth removing rather than noting: a
 * column is only ever marked written by a statement that writes *its* table.
 * The target comes from the `.insert(T)` or `.update(T)` the call is chained
 * to, which also means a `.set(` on something that is not a table — a Map, a
 * cookie store — no longer contributes names at all.
 *
 * A column with a schema default is excluded: the database supplies it, so
 * nothing has to.
 */
export function writerCandidates(): WriterCandidate[] {
  const tables = schemaColumns()
  const { inserted, updated, named } = writeSites(tables)
  const candidates: WriterCandidate[] = []

  for (const [tableVar, table] of tables) {
    for (const [column, info] of table.columns) {
      const key = `${tableVar}.${column}`
      if (info.systemSet) continue
      if (!named.has(key)) continue
      if (inserted.has(key) || updated.has(key)) continue

      candidates.push({ table: table.sqlName, column })
    }
  }

  return candidates.sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  )
}

/**
 * Columns something writes **only at insert** — the scan's other blind spot.
 *
 * Measured in Phase 202 rather than registered, and the number is the reason:
 * a column that appears in a `.values(` and never in a `.set(` is written and
 * therefore not a candidate above, even when nothing can ever *change* it.
 * `memberships.role` was exactly that — set once at invitation, read in eight
 * places, and unchangeable for 201 phases — and the scan could not see it.
 * Phase 202 found it by reading the table the nomination pointed at.
 *
 * There are hundreds, and the overwhelming majority are right: a journal
 * line's amount, an audit event's action and a sent document's snapshot are
 * immutable **on purpose**, and several ADRs exist to keep them that way
 * (0021, 0042). So this is not a register — a register of hundreds of entries
 * saying "correctly immutable" would be an excuse generator, which is the
 * failure ADR 0134 names.
 *
 * It is a number, declared so the limitation keeps its reason (Phase 185) and
 * measured so the prose cannot drift from it (Phase 179).
 *
 * **Phase 212 has a way**, after this sentence spent ten phases saying there
 * was none: `paintedStates` below. It does not whittle the number down — 1,168
 * columns are still written once and never changed, and nearly all of them
 * rightly — it narrows the *question*, to the 28 that could have held more than
 * one value and the one that never could.
 */
export function insertOnlyColumns(): number {
  const tables = schemaColumns()
  const { inserted, updated, named } = writeSites(tables)

  let total = 0
  for (const [tableVar, table] of tables) {
    for (const [column, info] of table.columns) {
      const key = `${tableVar}.${column}`
      if (info.systemSet) continue
      if (!named.has(key)) continue
      if (inserted.has(key) && !updated.has(key)) total += 1
    }
  }

  return total
}

/**
 * A state nothing can change, as opposed to a record nothing should (Phase 212).
 *
 * ## The question this answers
 *
 * `insertOnlyColumns` has said since Phase 202 that narrowing its 1,169 *"needs
 * a way to say which columns are **state** rather than **record**, and this
 * phase does not have one."* Ten phases later, here is one, and the reason it
 * took ten phases is that the first three attempts were all judgements. This
 * one is not:
 *
 * > A column is **state** when its declared domain holds more than one value —
 * > an `enum` list, or a boolean. It is **painted on** when it is insert-only,
 * > every write of it is the same literal, and that literal is also its schema
 * > default: no statement anywhere can make the column differ from what the
 * > database would have put there by itself.
 *
 * Both halves matter. Without the domain test this is a register of hundreds of
 * amounts and dates that are immutable on purpose (ADR 0021, ADR 0042). Without
 * the default test it reports a column whose write **is** the distinction.
 *
 * ## What it measured on the day it was written
 *
 * **1,169 insert-only columns, 28 with a domain of more than one value, 4
 * written only ever as literals, 1 whose literal is also its default.** The
 * three survivors each survive for a different reason, which is what makes the
 * one a finding rather than a quota:
 *
 * | column | domain | written | why it is fine |
 * | --- | --- | --- | --- |
 * | `progress_billings.isRetainageRelease` | 2 | `true` | defaults to `false`, so both values occur |
 * | `accountant_exports.result` | 2 | `'generated'`, `'held'` | no default, both literals written |
 * | `refunds.direction` | 2 | `'out'`, `'in'` | no default, both literals written |
 * | `projects.status` | **4** | `'active'` | its one literal is its default |
 *
 * `projects.status` is Phase 212's subject: four states, read by the WIP
 * schedule's own filter, and one of the four ever reachable. `writerCandidates`
 * could not see it, because an insert that names a column counts as a writer;
 * `insertOnlyColumns` counted it among 1,169 and said nothing about which; and
 * the register's entry for that table was about two *other* columns and gave a
 * false reason for keeping them.
 *
 * ## Why this returns the list and not a count
 *
 * The three survivors are the point. A number would go green at 0 and say
 * nothing about what it had ruled out, and the next painted-on state will be
 * found by the shape of its entry here rather than by somebody re-deriving the
 * rule. The test asserts the whole list, so adding a fifth literal-written
 * state is a failure that names it.
 */
export type PaintedState = {
  table: string
  column: string
  /** How many values the declaration allows. Always greater than one. */
  domain: number
  /** The distinct right-hand sides written to it, as source text. */
  written: readonly string[]
  /** The schema default's literal, or null when it has none. */
  fallback: string | null
  /** True when no write can make it differ from its default. */
  painted: boolean
}

export function paintedStates(): PaintedState[] {
  const tables = schemaColumns()
  const { inserted, updated, named, literals } = writeSites(tables)
  const found: PaintedState[] = []

  for (const [tableVar, table] of tables) {
    for (const [column, info] of table.columns) {
      const key = `${tableVar}.${column}`
      if (info.systemSet) continue
      if (!named.has(key)) continue
      if (!inserted.has(key) || updated.has(key)) continue

      const domain = declaredDomain(info.declaration)
      if (domain < 2) continue

      const written = [...new Set(literals.get(key) ?? [])]
      if (!written.every(isLiteral)) continue

      const fallback = declaredDefault(info.declaration)

      found.push({
        table: table.sqlName,
        column,
        domain,
        written,
        fallback,
        painted: written.length === 1 && fallback !== null && written[0] === fallback,
      })
    }
  }

  return found.sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  )
}

/** How many values a declaration allows: an enum's list, a boolean's two, else one. */
function declaredDomain(declaration: string): number {
  const listed = /enum:\s*\[([^\]]*)\]/.exec(declaration)
  if (listed) return listed[1].split(',').filter((entry) => entry.trim().length > 0).length

  return /^\s{4}\w+:\s*boolean\(/.test(declaration) ? 2 : 1
}

/** The literal a schema default supplies, or null. */
function declaredDefault(declaration: string): string | null {
  const defaulted = /\.default\((\s*'[^']*'\s*|\s*true\s*|\s*false\s*)\)/.exec(declaration)
  return defaulted ? defaulted[1].trim() : null
}

/** A quoted string or a boolean keyword — something with no input behind it. */
function isLiteral(written: string): boolean {
  return /^'[^']*'$/.test(written) || written === 'true' || written === 'false'
}

/** How many columns the scan looked at, for the register's own prose. */
export function columnsScanned(): { tables: number; columns: number } {
  const tables = schemaColumns()

  return {
    tables: tables.size,
    columns: [...tables.values()].reduce((total, table) => total + table.columns.size, 0),
  }
}
