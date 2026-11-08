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
 * **34 candidates**, of which six are findings. A closed one is **absent**
 * from this register, because the scan no longer reports it — which is what
 * proves an editor reaches the column rather than only existing, and the
 * tests assert that absence by name.
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
 * Six remain, declared below and nominated: `vendors.organizationId`, and
 * four `isActive` columns nothing can turn off, of which two are enforced by
 * a refusal and two are only ever displayed.
 */

/** Where a candidate stands. */
export type WriterVerdict =
  /** Something writes it; the scan cannot see the write. The entry says where. */
  | 'written'
  /** Nothing writes it, and that is a defect with a decision recorded. */
  | 'unwritable'

export type ColumnWriter = {
  /** The table's SQL name, as `pgTable` declares it. */
  table: string
  /** The columns of that table this entry accounts for, by property name. */
  columns: readonly string[]
  verdict: WriterVerdict
  /** For `written`: the file that writes them. Empty for `unwritable`. */
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
    columns: ['amountCents', 'pending', 'postedDate'],
    verdict: 'written',
    writtenBy: 'src/modules/banking/revision-service.ts',
    because:
      'Written by `...incoming` and `...previous` — the feed\'s new figures and the ones they ' +
      'replace, spread side by side so a held revision records both. Nothing a person types by ' +
      'definition: a revision is what the bank said changed, and a field offering to edit it ' +
      'would be inventing a bank statement.',
  },
  {
    table: 'brand_kits',
    columns: ['logoAssetId'],
    verdict: 'written',
    writtenBy: 'src/modules/studio/service.ts',
    because:
      'Written by `.values({ companyId: ctx.companyId, ...input })` and `.set({ ...input })`, so ' +
      'the column name appears nowhere at the write — the spread carries every field of ' +
      "`BrandKitInput`, which has it. Reachable by a person: the brand kit's logo picker is what " +
      'fills it. This is the mechanism that makes the scan a candidate list rather than an ' +
      'assertion, because resolving a spread needs the typechecker.',
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
      'title',
      'topic',
      'userId',
    ],
    verdict: 'written',
    writtenBy: 'src/modules/mobile/notifications.ts',
    because:
      'All ten written by `.values(decisionFor(input))` — one helper builds the whole row, so no ' +
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
      'sortOrder',
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
      'what a signature actually agreed to.',
  },
  {
    table: 'service_items',
    columns: ['description'],
    verdict: 'written',
    writtenBy: 'src/modules/studio/service.ts',
    because:
      '`createServiceItem` spreads `...input`, whose `ServiceItemInput` has it, and the Design ' +
      'Center catalogue form both sets it and shows it under the item name. Worth the entry ' +
      'because `inventoryAccountId` on this same table was a real finding: two columns of one ' +
      'table, one written through a spread and one written nowhere, indistinguishable from the ' +
      'scan and three lines apart in the schema.',
  },

  // --- Unwritable, and recorded as findings ---------------------------------
  {
    table: 'cash_drawers',
    columns: ['isActive'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '**A till cannot be retired.** `openShift` reads it and refuses — *"X is not in use."* — so ' +
      'this is the gift card\'s shape exactly: an enforced refusal with no way to reach the state ' +
      'that triggers it. A shop that closes a counter keeps being offered it at every cash-up for ' +
      'ever. Below the gift card only because nothing can go missing through it.',
  },
  {
    table: 'clauses',
    columns: ['isActive'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '**A terms clause cannot be retired, and retiring one would not do anything.** §15 asks for ' +
      'standard terms, clauses and disclaimers, and the one thing a company does with old wording ' +
      'is stop offering it — `createClause` has no `isActive` input and nothing updates the row. ' +
      'Weaker than the two above and worth distinguishing from them: the only reader is a ' +
      '**projection**, `listClauses` selecting the column to show it. Nothing filters on it, so a ' +
      'writer alone would leave a flag a person could set with no effect — Phase 160\'s shape ' +
      'arrived at by fixing half the gap. Closing this is two changes, not one.',
  },
  {
    table: 'bills_of_materials',
    columns: ['isActive'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '**A bill of materials cannot be superseded, and nothing would notice if it were.** The ' +
      'clause entry\'s shape: the only reader is a projection in `manufacturing/service.ts` that ' +
      'selects the column to report it, and no query filters a work order\'s recipe on it. So a ' +
      'factory that changes a recipe keeps both live *and* a flag saying which is current would ' +
      'change nothing until something read it. An earlier draft of this entry claimed the recipe ' +
      'choice was filtered on it; reading the two call sites is what corrected that, which is the ' +
      'whole method of this register.',
  },
  {
    table: 'practices',
    columns: ['isActive'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '**An accounting practice cannot be deactivated.** Filtered in four queries — the client\'s ' +
      'own search for a firm, the offer path, the engagement check and the nightly practice ' +
      'sweep — so the column is enforced in more places than any of the other five and reachable ' +
      'from none. A platform-level row rather than a company\'s own, which is why it is declared ' +
      'rather than given a screen here: who may retire a practice is a different question from ' +
      'who may edit their own books.',
  },
  {
    table: 'vendors',
    columns: ['organizationId'],
    verdict: 'unwritable',
    writtenBy: '',
    because:
      '**The supplier who is also a client, which one module exists for and no screen can ' +
      'produce.** `engagement/filing.ts` spends a page on the firm that both buys from you and ' +
      'sells to you — one shared inbox, a remittance that must not land on their debt to us — ' +
      'and `outbound.ts` reads `vendors.organizationId` so a supplier letter also reaches that ' +
      "client's CRM timeline. The customer side is written by `crm/conversion.ts` when an " +
      'opportunity is won. There is no such path for a supplier: `createVendor` has no such ' +
      'input, and the correction screen is driven by `VENDOR_FIELDS`, a registry of text fields, ' +
      'so a link to a CRM record is a new kind of field rather than one more entry. Declared ' +
      'rather than closed for that reason, and nominated in ADR 0201.',
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

type SchemaColumn = { systemSet: boolean }

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
        columns.set(c[1], { systemSet: /defaultNow\(|defaultRandom\(/.test(own?.[0] ?? '') })
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
 * Columns the scan cannot see a writer for.
 *
 * `read` is `tableVar.column` appearing outside the schema — drizzle spells a
 * select, a where and an order the same way, so this is "something names it".
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
  const settable = new Set<string>()
  const named = new Set<string>()

  for (const dir of ['src/modules', 'src/app'] as const) {
    for (const file of sourceFiles(dir)) {
      const src = readableSource(file)
      const whole = withoutComments(readFileSync(file, 'utf8'))

      for (const m of whole.matchAll(/\.(insert|update)\(\s*(\w+)\s*\)\s*\.(values|set)\(/g)) {
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
          for (const k of argument.matchAll(/(\w+)\s*:/g)) settable.add(`${target}.${k[1]}`)
          for (const k of argument.matchAll(/[{,]\s*(\w+)\s*(?=[,}])/g)) {
            settable.add(`${target}.${k[1]}`)
          }
        }
      }

      for (const m of src.matchAll(/\b(\w+)\.(\w+)\b/g)) named.add(`${m[1]}.${m[2]}`)
    }
  }

  const candidates: WriterCandidate[] = []

  for (const [tableVar, table] of tables) {
    for (const [column, info] of table.columns) {
      if (info.systemSet) continue
      if (!named.has(`${tableVar}.${column}`)) continue
      if (settable.has(`${tableVar}.${column}`)) continue

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
 * measured so the prose cannot drift from it (Phase 179). Narrowing it needs a
 * way to say which columns are *state* rather than *record*, and this phase
 * does not have one.
 */
export function insertOnlyColumns(): number {
  const tables = schemaColumns()
  const inserted = new Set<string>()
  const updated = new Set<string>()
  const named = new Set<string>()

  for (const dir of ['src/modules', 'src/app'] as const) {
    for (const file of sourceFiles(dir)) {
      const src = readableSource(file)
      const whole = withoutComments(readFileSync(file, 'utf8'))

      for (const m of whole.matchAll(/\.(insert|update)\(\s*(\w+)\s*\)\s*\.(values|set)\(/g)) {
        const into = m[1] === 'insert' ? inserted : updated
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
          for (const k of argument.matchAll(/(\w+)\s*:/g)) into.add(`${target}.${k[1]}`)
          for (const k of argument.matchAll(/[{,]\s*(\w+)\s*(?=[,}])/g)) {
            into.add(`${target}.${k[1]}`)
          }
        }
      }

      for (const m of src.matchAll(/\b(\w+)\.(\w+)\b/g)) named.add(`${m[1]}.${m[2]}`)
    }
  }

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

/** How many columns the scan looked at, for the register's own prose. */
export function columnsScanned(): { tables: number; columns: number } {
  const tables = schemaColumns()

  return {
    tables: tables.size,
    columns: [...tables.values()].reduce((total, table) => total + table.columns.size, 0),
  }
}
