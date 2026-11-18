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
 * The permissions that open a record, and therefore its history.
 *
 * Phase 71's rule — you may read the history of a record you may read — with
 * Phase 72's guarded domains folded into the same table rather than a second
 * one beside it. Two registries answering "who may see this entity type" is the
 * defect this codebase keeps removing.
 *
 * An entity type absent from here needs `audit:view`, which is the strict end:
 * a record type nobody has placed is readable by those who may read
 * everything, rather than by anybody with a session.
 *
 * ## Why an entry holds a list (Phase 213)
 *
 * It held one permission until Phase 213, and the rule it implements has always
 * been *"the history of a record you may read"* — so a record that can be
 * opened **two ways** was mis-stated the moment it was placed. One permission
 * had to be picked and the other set of readers went blind.
 *
 * Measured, that is not hypothetical and it is not fixable by choosing better:
 *
 * - A **customer** is reached through the books by an accountant (`accounting:
 *   view`) and through the CRM by a salesperson (`crm:view`). `createCustomer`
 *   is gated on `crm:manage`, so the people who create customers are exactly
 *   the ones the old single entry shut out. Either choice blinded somebody who
 *   may open the record.
 * - A **proposal** is a contract, and `billStage` raises an invoice from one
 *   under `accounting:journal` — an accountant's act, filed under a type only
 *   the CRM could read.
 *
 * A reader is shown the type if they hold **any** of the listed permissions,
 * which is what "a record you may read" means when a record has two doors. The
 * first in the list is the primary — what a refusal names, and what
 * `permissionToRead` returns for the callers that want one.
 *
 * ## The other half, which has to be measured per entry
 *
 * `withheldEntityTypes` is a `NOT IN` handed to the feed, so **placing a type
 * narrows as well as widens**: a type nobody has placed is visible to every
 * holder of `audit:view` (owner, manager, accountant), and placing it hands it
 * to the people who may read that kind of record instead. Five of Phase 213's
 * placements take something away, and each is deliberate — the same argument
 * Phase 72 made about a manager and the payroll: showing somebody the history
 * of records they may not open is not a courtesy, it is the leak.
 */
const READABLE_BY: Record<string, readonly Permission[]> = {
  bank_transaction: ['bookkeeping:view'],
  categorization_rule: ['bookkeeping:view'],

  /**
   * Added in Phase 213, both on the same measurement: a **bookkeeper** holds
   * `bookkeeping:import` and not `audit:view`, so the person who connects a
   * bank or commits an import could not read the record of doing it — and an
   * import is the act most likely to need re-reading, because what it did is
   * hundreds of rows and the event is the only summary of them.
   *
   * Nobody loses: every `audit:view` holder also holds `bookkeeping:view`.
   */
  bank_connection: ['bookkeeping:view'],
  import_run: ['bookkeeping:view'],

  invoice: ['accounting:view'],
  bill: ['accounting:view'],
  credit_note: ['accounting:view'],
  payment: ['accounting:view'],
  refund: ['accounting:view'],
  deposit: ['accounting:view'],

  /**
   * The customer entry's twin, and it took until Phase 217 to notice (Phase 72,
   * Phase 78).
   *
   * Phase 72 gave `customer` a second permission because `createCustomer` is
   * gated on `crm:manage` — held by `manager` and `sales`, neither of whom holds
   * `accounting:view` — so the two roles that create customers were the two that
   * could not read what they had done. `vendor` was left with one permission and
   * looked consistent, because `createVendor` was gated on `accounting:view`.
   *
   * It was not consistent; it was **wrong twice in a way that cancelled out**.
   * `createVendor`'s own comment says "As on the customer side. See
   * `createCustomer`", and Phase 217 made the gate match that claim. The moment
   * it did, `blindProducers()` named `manager` and `sales` on `entityType:
   * 'vendor'` — the identical finding Phase 72 fixed on the customer side, held
   * off for five phases by a gate that was too weak to trigger it.
   *
   * Phase 121's device earning its keep: the falsifier was seen to disagree, and
   * it disagreed about a change that looked purely like a tightening.
   */
  vendor: ['accounting:view', 'crm:view'],

  journal_entry: ['accounting:view'],
  chart_account: ['accounting:view'],
  financial_account: ['accounting:view'],
  company: ['accounting:view'],

  /**
   * The first entry to need two, and the one that forced the shape (Phase 213).
   *
   * `accounting:view` since Phase 72, because a customer is a receivables
   * record. But `createCustomer` and `updateCustomer` are gated on `crm:manage`
   * — held by `manager` and `sales`, neither of whom holds `accounting:view`.
   * The two roles that create and correct customers were the two that could not
   * read what they had done.
   */
  customer: ['accounting:view', 'crm:view'],

  /**
   * Placed in Phase 213, and both **take something away from a manager**, who
   * holds `audit:view` and deliberately not `accounting:view`.
   *
   * That is the intended direction. A statement is a customer's balance and a
   * pay run is what is about to leave the bank; a manager may not open either,
   * and the feed was handing them the history of both. Phase 72 made this exact
   * argument about payroll — *"the permission that guards a record guards the
   * events about it too"* — and this is the same sentence applied to the two
   * acts a `bookkeeper` performs and could not read back.
   */
  customer_statement: ['accounting:view'],
  pay_run: ['accounting:view'],

  /**
   * Payroll is the one part of the books that is also somebody's private pay,
   * and `payroll:view` is not implied by any general accounting permission.
   * That has been true of the records since Phase 9; from Phase 72 it is true
   * of the log about them too.
   */
  payroll_run: ['payroll:view'],
  employee: ['payroll:view'],

  tax_code: ['tax:view'],
  tax_filing: ['tax:view'],
  tax_remittance: ['tax:view'],

  /**
   * Reconciliation, placed in Phase 213.
   *
   * `reconciliation:perform` is held by `bookkeeper` and `audit:view` is not,
   * so the person who reconciles an account could not read the history of the
   * reconciliation — including the one event that matters, a completed period
   * being reopened. Nobody loses: every `audit:view` holder holds
   * `reconciliation:view`.
   */
  reconciliation: ['reconciliation:view'],

  /**
   * What the assistant was asked and what it answered, placed in Phase 213.
   *
   * `ai:use` is the widest permission in the system — every role but `readonly`
   * holds it — and `audit:view` is one of the narrowest, so three roles could
   * put a question to the assistant and never see the record of it.
   */
  ai_suggestion: ['ai:use'],

  /**
   * The CRM, placed in Phase 78.
   *
   * These six types have written audit events since Phase 3 and none of them
   * were ever listed, so every one fell through to `audit:view` — which the
   * `sales` role does not hold. A salesperson could move an opportunity through
   * the pipeline, send a proposal and correct a client, and then read the
   * history of none of it.
   *
   * Noticed while giving `organization.update` a writer: an audit entry the
   * person who made the correction cannot see is not much of an audit trail.
   */
  /**
   * A job, placed in Phase 212 for the same reason the six above were placed in
   * Phase 78, and measured rather than assumed.
   *
   * Phase 212 gave `projects.status` its first writer, so a job has a history
   * for the first time. Unplaced, that history would need `audit:view` — which
   * **`bookkeeper` does not hold**, while holding both `jobs:view` and
   * `jobs:manage`. The person who closed the job could not read the record of
   * closing it, which is Phase 78's sentence arriving at a different module:
   * *"an audit entry the person who made the correction cannot see is not much
   * of an audit trail."*
   *
   * Placing it takes nothing from anybody, which is the half worth measuring:
   * every role holding `audit:view` (owner, manager, accountant) also holds
   * `jobs:view`, so no reader loses a type they could see. `sales` gains the
   * history of the job it has been able to open since Phase 3.
   *
   * The other six job-costing types — `cost_code`, `change_order`, `sov`,
   * `progress_billing`, `subcontractor`, `compliance_document` — write audit
   * events and are still unplaced. That is the same finding and it is not this
   * phase's; ADR 0212 nominates it rather than this entry quietly fixing one
   * seventh of it.
   *
   * **Phase 213 measured that nomination and it was wrong three ways.** `sov`
   * writes no audit events at all. `progress_billing` has no blind producer —
   * its one act is gated on `accounting:journal`, which only `audit:view`
   * holders have. And the list missed `project`, which was a **second name for
   * this very table**: `budget.set` and `sov.set` both file under it, carrying
   * `projects.id`, so the sentence above — a job has a history for the first
   * time — was true of one of three acts, and not the two about money. Phase
   * 213 folds that name into this one and migrates the rows already written.
   */
  job: ['jobs:view'],

  /**
   * The rest of job costing, placed in Phase 213 on `job`'s own measurement
   * rather than on the family resemblance that nominated them.
   *
   * Every one is gated on `jobs:manage`, which `bookkeeper` holds while holding
   * no `audit:view` — so the role that codes costs, raises change orders and
   * files a subcontractor's insurance certificate could read the history of
   * none of it. `vehicle` and `repair_order` are the two the nomination never
   * mentioned, and they are the same defect in a different module.
   *
   * Nobody loses: every `audit:view` holder also holds `jobs:view`, and `sales`
   * and `readonly` gain the history of records they could already open.
   */
  cost_code: ['jobs:view'],
  change_order: ['jobs:view'],
  subcontractor: ['jobs:view'],
  compliance_document: ['jobs:view'],
  vehicle: ['jobs:view'],
  repair_order: ['jobs:view'],

  organization: ['crm:view'],
  opportunity: ['crm:view'],
  design_document: ['crm:view'],
  document_template: ['crm:view'],
  lead_intake_key: ['crm:view'],

  /**
   * A proposal reads two ways (Phase 213).
   *
   * `crm:view` since Phase 78, so a salesperson can read the contract they
   * sent — and that is still the primary. But `billStage` raises an invoice
   * from a proposal's schedule under `accounting:journal`, and the accountant
   * who does it was filing `proposal.stage_billed` into a type they could not
   * read. The money half of a contract belongs to whoever may read the books.
   */
  proposal: ['crm:view', 'accounting:view'],

  /**
   * The two CRM acts Phase 78 missed, placed in Phase 213 for its reason.
   *
   * Both are gated on `crm:manage` and `sales` holds it without `audit:view`,
   * which is the sentence Phase 78 wrote: answering a client's question and
   * completing a task are a salesperson's work, and the record of them was
   * readable by everyone except the salesperson.
   *
   * These take the type from `accountant`, who holds `audit:view` and no
   * `crm:view`. Deliberate, and the same trade Phase 78 made for the other six.
   */
  communication: ['crm:view'],
  task: ['crm:view'],

  /**
   * Marketing, placed in Phase 213 — a family nothing had ever placed.
   *
   * `marketing:manage` gates all three and the `marketing` role holds no
   * `audit:view`, so the only person whose job this is was the only person who
   * could not read it. A suppression is the sharpest case: it is the record of
   * somebody being removed from a mailing list, which is precisely the thing a
   * marketer is later asked to account for.
   *
   * These take the three types from `accountant`. Deliberate: campaign history
   * is not part of the books.
   */
  campaign: ['marketing:view'],
  segment: ['marketing:view'],
  suppression: ['marketing:view'],

  /**
   * The asset, placed in Phase 214 — and placed because a scan finally saw it.
   *
   * Phase 213 missed this one for a reason worth keeping. It read a site's gates
   * by matching `requirePermission(ctx, '<literal>')`, and `linkAsset` and
   * `unlinkAsset` gate on `subject.manage` and
   * `assetSubjectFor(ref.kind).manage` — the permission is **computed from the
   * subject's own kind**, so the scan saw no gate, concluded the act named no
   * producer, and skipped it. The code was never unguarded; the scan could not
   * read the guard.
   *
   * What that hid: all five entries in `ASSET_SUBJECTS` declare
   * `manage: 'marketing:manage'`, so the roles that may associate and detach
   * assets are `owner`, `manager` and `marketing` — and `asset` was in no entry
   * here, so its history needed `audit:view`, which `marketing` does not hold.
   * **A marketer could attach an asset to a campaign, detach it again, and read
   * the history of neither.** Phase 78's sentence, found a third time, by the
   * third different method.
   *
   * `marketing:view` rather than `crm:view`, even though four of the five
   * subjects are CRM records: the act is gated on marketing and the permission
   * that guards a record guards the events about it too (Phase 72). This takes
   * asset history from `accountant`, as the three above do, and for the same
   * reason — which association a campaign used is not part of the books.
   */
  asset: ['marketing:view'],
}

/**
 * Every permission that opens this kind of record's history — any one will do.
 *
 * Empty-handed types answer `['audit:view']` rather than `[]`, so a caller
 * never has to special-case the fall-through.
 */
export function permissionsToRead(entityType: string): readonly Permission[] {
  return READABLE_BY[entityType] ?? ['audit:view']
}

/**
 * The primary permission for this kind of record: what a refusal names.
 *
 * Phase 47 — a refusal must name something actionable — so where a record has
 * two doors this names the one the type is chiefly about, rather than listing
 * both at somebody who holds neither.
 */
export function permissionToRead(entityType: string): Permission {
  return permissionsToRead(entityType)[0]
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
 *
 * A type is withheld when the reader holds **none** of its permissions (Phase
 * 213): a record with two doors is open to whoever has either key.
 */
export function withheldEntityTypes(holds: (permission: Permission) => boolean): string[] {
  return Object.entries(READABLE_BY)
    .filter(([, permissions]) => !permissions.some(holds))
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
