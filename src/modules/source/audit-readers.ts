import { readFileSync } from 'node:fs'
import {
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@/modules/permissions'
import { permissionsToRead } from '@/modules/audit/visibility'
import { enclosingSpan, enclosingSymbol, withoutComments } from './enclosing'
import { sourceFiles } from './isolation-scan'

/**
 * Can the person who caused an audit event read it? (spec §14, §19.)
 *
 * ## The question the register was never asked
 *
 * `READABLE_BY` answers *"who may be shown events about this kind of record"*,
 * on Phase 71's rule — **you may read the history of a record you may read** —
 * and an entity type absent from it falls through to `audit:view`, which the
 * register's own prose calls "the strict end".
 *
 * Phase 78 found that the strict end is not always the safe end. Six CRM types
 * had written audit events since Phase 3 and none was listed, so every one
 * needed `audit:view`, which `sales` does not hold: a salesperson could move an
 * opportunity, send a proposal and correct a client, and read the history of
 * none of it. The sentence that phase left behind is the rule this file
 * measures: *an audit entry the person who made the correction cannot see is
 * not much of an audit trail.*
 *
 * Phase 212 found the seventh, in a different module, and placed it. ADR 0212
 * then nominated "the other six job-costing types" for Phase 213 — and that
 * nomination is what this scan was built to check, because **it was wrong three
 * ways**, each of which only a measurement could have shown:
 *
 * - `sov` writes no audit events at all. The schedule-of-values act files its
 *   event under `project`.
 * - `project` is a **second name for the table `job` was placed under**. Both
 *   carry `projects.id` as the entity id. So Phase 212's placement, whose prose
 *   says a job "has a history for the first time", reached one of the three
 *   acts that write that history — and not the two that are about money.
 * - Six was not the number. Measured across every write site in `src/`, **20**
 *   entity types have a role that can produce an event it can never read.
 *
 * A nomination inherited is a nomination unmeasured (Phase 164), and this is
 * the fourth phase in a row where measuring it first changed the subject.
 *
 * ## Why the property is not a quota
 *
 * 94 entity types are written and 26 were placed, so the obvious reading is
 * that 68 are missing and the fix is to place them. That is ADR 0134's shape —
 * a number to drive to zero teaches nobody anything, and most of the 68 are
 * correctly silent: `user`, `device` and `push_subscription` are written by
 * paths with no permission gate at all, so there is no role that produces them
 * and no role that is blinded.
 *
 * The property asserted instead is **no role produces an event it cannot
 * read**. An ungated site contributes no producers, so correct silence passes
 * untouched; a type only has to be placed when somebody is actually being shut
 * out of their own work. That is a statement about the books rather than about
 * the register's length, and it stays true as types are added.
 *
 * ## How a site's permission is read, and the scan that got it wrong
 *
 * The first version of this scan took the **nearest preceding**
 * `requirePermission` — one permission, the last one before the write. It
 * reported 21 findings where there are 20, and the false one is worth keeping
 * on the record because it is not a parsing slip but a reading of the
 * permission model that is simply wrong.
 *
 * `parties/service.ts:setVendorOrganization` requires **two** permissions:
 *
 *     requirePermission(ctx, 'accounting:journal')
 *     requirePermission(ctx, 'crm:view')
 *
 * Sequential calls are a conjunction — both must pass — so the roles that can
 * perform the act are those holding *both*, which is `owner` and nobody else.
 * Reading only the last one made it look like a `crm:view` act, and `crm:view`
 * is held by four more roles, none of whom can actually reach the code. The
 * scan then reported a `vendor` finding for a defect that cannot occur.
 *
 * So a site's gates are **every** `requirePermission` inside the enclosing
 * top-level function, and a role produces the event only if it holds all of
 * them. Taking the enclosing function rather than a window of lines is the
 * other half, and it is ADR 0134's: a fixed window "leaked past a function
 * boundary and excused a real defect", which is why `enclosingSpan` exists and
 * why this scan uses it instead of counting backwards.
 *
 * Nothing here touches the database or the clock.
 */

/** One `recordAudit` call, with what the function around it demands. */
export type AuditWriteSite = {
  /** Repository-relative path, as the scan found it. */
  file: string
  /** The top-level function the call sits in, or `(top level)`. */
  symbol: string
  entityType: string
  /**
   * Every permission the enclosing function requires, in source order. Empty
   * when the act is reached without a permission check — a public token, a
   * background sweep, or a path gated somewhere other than here.
   */
  gates: readonly Permission[]
}

/** A role that can cause an event and can never be shown it. */
export type BlindProducer = {
  entityType: string
  role: Role
  /** What this role had to hold to produce it. */
  held: readonly Permission[]
  /** What being shown it would need — any one of these. */
  needs: readonly Permission[]
}

const WRITE = /entityType: '([a-z_]+)'/g
const GATE = /requirePermission\(\s*\w+\s*,\s*'([a-z_]+:[a-z_]+)'/g

/** Every place in `src/` that files an audit event under a literal type. */
export function auditWriteSites(): AuditWriteSite[] {
  const sites: AuditWriteSite[] = []

  for (const file of sourceFiles('src')) {
    const raw = readFileSync(file, 'utf8')
    // Comments are blanked so a type named in prose is not counted as a write,
    // and offsets are preserved so the spans below still line up with `raw`.
    const src = withoutComments(raw)

    for (const match of src.matchAll(WRITE)) {
      const span = enclosingSpan(raw, match.index)
      const body = src.slice(span.from, span.to)

      sites.push({
        file,
        symbol: enclosingSymbol(raw, match.index),
        entityType: match[1],
        gates: [...body.matchAll(GATE)].map((gate) => gate[1] as Permission),
      })
    }
  }

  return sites
}

function holds(role: Role, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)
}

/**
 * Every role that can write an audit event it will never be shown.
 *
 * One row per (type, role) rather than per site: the defect is about a person,
 * and naming the six acts a bookkeeper performs on a cost code would say the
 * same thing six times. The site's gates are kept so a reader can check the
 * claim without re-running the scan.
 */
export function blindProducers(sites = auditWriteSites()): BlindProducer[] {
  const found = new Map<string, BlindProducer>()

  for (const site of sites) {
    // An ungated act has no producing role, so it blinds nobody. This is the
    // line that keeps the property from being a count of unplaced types.
    if (site.gates.length === 0) continue

    const needs = permissionsToRead(site.entityType)

    for (const role of ROLE_NAMES) {
      if (!site.gates.every((gate) => holds(role, gate))) continue
      if (needs.some((permission) => holds(role, permission))) continue

      const key = `${site.entityType}:${role}`
      if (!found.has(key)) {
        found.set(key, { entityType: site.entityType, role, held: site.gates, needs })
      }
    }
  }

  return [...found.values()].sort((a, b) =>
    a.entityType === b.entityType
      ? a.role.localeCompare(b.role)
      : a.entityType.localeCompare(b.entityType),
  )
}

/** Every distinct entity type written anywhere in `src/`. */
export function writtenEntityTypes(sites = auditWriteSites()): string[] {
  return [...new Set(sites.map((site) => site.entityType))].sort()
}
