/**
 * What changes when you correct a record (spec §6, §13, §19).
 *
 * ## The thing this module exists to decide
 *
 * A business can create a customer and never change one. Not the name, not the
 * email, not the terms. A typo in an address means that customer can never be
 * sent anything, for ever, and the only escape is a second customer record —
 * which splits their history, their aging and their statement in two.
 *
 * So editing has to exist. The interesting question is not *whether* but
 * **what a change means**, because the fields on a party record are three
 * different kinds of thing wearing one form:
 *
 * - A **description**. The name, the email, the address. These say how to
 *   refer to somebody and how to reach them. Correcting one corrects it
 *   everywhere it appears, including on invoices already sent — which is right,
 *   and is ADR 0042's live-record argument applied consistently: there is one
 *   customer, and a document showing a stale spelling of their name is showing
 *   something that was never true.
 *
 * - A **default**. Payment terms. It decides the due date of the *next*
 *   invoice and has no business touching one already raised, whose due date is
 *   a fact somebody was told. Changing it is not retrospective and the screen
 *   has to say so, or somebody will change the terms expecting the aging report
 *   to move.
 *
 * - A **consequence**. Whether a vendor is reportable, and their tax
 *   identification number. These are not descriptions of a party; they are
 *   positions taken for a tax filing, and changing one after a year has been
 *   reported restates something already sent to a tax authority. Allowed —
 *   corrections are exactly why it must be — but never silently.
 *
 * ## Why the audit trail here is not decoration
 *
 * Changing a vendor's payment details is the single commonest invoice-fraud
 * vector a small business meets: an email arrives saying "our bank has
 * changed", somebody updates the record, and the next payment run goes to a
 * stranger. Every field on this record is a thing an attacker would want to
 * change, so every change carries before and after into the audit log, and
 * that is the whole reason to prefer an update over a delete-and-recreate.
 *
 * Nothing here touches the database or the clock.
 */

/** What kind of thing a field is, which decides what changing it means. */
export type FieldKind =
  /** How to refer to somebody. Correcting it corrects it everywhere. */
  | 'description'
  /** Decides the next document. Never touches one already raised. */
  | 'default'
  /** A position taken for a filing. Changing it restates something. */
  | 'consequence'

export type PartyField = {
  key: string
  label: string
  kind: FieldKind
  /** Said out loud on the screen when this field is the one being changed. */
  note?: string
}

/**
 * Every field a person may change, and what changing it means.
 *
 * Named data rather than a switch statement, so the screen, the audit summary
 * and the tests all read the same list — and adding a column to the table is a
 * deliberate decision about which of the three kinds it is, rather than a
 * field that quietly appears with no answer to that question.
 */
export const CUSTOMER_FIELDS: PartyField[] = [
  { key: 'name', label: 'Name', kind: 'description' },
  {
    key: 'email',
    label: 'Email',
    kind: 'description',
    note: 'Invoices and reminders go here. Changing it changes where the next one goes.',
  },
  { key: 'phone', label: 'Phone', kind: 'description' },
  { key: 'addressLine1', label: 'Address', kind: 'description' },
  { key: 'addressLine2', label: 'Address line 2', kind: 'description' },
  { key: 'city', label: 'City', kind: 'description' },
  { key: 'region', label: 'County or state', kind: 'description' },
  { key: 'postalCode', label: 'Postcode', kind: 'description' },
  {
    key: 'paymentTermsDays',
    label: 'Payment terms',
    kind: 'default',
    note: 'Applies to the next invoice. Ones already raised keep the due date they were given.',
  },
  { key: 'notes', label: 'Notes', kind: 'description' },
]

export const VENDOR_FIELDS: PartyField[] = [
  { key: 'name', label: 'Name', kind: 'description' },
  { key: 'email', label: 'Email', kind: 'description' },
  { key: 'phone', label: 'Phone', kind: 'description' },
  { key: 'addressLine1', label: 'Address', kind: 'description' },
  { key: 'addressLine2', label: 'Address line 2', kind: 'description' },
  { key: 'city', label: 'City', kind: 'description' },
  { key: 'region', label: 'County or state', kind: 'description' },
  { key: 'postalCode', label: 'Postcode', kind: 'description' },
  {
    key: 'paymentTermsDays',
    label: 'Payment terms',
    kind: 'default',
    note: 'Applies to the next bill. Ones already entered keep the due date they were given.',
  },
  {
    key: 'taxId',
    label: 'Tax ID',
    kind: 'consequence',
    note: 'Appears on a 1099. Correcting it after a year has been filed restates that filing.',
  },
  {
    key: 'is1099Vendor',
    label: 'Reportable on a 1099',
    kind: 'consequence',
    note: 'Decides whether this vendor appears on the 1099 report at all.',
  },
  { key: 'notes', label: 'Notes', kind: 'description' },
]

export type FieldChange = {
  key: string
  label: string
  kind: FieldKind
  from: string | null
  to: string | null
  note?: string
}

/** How a value reads in an audit entry or on a screen. */
function display(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * What actually changed, in the order the fields are declared.
 *
 * Only fields present in `after` are considered, so a form that submits three
 * of twelve columns cannot blank the other nine — the commonest way an edit
 * screen destroys data, and the reason this takes a partial rather than a
 * whole record.
 *
 * A change to the same value is not a change. Somebody who opens a form and
 * saves it without typing should produce no audit entry at all, or the log
 * fills with noise and the one real change is lost in it.
 */
export function diffParty(input: {
  fields: PartyField[]
  before: Record<string, unknown>
  after: Record<string, unknown>
}): FieldChange[] {
  const changes: FieldChange[] = []

  for (const field of input.fields) {
    if (!(field.key in input.after)) continue

    const from = display(input.before[field.key])
    const to = display(input.after[field.key])
    if (from === to) continue

    changes.push({
      key: field.key,
      label: field.label,
      kind: field.kind,
      from,
      to,
      note: field.note,
    })
  }

  return changes
}

/**
 * One sentence describing a set of changes, for the notice after saving.
 *
 * Names the fields rather than counting them. "Email and payment terms
 * changed" is something somebody can check; "2 fields changed" is something
 * they have to go and look up.
 */
export function describeChanges(changes: FieldChange[]): string {
  if (changes.length === 0) return 'Nothing changed.'

  const labels = changes.map((change) => change.label.toLowerCase())
  const named =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`

  const sentence = `${named.charAt(0).toUpperCase()}${named.slice(1)} updated.`

  // The consequential ones get their warning appended, because a person who
  // has just changed a tax identification number needs to know what that
  // means before they close the page rather than in April.
  const consequences = changes.filter((change) => change.kind === 'consequence' && change.note)
  if (consequences.length === 0) return sentence

  return `${sentence} ${consequences.map((change) => change.note).join(' ')}`
}

/** What is in the way of retiring a party. */
export type DeactivationRefusal = 'open_documents' | 'money_outstanding'

export type DeactivationVerdict =
  | { ok: true }
  | { ok: false; reason: DeactivationRefusal; message: string }

/**
 * Whether a party can be made inactive.
 *
 * Deactivating is an **archive**, not a delete: the history stays, the aging
 * report is unchanged, and every document ever raised still names them. What
 * it stops is their appearing in a picker, which is the actual thing somebody
 * wants when they say "we do not work with them any more".
 *
 * Refused while there is open business, and the reason is not tidiness. A
 * customer hidden from every picker while still owing money is a debt nobody
 * will chase and an invoice nobody can find to apply a payment to — the books
 * stay right and the business quietly stops collecting.
 */
export function deactivationCheck(input: {
  openDocuments: number
  balanceCents: number
}): DeactivationVerdict {
  if (input.balanceCents !== 0) {
    return {
      ok: false,
      reason: 'money_outstanding',
      message:
        'There is still money outstanding. Settle it, write it off, or credit it first — ' +
        'hiding them would leave a balance nobody is watching.',
    }
  }

  if (input.openDocuments > 0) {
    return {
      ok: false,
      reason: 'open_documents',
      message:
        `${input.openDocuments} document${input.openDocuments === 1 ? '' : 's'} ` +
        'still open. Close them first.',
    }
  }

  return { ok: true }
}
