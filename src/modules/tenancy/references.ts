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
 * Why a composite tenant key can be present and do nothing (Phase 172).
 *
 * ## The hazard
 *
 * A foreign key's default matching rule is `MATCH SIMPLE`, and under it **a
 * multi-column key is not checked at all when any of its columns is NULL.**
 *
 * So a composite tenant key on a table whose `company_id` is nullable is
 * enforced for every row that has one and silently skipped for every row that
 * does not. It would appear in `pg_constraint`, satisfy the count this
 * programme tracks, and guarantee nothing for exactly the rows least likely to
 * have been thought about.
 *
 * That is Phase 160's finding in a new place — *"the policies that would have
 * done nothing"* — and Phase 121's rule about a check only ever seen to agree.
 * A conversion count is a number that can go up while the guarantee does not,
 * which is the specific way this programme could fail without anybody noticing.
 *
 * ## Measured, so the ceiling is a fact rather than a worry
 *
 * ADR 0171 nominated measuring how many references *cannot* carry the tenant
 * and guessed the blocker would be references from unscoped tables. It is not:
 * all 271 run between scoped tables, so every one has a `company_id` to put in
 * the key, and only two references anywhere come from an unscoped table.
 *
 * The real blocker is **nullable `company_id`**, on nine tables, affecting
 * three references:
 *
 * ```
 * notification_log.message_id          -> transactional_messages   both ends nullable
 * communications.transactional_message_id -> transactional_messages   target nullable
 * push_subscriptions.device_id         -> devices                  target nullable
 * ```
 *
 * A nullable *source* is the dangerous one, for the reason above. A nullable
 * *target* is a different problem and not a dangerous one: a row with no
 * `company_id` has no `(company_id, id)` pair, so it cannot be referenced at
 * all and the key refuses rows that are currently legal.
 *
 * Those three are the ceiling. **268 of 271 are cleanly convertible**, and the
 * three are not blocked by anything about tenancy — they are blocked by rows
 * that genuinely belong to no company: a password-reset email before anybody
 * has logged in, a device not yet claimed.
 *
 * ## The rule this produces
 *
 * Convert a reference only when the **source's** `company_id` is `NOT NULL`.
 * `tests/the-id-a-caller-hands-in.test.ts` asserts that no converted key has a
 * nullable source — zero today, verified rather than assumed, and the assertion
 * is what stops a later slice shipping a key that does nothing.
 */
export type NullableHazard = {
  reference: string
  end: 'source' | 'target' | 'both'
  /** What goes wrong, which differs by end. */
  consequence: string
  because: string
}

export const NULLABLE_TENANT_REFERENCES: readonly NullableHazard[] = [
  {
    reference: 'notification_log.message_id -> transactional_messages',
    end: 'both',
    consequence:
      'Unenforced for rows with no company, and unable to reference a message with no company.',
    because:
      'A notification log row records what was sent, and a transactional message can be a ' +
      'password reset sent before anybody has a company — so both ends are nullable for the same ' +
      'honest reason. Converting this would produce a key that is skipped on exactly the rows ' +
      'that have no tenant to check, which is worse than the single-column key it replaced ' +
      'because the count would say it was done.',
  },
  {
    reference: 'communications.transactional_message_id -> transactional_messages',
    end: 'target',
    consequence: 'Would refuse a letter that currently files correctly.',
    because:
      'The source is `NOT NULL`, so the key would be enforced — and it would refuse any ' +
      'communication pointing at a message with no company, which `transactional_messages` ' +
      'permits on purpose. The fix is on the target and is a data question nobody has asked: ' +
      'whether a message with no company should exist once the system has companies.',
  },
  {
    reference: 'push_subscriptions.device_id -> devices',
    end: 'target',
    consequence: 'Would refuse a subscription on a device not yet claimed by a company.',
    because:
      '`devices` is one of Phase 160\'s six RLS exemptions, and that phase recorded why it is the ' +
      'dangerous one: a revoked device reads as live when the policy blinds it. A nullable ' +
      '`company_id` is the same looseness at the column level, and tightening it is a decision ' +
      'about device enrolment rather than about references.',
  },
]

/**
 * The shapes a conversion comes in (Phase 171).
 *
 * ADR 0170 declined to convert all 271 mechanically and predicted that they
 * would not be uniform. Phase 171 converted every reference into one table and
 * measured the prediction: **sixteen references, three shapes.** Written down
 * because the next slice will meet them again, and because the prediction being
 * right is only useful if the shapes are named rather than remembered.
 */
export type ConversionShape = {
  key: string
  /**
   * How many of the sixteen references into `service_items` are this shape.
   *
   * All sixteen, not the fourteen Phase 171 converted: the two Phase 170 did
   * are references into the same table and have the same shape as four of
   * these, and counting only the new ones would make the field mean "work done
   * in one phase" while being named after the slice.
   */
  foundInCatalogueSlice: number
  /** The delete rule the composite key needs. */
  deleteRule: string
  because: string
}

export const CONVERSION_SHAPES: readonly ConversionShape[] = [
  {
    key: 'set-null-nullable',
    // Six: `appointments`, `proposal_items`, `repair_order_lines` and
    // `time_entries` in Phase 171, and `invoice_lines` and `bill_lines` in
    // Phase 170 — which is where the column-list delete rule was first needed
    // and is why this shape was already understood when the slice met four more.
    foundInCatalogueSlice: 6,
    deleteRule: 'ON DELETE SET NULL (col)',
    because:
      'The column list is required and this is the shape that proves a mechanical sweep would ' +
      'have broken things. A bare `ON DELETE SET NULL` nulls every column of the reference, ' +
      '`company_id` is `NOT NULL`, and the delete fails — so deleting a catalogue entry would be ' +
      'blocked by an invoice raised three years ago, which is the outcome the `SET NULL` was ' +
      'chosen to avoid in the first place.',
  },
  {
    key: 'restrict-not-null',
    foundInCatalogueSlice: 9,
    deleteRule: 'ON DELETE RESTRICT',
    because:
      'The common case and the simplest: `RESTRICT` nulls nothing, so no column list and the ' +
      '`NOT NULL` never comes up. The rule is right for reasons that have nothing to do with ' +
      'tenancy — a stock movement or a bill of materials that lost the item it moved would be a ' +
      'record of nothing — which is why these nine needed no decision beyond adding the tenant.',
  },
  {
    key: 'restrict-nullable',
    foundInCatalogueSlice: 1,
    deleteRule: 'ON DELETE RESTRICT',
    because:
      'Its own shape because the pair is unusual rather than because the SQL differs: a column ' +
      'that may be null, whose item may not be deleted while it is set. ' +
      '`work_order_entries.item_id` is null for labour and set for a part consumed, and a ' +
      'consumed part is not deletable — the same argument as the restrict case, arriving at it ' +
      'from a nullable column.',
  },
]

/**
 * How far the conversion has got, in the shape Phase 160 used for RLS.
 *
 * 274 references cannot be converted in one phase, and a phase that converted
 * two and said nothing about the other 269 would be the kind of partial work
 * this codebase keeps finding in its own history. So the count is measured by a
 * test, the stages are named here, and the number can only move one way.
 *
 * Phase 171 took the next slice by *referenced* table: all sixteen references
 * into `service_items`, which is a claim about the data rather than about the
 * backlog — no row anywhere can name a catalogue item belonging to another
 * company.
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
    stage: 'one referenced table finished',
    what: 'All 16 references into `service_items` carry the tenant. 16 of 271.',
    because:
      'Taken by *referenced* table rather than by referencing one, which is what makes a slice ' +
      'finishable: the unique index on the target is added once and every reference into it ' +
      'follows. It also gives the completeness this programme otherwise lacks — "no reference ' +
      'into the catalogue can point across tenants" is a sentence about the data, where "fourteen ' +
      'more are done" is a sentence about the backlog.',
  },
  {
    stage: 'ceiling measured',
    what: '268 of 271 cleanly convertible; three blocked by a nullable `company_id`.',
    because:
      'Phase 172 measured what ADR 0171 had guessed at, and the guess was wrong: the blocker is ' +
      'not references from unscoped tables — all 271 run between scoped tables — but nullable ' +
      '`company_id`, which under `MATCH SIMPLE` makes a composite key silently unenforced on the ' +
      'source side. `NULLABLE_TENANT_REFERENCES` names the three and what each would break.',
  },
  {
    stage: 'the rest',
    what: '255 references still proved by nothing stronger than the writer that happens to set them.',
    because:
      'Deliberately not done here. Each conversion needs a unique index on the target and a ' +
      'migration that cannot be mechanical — `CONVERSION_SHAPES` holds the three the catalogue ' +
      'slice met, and a self-reference and a reference from an unscoped table are both still ' +
      'unmet. Discovering that sixty tables in is worse than saying so now; the count is the ' +
      'backlog.',
  },
]
