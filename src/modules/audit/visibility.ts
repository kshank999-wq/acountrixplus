import type { Permission } from '@/modules/permissions'

/**
 * What a reader of the audit log may be shown (spec §14, §19).
 *
 * ## The defect this exists to fix
 *
 * Phase 71 gave the audit log a reader without asking what was in it.
 *
 * Three modules had already, independently, decided that certain values must
 * never reach that table — reasoning about a reader who did not yet exist:
 *
 * - `payroll/service` records an employee without their rate: *"Never the
 *   rate: an audit log is read by more people than a payroll record should
 *   be."*
 * - `payroll/vendor-reporting` records **whether** a tax identifier was set
 *   rather than what it was, *"because recording what it was would put a tax
 *   number in a table read by everyone with `audit:view`."*
 *
 * Meanwhile other writers put exactly those kinds of value in freely, because
 * there was no reader to worry about. `payroll.post` carries the run's gross,
 * net and employer cost; `receivables/service` writes a supplier's tax
 * identifier verbatim on every edit that touches it.
 *
 * ## Why that matters more than it looks
 *
 * A **manager** holds `audit:view` and deliberately does **not** hold
 * `payroll:view` — Phase 9 says so out loud: *"the decision to show one
 * colleague another's pay is always deliberate."* Phase 71's activity screen
 * showed that manager every payroll event on the books. For a business with
 * three people on the payroll, a run's gross is a short step from one person's
 * pay, and the permission model had already decided they should not be taking
 * that step.
 *
 * ## The rule
 *
 * > **The log keeps everything. A reader is shown only what they may know.**
 *
 * Redaction belongs to the reader, not the writer. Scrubbing the writers would
 * lose facts an investigation needs and would do nothing about the rows already
 * written; deciding at the point of reading fixes both, and means a module
 * recording an event does not have to anticipate every future screen.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * The permission that opens a record, and therefore its history.
 *
 * Phase 71's rule — you may read the history of a record you may read — with
 * Phase 72's guarded domains folded into the same table rather than a second
 * one beside it. Two registries answering "who may see this entity type" is the
 * defect this codebase keeps removing.
 *
 * An entity type absent from here needs `audit:view`, which is the strict end:
 * a record type nobody has placed is readable by those who may read
 * everything, rather than by anybody with a session.
 */
const READABLE_BY: Record<string, Permission> = {
  bank_transaction: 'bookkeeping:view',
  categorization_rule: 'bookkeeping:view',

  invoice: 'accounting:view',
  bill: 'accounting:view',
  credit_note: 'accounting:view',
  payment: 'accounting:view',
  refund: 'accounting:view',
  deposit: 'accounting:view',
  vendor: 'accounting:view',
  customer: 'accounting:view',
  journal_entry: 'accounting:view',
  chart_account: 'accounting:view',
  financial_account: 'accounting:view',
  company: 'accounting:view',

  /**
   * Payroll is the one part of the books that is also somebody's private pay,
   * and `payroll:view` is not implied by any general accounting permission.
   * That has been true of the records since Phase 9; from Phase 72 it is true
   * of the log about them too.
   */
  payroll_run: 'payroll:view',
  employee: 'payroll:view',

  tax_code: 'tax:view',
  tax_filing: 'tax:view',
  tax_remittance: 'tax:view',
}

/** What somebody must hold to be shown events about this kind of record. */
export function permissionToRead(entityType: string): Permission {
  return READABLE_BY[entityType] ?? 'audit:view'
}

/**
 * The entity types this reader may not be shown, given what they hold.
 *
 * Handed to the feed as a `NOT IN`, so the filtering happens in the query
 * rather than after it. A `limit` applied before the filter returns a short
 * page of what somebody may see rather than a full one, and a short page reads
 * as "not much happened" — which is a lie told by omission.
 *
 * Only the *named* types can be withheld. Anything falling through to
 * `audit:view` is already covered by the gate on the feed itself, and listing
 * every unnamed type here is impossible anyway — the log takes an entity type
 * as a string.
 */
export function withheldEntityTypes(holds: (permission: Permission) => boolean): string[] {
  return Object.entries(READABLE_BY)
    .filter(([, permission]) => !holds(permission))
    .map(([entityType]) => entityType)
}

/**
 * Values the log may keep and a screen may never print.
 *
 * `vendor-reporting` reached this conclusion for a tax identifier in Phase 68
 * and `receivables/service` never heard about it, so the same question had two
 * answers — one careful, one not. Settled here, at the reader, which also
 * covers every row already written before anybody noticed.
 *
 * The fact worth auditing is that the identifier **changed**, not what it
 * changed to. Somebody investigating a 1099 needs to know a number was
 * replaced on the 3rd and by whom; they do not need the number, and putting it
 * on a screen is how it ends up somewhere it should never have been.
 */
const NEVER_SHOWN = new Set(['taxId', 'taxIdentifier', 'nationalInsuranceNumber', 'ssn'])

export function isSecret(key: string): boolean {
  return NEVER_SHOWN.has(key)
}

/**
 * What a secret value reads as instead of itself.
 *
 * "set" and "nothing" rather than a row of asterisks: a mask that mimics the
 * shape of the value tells somebody how long it was, and a reader who sees
 * `••••` reasonably assumes the real thing is a click away.
 */
export function maskSecret(value: string | null): string | null {
  return value === null ? null : 'set'
}
