/**
 * The id a caller hands in (Phase 170).
 *
 * ## The hole Phases 149 and 150 did not cover
 *
 * Those two phases audited every write and every read for the guard that keeps
 * it from reaching **another tenant's row**: 110 writes and 883 reads, each
 * standing on `scoped()`, an explicit `companyId`, or an argued alternative.
 * That work is complete and it answers one question — *can this statement be
 * aimed at a row that is not ours?*
 *
 * It does not answer the other one. A write can be perfectly guarded, landing
 * squarely on the caller's own row, and still **store a reference to somebody
 * else's**. `createInvoice` writes an `invoice_lines` row scoped to the caller's
 * company and copies `item_id` out of the payload; the foreign key proves that
 * id names a real `service_items` row and says nothing about whose.
 *
 * Phase 169 found that exact case and could only contain it — the report's join
 * is scoped, so a foreign item groups as *"not in this company's catalogue"*
 * instead of printing its name. Containment is not prevention, and that ADR
 * nominated the prevention.
 *
 * ## Measured: 271 of them, and not one carries the tenant
 *
 * Across 167 company-scoped tables there are **271 foreign keys pointing from
 * one tenant-scoped table to another**, and every one is single-column. Not a
 * single reference in this database says "and it must be yours".
 *
 * Which makes this a class, not a bug. A registry of exceptions would be the
 * wrong instrument for 271 of anything.
 *
 * ## Postgres can express it, which settles how
 *
 * Phase 116's rule is that a constraint beats a check, and the reason this file
 * exists rather than a lint rule is that the constraint is available:
 *
 * ```sql
 * ALTER TABLE service_items ADD UNIQUE (company_id, id);
 * ALTER TABLE invoice_lines
 *   ADD FOREIGN KEY (company_id, item_id)
 *       REFERENCES service_items (company_id, id);
 * ```
 *
 * The line's own `company_id` becomes part of the reference, so a row in
 * company A cannot point at an item in company B — the pair does not exist.
 * Nothing has to be remembered, no scan has to stay green, and a path written
 * next year inherits it.
 *
 * It is not free: the target needs a redundant unique index on
 * `(company_id, id)`, since `id` alone is already unique. That is the price, it
 * is one index per referenced table, and it buys a guarantee no amount of
 * application code can.
 */

import { RegistryError } from '@/modules/errors/registry'

/**
 * What makes a stored reference trustworthy.
 *
 * Ordered strongest first, which is also the order `proofOf` tries them: the
 * question is not "is there a guard somewhere" but "what is the strongest thing
 * holding this reference up".
 */
export type ReferenceProof =
  /**
   * The tenant is part of the foreign key.
   *
   * The database refuses the row. Survives a new writer, a refactor that moves
   * the lookup, and a path nobody has written yet.
   */
  | 'composite-key'
  /**
   * The writer looked the id up, scoped to the company, and refused when it
   * found nothing.
   *
   * `logCommunication`'s shape, and the module says why it chose it: *"three
   * lookups rather than trusting three uuids from a form."* Sound, and it holds
   * only as long as that function is the only way in — a second writer added
   * later gets nothing from it.
   */
  | 'scoped-lookup'
  /**
   * The reference is derived, not supplied.
   *
   * The id came from a row the writer had already proved, so there is nothing
   * for a caller to tamper with. Strong, and easy to lose: it stops being true
   * the moment somebody adds a parameter that overrides it.
   */
  | 'derived'
  /**
   * Nothing proves it.
   *
   * A caller-supplied uuid written into a tenant row, with a single-column
   * foreign key behind it. The row exists; whose it is was never asked.
   */
  | 'unproved'

export type ProofDefinition = {
  key: ReferenceProof
  /** Whether the database alone enforces it. */
  enforcedByDatabase: boolean
  /** What it survives, which is the whole of what separates these. */
  survives: string
  because: string
}

export const REFERENCE_PROOFS: readonly ProofDefinition[] = [
  {
    key: 'composite-key',
    enforcedByDatabase: true,
    survives:
      'A new writer, a moved lookup, a path nobody has written yet, and an engineer who has ' +
      'never read this file.',
    because:
      'The tenant is part of the reference, so the pair a foreign row would need does not exist. ' +
      'This is the only proof on the list that does not depend on somebody remembering ' +
      'something, which is Phase 116 exactly: a constraint beats a check. It costs one redundant ' +
      'unique index per referenced table — `(company_id, id)` where `id` is already unique — and ' +
      'that is the whole price.',
  },
  {
    key: 'scoped-lookup',
    enforcedByDatabase: false,
    survives: 'Everything inside the function that does it, and nothing outside.',
    because:
      '`logCommunication`\'s three lookups, each scoped and each refusing — "three lookups rather ' +
      'than trusting three uuids from a form". It is correct where it is used and it is a ' +
      'property of the *writer* rather than of the data, so the second writer of the same column ' +
      'inherits none of it. That is not a reason to remove it; it is the reason it is not the ' +
      'strongest row on this list.',
  },
  {
    key: 'derived',
    enforcedByDatabase: false,
    survives: 'Anything that does not add a way to supply the id from outside.',
    because:
      'The id was read from a row the writer had already proved, so no caller ever names it — ' +
      '`conversion.ts` taking the revenue account from the proposal it is converting. Strong ' +
      'while it lasts and quiet when it stops: adding an optional parameter that overrides the ' +
      'derived value turns this into `unproved` with no diff to the write itself.',
  },
  {
    key: 'unproved',
    enforcedByDatabase: false,
    survives: 'Nothing. It is the absence of a proof rather than a weak one.',
    because:
      'A uuid from a payload written into a tenant row behind a single-column foreign key. The ' +
      'key proves the row exists and says nothing about whose it is, which is the defect Phase ' +
      '169 found on `invoice_lines.item_id` and could only contain. Named rather than left as the ' +
      'default so that a count of them is a number somebody can watch fall.',
  },
]

export function proofFor(key: string): ProofDefinition {
  const found = REFERENCE_PROOFS.find((proof) => proof.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'REFERENCE_PROOFS',
    key,
    message:
      `No reference proof is declared as "${key}". The register is the list of things that can ` +
      'hold a stored reference up, ordered by what each one survives — and the order is the ' +
      'point, because three of the four are properties of code rather than of data and only one ' +
      `is the database refusing the row. Declared: ${REFERENCE_PROOFS.map((proof) => proof.key).join(', ')}.`,
  })
}

/**
 * What is true of one reference, measured rather than declared.
 *
 * Every field is something a scan can establish by reading the database or the
 * source — the rule Phase 136's `askingFor` and Phase 139's `wiringStateFor`
 * both follow, for the reason Phase 135 recorded: a register that believes its
 * own entries goes stale without anybody noticing.
 */
export type ReferenceObservation = {
  /** `invoice_lines.item_id`, as the database names it. */
  table: string
  column: string
  /** The tenant-scoped table it points at. */
  target: string
  /** Measured: is `company_id` part of this foreign key? */
  tenantInKey: boolean
  /** Measured: does every writer of this column look the id up, scoped? */
  everyWriterLooksItUp: boolean
  /** Measured: is the column never set from a parameter? */
  neverSuppliedByCaller: boolean
}

/** The strongest proof this reference actually has. */
export function proofOf(observation: ReferenceObservation): ReferenceProof {
  if (observation.tenantInKey) return 'composite-key'
  if (observation.neverSuppliedByCaller) return 'derived'
  if (observation.everyWriterLooksItUp) return 'scoped-lookup'
  return 'unproved'
}

/**
 * Whether a claimed proof survives measurement.
 *
 * The direction that matters, and the one Phase 135 found missing from
 * `BANK_POSTINGS`: a declaration that has stopped being true reads exactly like
 * one that is.
 */
export type ReferenceVerdict = { ok: true; proof: ReferenceProof } | { ok: false; why: string }

export function referenceStands(input: {
  observation: ReferenceObservation
  /** What somebody claimed about it. */
  claimed: ReferenceProof
}): ReferenceVerdict {
  const { observation, claimed } = input
  const actual = proofOf(observation)
  const where = `${observation.table}.${observation.column}`

  if (claimed === actual) return { ok: true, proof: actual }

  if (claimed === 'composite-key') {
    return {
      ok: false,
      why:
        `${where} claims the tenant is in its foreign key and it is not. This is the one claim ` +
        'on the list that is a fact about the database rather than about the code, so it is also ' +
        'the one that can be checked without reading anything — and claiming it falsely would ' +
        'retire a real guard in favour of nothing.',
    }
  }

  return {
    ok: false,
    why:
      `${where} claims ${claimed} and measures ${actual}. ` +
      (actual === 'unproved'
        ? 'Nothing holds it up, so the claim is the only thing standing between this column and a ' +
          'cross-tenant reference.'
        : `Its real proof is stronger than claimed, which is harmless today and means the ` +
          'register is describing code that has moved on.'),
  }
}

/**
 * How far the conversion has got, in the shape Phase 160 used for RLS.
 *
 * 271 references cannot be converted in one phase, and a phase that converted
 * two and said nothing about the other 269 would be the kind of partial work
 * this codebase keeps finding in its own history. So the count is measured by a
 * test, the stages are named here, and the number can only move one way.
 */
export type RolloutStage = {
  stage: string
  what: string
  because: string
}

export const REFERENCE_ROLLOUT: readonly RolloutStage[] = [
  {
    stage: 'measured',
    what: '271 single-column references between 167 tenant-scoped tables, none carrying the tenant.',
    because:
      'Phase 170 counted them from `pg_constraint` rather than estimating, because the first ' +
      'thing a programme of this size needs is a denominator that cannot be argued with. The ' +
      'test asserts the measured figure, so the day somebody adds a reference the count moves and ' +
      'says so.',
  },
  {
    stage: 'proved where it was found',
    what: '`invoice_lines.item_id` and `bill_lines.item_id` carry `company_id` in the key.',
    because:
      'The two Phase 169 found and could only contain, converted first because a mechanism ' +
      'demonstrated on the case that motivated it is a mechanism somebody can check. They are ' +
      'also the two that drive inventory relief, so a foreign id there moves the wrong stock.',
  },
  {
    stage: 'the rest',
    what: '269 references still proved by nothing stronger than the writer that happens to set them.',
    because:
      'Deliberately not done here. Each conversion needs a unique index on the target and a ' +
      'migration that cannot be mechanical — a nullable reference, a self-reference and a ' +
      'reference from an unscoped table all need different handling, and discovering that 60 ' +
      'tables in is worse than saying so now. The count is the backlog.',
  },
]
