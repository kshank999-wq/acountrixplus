import { Refusal } from './index'
import { RegistryError } from './registry'

/**
 * What "not found" means, and why it must not say more (Phase 120).
 *
 * ## The defect
 *
 * Phase 119 gave 192 refusals a way to reach a person. Ninety bare throws were
 * left, and **74 of them are `X not found`** — the largest single family in the
 * codebase. They stayed bare because the heuristic reads them as log fragments,
 * which they are. They are also the answer a person gets for clicking a link
 * that no longer works, and *that* answer is "Something went wrong."
 *
 * But rewording them is not a wording job, because of what else they are doing.
 *
 * ## "Not found" is answering two questions at once
 *
 * Measured across the 74: **49 sit directly after a `scoped()` query.**
 * `scoped` adds `company_id = ctx.companyId`, so an id belonging to another
 * company returns no row and falls into the same branch as an id that never
 * existed. The message is therefore doing two jobs:
 *
 * 1. telling somebody their link is stale, and
 * 2. **refusing to confirm that a record exists in another company's books.**
 *
 * The second is a real security property and it is deliberate — a message that
 * distinguished the cases would turn any id into an oracle for "does this
 * invoice exist somewhere in this system". `tests/mobile.test.ts` even asserts
 * on it:
 *
 * ```ts
 * await expect(revokeDevice(fixture.ctx, theirPhone.id)).rejects.toThrow(/not found/i)
 * ```
 *
 * That is a tenant-isolation test whose subject is the **wording**. So the
 * wording is load-bearing, and until this phase nothing anywhere said so. The
 * obvious improvement — *"That device belongs to Kestrel Joinery"* — is a
 * cross-tenant disclosure, it reads like a kindness, and no rule would have
 * stopped somebody writing it.
 *
 * ## What this does
 *
 * Declares the record kinds, so a lookup that fails has to name what it was
 * looking for and say whether the tenancy boundary is part of its answer, and
 * produces one sentence shaped to be true of all three causes:
 *
 * - it never existed,
 * - it was deleted or voided since the page was drawn,
 * - it belongs to another company.
 *
 * The sentence says where the reader is (*not on these books*) and what to do
 * (*reload*), which is everything they can act on, and nothing about which of
 * the three it was — which is everything they must not learn.
 */

/** A record a lookup can fail to find, and what the failure is allowed to say. */
export type RecordKind = {
  /** Lookup key, used at the throw site. */
  key: string
  /**
   * How to name it in a sentence, lower case: "invoice", "bank account".
   * Read directly by a person, so it is the word the screens use, not the
   * table name.
   */
  noun: string
  /**
   * True when the lookup that precedes this throw is tenant-scoped, so
   * "not found" is also this system declining to confirm the record exists
   * elsewhere. Recorded per kind because it is the fact that makes the
   * wording load-bearing.
   */
  tenantScoped: boolean
  /** Why this kind is looked up the way it is, in the terms of the books. */
  because: string
}

const SCOPED_BECAUSE =
  'Looked up inside the acting company, so a record belonging to somebody else returns nothing ' +
  'and lands here. The sentence must stay true of that case without confirming it.'

const OPEN_BECAUSE =
  'Looked up without a tenant filter because the id is already known to belong to the caller, ' +
  'or the row is shared. It can still be stale, so the reader is told the same thing.'

function scoped(key: string, noun: string): RecordKind {
  return { key, noun, tenantScoped: true, because: SCOPED_BECAUSE }
}

function open(key: string, noun: string): RecordKind {
  return { key, noun, tenantScoped: false, because: OPEN_BECAUSE }
}

/**
 * Every kind a `missing()` call may name.
 *
 * A key that is not here throws, on the Phase 101 device — a new record type
 * has to say what to call it before a lookup for it can fail politely.
 */
export const RECORD_KINDS: readonly RecordKind[] = [
  scoped('invoice', 'invoice'),
  scoped('creditNote', 'credit note'),
  scoped('writeOff', 'write-off'),
  scoped('customer', 'customer'),
  scoped('vendor', 'supplier'),
  scoped('organization', 'organisation'),
  scoped('client', 'client'),
  scoped('financialAccount', 'bank account'),
  scoped('bankConnection', 'bank connection'),
  scoped('chartAccount', 'account'),
  scoped('chartAccounts', 'accounts'),
  scoped('liabilityAccount', 'liability account'),
  scoped('deposit', 'deposit'),
  scoped('transaction', 'transaction'),
  scoped('rule', 'rule'),
  scoped('journalEntry', 'journal entry'),
  scoped('entry', 'entry'),
  scoped('recurringEntry', 'recurring entry'),
  scoped('accountingPeriod', 'accounting period'),
  scoped('close', 'year-end close'),
  scoped('reconciliation', 'reconciliation'),
  scoped('opportunity', 'opportunity'),
  scoped('proposal', 'proposal'),
  scoped('campaign', 'campaign'),
  scoped('segment', 'segment'),
  scoped('brandKit', 'brand kit'),
  scoped('clause', 'clause'),
  scoped('document', 'document'),
  scoped('job', 'job'),
  scoped('jobs', 'jobs'),
  scoped('costCode', 'cost code'),
  scoped('costCodes', 'cost codes'),
  scoped('changeOrder', 'change order'),
  scoped('subcontractor', 'subcontractor'),
  scoped('purchaseOrder', 'purchase order'),
  scoped('item', 'item'),
  scoped('asset', 'asset'),
  scoped('engagement', 'engagement'),
  scoped('timeEntry', 'time entry'),
  scoped('retainer', 'retainer'),
  scoped('payrollRun', 'payroll run'),
  scoped('filing', 'filing'),
  scoped('device', 'device'),
  open('company', 'company'),
  open('user', 'user'),
]

/** The kind behind a key. Throws on a key nobody declared. */
export function kindFor(key: string): RecordKind {
  const kind = RECORD_KINDS.find((row) => row.key === key)
  if (!kind) {
    throw new RegistryError({
      registry: 'RECORD_KINDS',
      key,
      message:
        `No record kind is declared for "${key}". A lookup has to say what it was looking for ` +
        'before it can tell somebody it failed.',
    })
  }
  return kind
}

/**
 * The refusal for a lookup that came back empty.
 *
 * One sentence, true whichever of the three causes it was, and silent about
 * which. `plural` is for the lookups that take a list of ids and find fewer
 * rows than they asked for.
 */
export function missing(key: string, opts?: { plural?: boolean }): Refusal {
  const kind = kindFor(key)

  return new Refusal(
    opts?.plural
      ? `Some of those ${kind.noun} are not on these books. They may have been removed since ` +
        'this page was opened — reload and try again.'
      : `That ${kind.noun} is not on these books. It may have been removed since this page was ` +
        'opened — reload and try again.',
  )
}

/**
 * Words a `missing()` sentence may never contain.
 *
 * Not a spell-checker: each of these is a way of answering the question the
 * tenancy boundary exists to leave unanswered. `tests/missing-record.test.ts`
 * holds every declared kind against them, so the rule survives somebody
 * rewording a message to be friendlier.
 */
export const DISCLOSING_WORDS: readonly { word: string; because: string }[] = [
  {
    word: 'another company',
    because:
      'Naming the other side confirms the record exists, which is the one fact the tenancy ' +
      'boundary is there to withhold.',
  },
  {
    word: 'belongs to',
    because:
      'Ownership language answers "does this exist somewhere" even without naming the owner. ' +
      '"Belongs to somebody else" is still a yes.',
  },
  {
    word: 'permission',
    because:
      'A permission refusal is a different answer with a different meaning — it says the record ' +
      'is real and the reader is not allowed at it. Saying that here would make an id an oracle.',
  },
  {
    word: 'deleted',
    because:
      'A definite past tense claims to know which of the three causes it was. "Removed since ' +
      'this page was opened" offers the likely one without asserting it.',
  },
]
