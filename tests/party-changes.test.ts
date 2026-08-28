import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_FIELDS,
  VENDOR_FIELDS,
  deactivationCheck,
  describeChanges,
  diffParty,
} from '@/modules/parties/changes'

/**
 * What changes when you correct a record (Phase 45).
 *
 * The claim under test: **a partial form cannot destroy what it did not ask
 * about**. That is the commonest way an edit screen loses data, and it is the
 * reason `diffParty` takes a partial rather than a whole record.
 */

const customer = {
  name: 'Harborview LLC',
  email: 'ap@harborview.test',
  phone: '555 0100',
  addressLine1: '4 Mill Lane',
  city: 'Bristol',
  postalCode: 'BS1 4TT',
  paymentTermsDays: 30,
  notes: null,
}

const diff = (after: Record<string, unknown>, before = customer) =>
  diffParty({ fields: CUSTOMER_FIELDS, before, after })

describe('diffParty', () => {
  it('reports what actually changed', () => {
    const changes = diff({ email: 'accounts@harborview.test' })

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      key: 'email',
      label: 'Email',
      kind: 'description',
      from: 'ap@harborview.test',
      to: 'accounts@harborview.test',
    })
  })

  /**
   * The assertion the shape of this function exists for. A form that submits
   * three of twelve columns must not blank the other nine.
   */
  it('ignores every field the form did not ask about', () => {
    const changes = diff({ email: 'new@harborview.test' })

    expect(changes.map((change) => change.key)).toEqual(['email'])
    // Not "name changed to nothing", which is what a whole-record diff would
    // have said about every column the form omitted.
    expect(changes.some((change) => change.to === null)).toBe(false)
  })

  it('treats saving an untouched form as no change at all', () => {
    // Otherwise the audit log fills with noise and the one real change is
    // lost in it.
    expect(diff({ ...customer })).toEqual([])
    expect(diff({ name: 'Harborview LLC' })).toEqual([])
  })

  it('sees whitespace and empty strings as nothing, not as a value', () => {
    expect(diff({ notes: '   ' })).toEqual([])
    expect(diff({ phone: '' })[0]).toMatchObject({ from: '555 0100', to: null })
  })

  it('reports a field being cleared', () => {
    const changes = diff({ email: null })
    expect(changes[0]).toMatchObject({ from: 'ap@harborview.test', to: null })
  })

  it('reports a field being filled in for the first time', () => {
    const changes = diff({ addressLine2: 'Unit 3' })
    expect(changes[0]).toMatchObject({ key: 'addressLine2', from: null, to: 'Unit 3' })
  })

  it('reads a boolean the way a person would', () => {
    const changes = diffParty({
      fields: VENDOR_FIELDS,
      before: { is1099Vendor: false },
      after: { is1099Vendor: true },
    })

    expect(changes[0]).toMatchObject({ from: 'no', to: 'yes', kind: 'consequence' })
  })

  it('keeps the declared order, so a diff reads the same way twice', () => {
    const changes = diff({ paymentTermsDays: 45, name: 'Harborview Ltd', city: 'Bath' })
    expect(changes.map((change) => change.key)).toEqual(['name', 'city', 'paymentTermsDays'])
  })
})

describe('the three kinds of field', () => {
  /**
   * A name and an email say how to refer to somebody and how to reach them.
   * Correcting one corrects it everywhere, including on invoices already sent
   * — a document showing a stale spelling is showing something never true.
   */
  it('calls the ones that describe somebody descriptions', () => {
    const descriptions = CUSTOMER_FIELDS.filter((field) => field.kind === 'description')
    expect(descriptions.map((field) => field.key)).toContain('name')
    expect(descriptions.map((field) => field.key)).toContain('email')
    expect(descriptions.map((field) => field.key)).toContain('addressLine1')
  })

  /**
   * Payment terms decide the *next* document. The due date on an invoice
   * already raised is a fact somebody was told, and changing the default must
   * not move it.
   */
  it('calls payment terms a default, and says it is not retrospective', () => {
    const terms = CUSTOMER_FIELDS.find((field) => field.key === 'paymentTermsDays')
    expect(terms?.kind).toBe('default')
    expect(terms?.note).toContain('already raised')
  })

  /**
   * A tax ID is not a description of a vendor. It is a position taken for a
   * filing, and changing one after a year is reported restates that filing.
   */
  it('calls the 1099 fields consequences, and says what changing them does', () => {
    const taxId = VENDOR_FIELDS.find((field) => field.key === 'taxId')
    const reportable = VENDOR_FIELDS.find((field) => field.key === 'is1099Vendor')

    expect(taxId?.kind).toBe('consequence')
    expect(taxId?.note).toContain('1099')
    expect(reportable?.kind).toBe('consequence')
  })

  it('has a label for every field it will ever show somebody', () => {
    for (const field of [...CUSTOMER_FIELDS, ...VENDOR_FIELDS]) {
      expect(field.label).toBeTruthy()
      expect(field.label).not.toBe(field.key)
    }
  })

  /** A customer is not reportable on a 1099; only somebody you pay is. */
  it('does not offer a customer the vendor-only fields', () => {
    const keys = CUSTOMER_FIELDS.map((field) => field.key)
    expect(keys).not.toContain('taxId')
    expect(keys).not.toContain('is1099Vendor')
  })
})

describe('describeChanges', () => {
  it('names the fields rather than counting them', () => {
    expect(describeChanges(diff({ email: 'a@b.test' }))).toBe('Email updated.')
    expect(describeChanges(diff({ email: 'a@b.test', phone: '555 0200' }))).toBe(
      'Email and phone updated.',
    )
    expect(describeChanges(diff({ name: 'X', email: 'a@b.test', phone: '555 0200' }))).toBe(
      'Name, email and phone updated.',
    )
  })

  it('says nothing changed when nothing did', () => {
    expect(describeChanges([])).toBe('Nothing changed.')
  })

  /**
   * Somebody who has just changed a tax identification number needs to know
   * what that means before they close the page, not in April.
   */
  it('appends the warning when a consequence was changed', () => {
    const changes = diffParty({
      fields: VENDOR_FIELDS,
      before: { taxId: '00-0000000' },
      after: { taxId: '12-3456789' },
    })

    const sentence = describeChanges(changes)
    expect(sentence).toContain('Tax id updated.')
    expect(sentence).toContain('1099')
  })

  it('says nothing extra when only descriptions changed', () => {
    expect(describeChanges(diff({ phone: '555 0200' }))).toBe('Phone updated.')
  })
})

describe('deactivationCheck', () => {
  it('allows retiring somebody with nothing outstanding', () => {
    expect(deactivationCheck({ openDocuments: 0, balanceCents: 0 })).toEqual({ ok: true })
  })

  /**
   * A customer hidden from every picker while still owing money is a debt
   * nobody will chase. The books stay right and the business quietly stops
   * collecting, which is the worst kind of wrong.
   */
  it('refuses while money is outstanding, and says why', () => {
    const verdict = deactivationCheck({ openDocuments: 1, balanceCents: 120_000 })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toBe('money_outstanding')
    expect(verdict.ok === false && verdict.message).toContain('nobody is watching')
  })

  it('refuses while a document is still open, even at a zero balance', () => {
    const verdict = deactivationCheck({ openDocuments: 2, balanceCents: 0 })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toBe('open_documents')
    expect(verdict.ok === false && verdict.message).toContain('2 documents')
  })

  it('counts one document as one', () => {
    const verdict = deactivationCheck({ openDocuments: 1, balanceCents: 0 })
    expect(verdict.ok === false && verdict.message).toContain('1 document still open')
  })

  /** A credit balance is outstanding money too — we owe them. */
  it('refuses a negative balance as readily as a positive one', () => {
    expect(deactivationCheck({ openDocuments: 0, balanceCents: -5_000 }).ok).toBe(false)
  })
})
