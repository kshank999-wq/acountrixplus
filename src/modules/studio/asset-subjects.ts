/**
 * What a creative asset can be about (Phase 180, spec §8).
 *
 * §8's last bullet: *"Assets can be associated with campaigns, contacts,
 * companies, opportunities, or client records."* ADR 0173 measured it as one of
 * eight capabilities with nothing behind them, and the measurement held —
 * `assets` carried provenance, storage and `derived_from_id`, and no column
 * naming any of the five.
 *
 * The question that absence makes unanswerable is the one a studio exists to
 * answer before it makes the next thing: **what have we sent this client.**
 *
 * ## Why this register is smaller than `EVIDENCE_SUBJECTS`
 *
 * `modules/evidence/subjects.ts` is the same device for the same kind of
 * problem, and it carries the table, the id column and the company column per
 * subject — because a polymorphic `subject_id` has no foreign key, so the
 * *code* has to prove the record exists and is the caller's.
 *
 * `asset_links` has five real composite foreign keys and a CHECK that exactly
 * one is set, so the database refuses a link to another company's campaign and
 * a link to a uuid that names nothing. This register therefore does not need to
 * know how to prove a record exists, and deliberately does not: a second copy
 * of that proof is a second thing to keep in step with a constraint that is
 * already doing the work.
 *
 * What is left is what the database cannot say — what to **call** each kind on
 * a screen, and who may read and change the association.
 *
 * ## Read and write are different permissions, for the reason evidence gives
 *
 * Someone who may look at a client record may not be the person who decides
 * which collateral belongs on it. The pairs here are narrower than they look:
 * every subject's `manage` is `marketing:manage`, because attaching a flyer to
 * a contact is a studio act wherever the contact lives — while `view` follows
 * the record, because a person who cannot see the opportunity has no business
 * seeing what was sent against it.
 */

import { RegistryError } from '@/modules/errors/registry'
import type { Permission } from '@/modules/permissions'

export type AssetSubjectKind =
  | 'campaign'
  | 'contact'
  | 'organization'
  | 'opportunity'
  | 'customer'

/** The column on `asset_links` that holds this kind of subject. */
export type AssetSubjectColumn =
  | 'campaignId'
  | 'contactId'
  | 'organizationId'
  | 'opportunityId'
  | 'customerId'

export type AssetSubject = {
  kind: AssetSubjectKind
  /** What a person sees: "Opportunity" rather than "opportunity". */
  label: string
  column: AssetSubjectColumn
  /** Seeing what has been associated with the record. */
  view: Permission
  /** Attaching and detaching. */
  manage: Permission
  /** The word §8 uses for it, so the mapping can be checked against the spec. */
  specWord: string
  /** Why this one is on the list, and what it is for. */
  because: string
}

/**
 * §8's five, in §8's order.
 *
 * The order is the specification's rather than alphabetical, so a reader with
 * the bullet open can check the list against it without re-sorting either.
 */
export const ASSET_SUBJECTS: readonly AssetSubject[] = [
  {
    kind: 'campaign',
    label: 'Campaign',
    column: 'campaignId',
    view: 'marketing:view',
    manage: 'marketing:manage',
    specWord: 'campaigns',
    because:
      'The association the design engine was built for: a campaign is a set of sends and the ' +
      'creative is what went out in them. Without it the only record that a flyer belonged to ' +
      'the spring push is the filename somebody typed, and `campaign_recipients` can say who was ' +
      'mailed while nothing says what they were mailed.',
  },
  {
    kind: 'contact',
    label: 'Contact',
    column: 'contactId',
    view: 'crm:view',
    manage: 'marketing:manage',
    specWord: 'contacts',
    because:
      'A person rather than the company they work for, and the distinction earns its place: a ' +
      'capability statement sent to one buyer at a large account is not a fact about the account. ' +
      'The commonest real use is the opposite of flattering — somebody asking "did we already ' +
      'send her this" before sending it again.',
  },
  {
    kind: 'organization',
    label: 'Organisation',
    column: 'organizationId',
    view: 'crm:view',
    manage: 'marketing:manage',
    specWord: 'companies',
    because:
      "§8's word is *companies*, which in this codebase is `organizations` — the CRM's record of " +
      'another business, which may never become a client. Distinct from `customers` below, and ' +
      'that is the pair §8 names separately rather than the same thing twice: a prospect and a ' +
      'client are different records here, and collateral is sent to both.',
  },
  {
    kind: 'opportunity',
    label: 'Opportunity',
    column: 'opportunityId',
    view: 'crm:view',
    manage: 'marketing:manage',
    specWord: 'opportunities',
    because:
      'The narrowest and most useful of the five: what was sent in pursuit of one deal. A won or ' +
      'lost opportunity with its collateral attached is the only way to ask which one-sheet ' +
      'actually travelled with the deals that closed — which §9 reports on by service and cannot ' +
      'report on by creative.',
  },
  {
    kind: 'customer',
    label: 'Client',
    column: 'customerId',
    view: 'crm:view',
    manage: 'marketing:manage',
    specWord: 'client records',
    because:
      "§8's *client records*, which is `customers` — the record that carries invoices and a " +
      'balance. Labelled "Client" and not "Customer" because the industry terminology layer ' +
      'renames it per trade and a studio screen saying "Customer" to a firm that says "client" ' +
      'is the small wrongness §2 exists to stop.',
  },
]

export function assetSubjectFor(kind: string): AssetSubject {
  const found = ASSET_SUBJECTS.find((subject) => subject.kind === kind)
  if (found) return found

  throw new RegistryError({
    registry: 'ASSET_SUBJECTS',
    key: kind,
    message:
      `No asset subject is declared as "${kind}". This register is §8's five associable records, ` +
      'and each entry names the `asset_links` column its kind is stored in — so a lookup ' +
      'answering `undefined` would write a link with no subject at all, which the table refuses ' +
      `and nothing above it would have explained. Declared: ${ASSET_SUBJECTS.map((s) => s.kind).join(', ')}.`,
  })
}

/** A subject, as a caller names one. */
export type AssetSubjectRef = { kind: AssetSubjectKind; id: string }

/**
 * The column assignment for one subject, with the other four left unset.
 *
 * The single place that turns a kind into a column, so no caller writes
 * `{ campaignId: ref.id }` by hand. The CHECK on the table refuses a row with
 * two subjects or none; this makes a row with two unreachable rather than
 * merely refused, which is the difference between a constraint catching a bug
 * and a constraint catching a bug somebody could have avoided writing.
 */
export function subjectAssignment(
  ref: AssetSubjectRef,
): Readonly<Record<AssetSubjectColumn, string | null>> {
  const subject = assetSubjectFor(ref.kind)

  return {
    campaignId: null,
    contactId: null,
    organizationId: null,
    opportunityId: null,
    customerId: null,
    [subject.column]: ref.id,
  }
}

/**
 * Which subject a stored row is about.
 *
 * The inverse of `subjectAssignment`, and it throws rather than returning null
 * for a row with no subject — because such a row cannot exist while the CHECK
 * does, so finding one means the constraint was dropped, and reporting that as
 * "this link has no subject" would describe the symptom while hiding the cause.
 */
export function subjectOf(row: Record<AssetSubjectColumn, string | null>): AssetSubjectRef {
  for (const subject of ASSET_SUBJECTS) {
    const id = row[subject.column]
    if (id) return { kind: subject.kind, id }
  }

  throw new RegistryError({
    registry: 'ASSET_SUBJECTS',
    key: '(none)',
    message:
      'An `asset_links` row names none of the five subjects. ' +
      '`asset_links_one_subject_check` makes that impossible, so this means the constraint is ' +
      'gone from the database rather than that the row is unusual — check the migrations before ' +
      'looking at the caller.',
  })
}

export function assetSubjectStands(subject: AssetSubject): string[] {
  const problems: string[] = []

  if (subject.because.length < 220) {
    problems.push(
      `${subject.kind} does not argue itself. The argument here is what question the association ` +
        'answers, because §8 names five records in one bullet and a register that only repeats ' +
        'the bullet tells a reader nothing about which of the five they want.',
    )
  }

  if (!subject.specWord) {
    problems.push(
      `${subject.kind} names no §8 word, so the mapping from the specification to this table ` +
        'cannot be checked against the specification.',
    )
  }

  return problems
}
