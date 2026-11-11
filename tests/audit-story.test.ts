import { describe, expect, it } from 'vitest'
import {
  changedFields,
  humanise,
  nameOf,
  namedActions,
  reasonFrom,
  tell,
} from '@/modules/audit/story'
import { everyCorrection } from '@/modules/corrections/vocabulary'

/**
 * Reading an audit row (Phase 71).
 *
 * Pure. No database, no clock.
 */

describe('what to call what happened', () => {
  it('uses the words Phase 70 already decided for a correction', () => {
    expect(nameOf('payment.void')).toEqual({ label: 'Payment voided', named: true })
    expect(nameOf('bill.approval_withdraw')).toEqual({
      label: 'Approval withdrawn',
      named: true,
    })
  })

  /**
   * The point of reading them from the vocabulary rather than writing them a
   * second time here. If somebody renames a verb on a button, the history
   * follows — otherwise Phase 70's defect comes straight back as two answers
   * to one question, one on the screen and one in the log.
   */
  it('takes every correction phrase from the vocabulary, not from itself', () => {
    const fromVocabulary = everyCorrection().map((row) => row.done)

    const fromHistory = [
      'payment.void',
      'refund.void',
      'invoice.void',
      'deposit.void',
      'bill.approval_withdraw',
    ].map((action) => nameOf(action).label)

    for (const label of fromHistory) {
      expect(fromVocabulary).toContain(label)
    }
  })

  it('calls cancelling an invoice and cancelling a bill the same thing', () => {
    expect(nameOf('invoice.void').label).toBe(nameOf('bill.void').label)
  })

  /**
   * The refusal that shapes this module. `AuditAction` has **257 members** as
   * of Phase 208 and words have been decided for **seven** of them; the other
   * 250 are handed back as their own names, flagged so the screen can show
   * them as the codes they are.
   *
   * **This sentence said 224 and five until Phase 208 measured it**, which is
   * Phase 179's shape found in a test rather than in a document: a number in
   * prose that nothing reads goes stale while the claim around it stays true,
   * and 33 actions had been added without it moving. The denominator is still
   * prose, because `AuditAction` is a type and counting its members means
   * parsing the source; the *numerator* is asserted below, so the half that
   * can drift silently no longer can.
   */
  it('does not invent a sentence for an action nobody has named', () => {
    expect(nameOf('journal.reclassify')).toEqual({ label: 'journal.reclassify', named: false })
    expect(nameOf('vendor.update').named).toBe(false)
    // Phase 208's own two, which are a link rather than a correction and so
    // are deliberately among the unnamed.
    expect(nameOf('vendor.link_organization').named).toBe(false)
  })

  /**
   * The seven, listed — so adding a mapping without saying so goes red.
   *
   * Phase 97 found the opposite failure: `party.merge` had a correction phrase
   * from Phase 96 and no mapping here, so the one screen that would explain a
   * merge printed the raw string as a code. A list is how both directions are
   * caught by the same assertion.
   */
  it('names exactly seven of them', () => {
    const named = [
      'payment.void',
      'refund.void',
      'invoice.void',
      'bill.void',
      'deposit.void',
      'bill.approval_withdraw',
      'party.merge',
    ]

    for (const action of named) {
      expect(nameOf(action).named, action).toBe(true)
    }

    expect(
      namedActions().sort(),
      'a mapping was added or removed without moving the count in the docstring above',
    ).toEqual([...named].sort())
  })
})

describe('what changed', () => {
  it('reports a field that moved', () => {
    const changes = changedFields({ email: 'old@example.com' }, { email: 'new@example.com' })

    expect(changes).toEqual([
      { key: 'email', label: 'Email', kind: 'plain', from: 'old@example.com', to: 'new@example.com' },
    ])
  })

  it('says nothing about a field that stayed the same', () => {
    expect(changedFields({ name: 'Harborview', email: 'a@b.test' }, { name: 'Harborview', email: 'c@d.test' })).toHaveLength(1)
  })

  /** Creating something has no before, and its fields are still worth reading. */
  it('reads an event that only has an after', () => {
    const changes = changedFields(null, { number: 'BILL-1001', totalCents: 100_000 })

    expect(changes.map((change) => change.key)).toEqual(['number', 'totalCents'])
    expect(changes[0].from).toBeNull()
  })

  /**
   * A cleared field is the case somebody is most often looking for — a bank
   * detail or a tax ID that went from something to nothing.
   */
  it('keeps a field that was emptied', () => {
    const changes = changedFields({ email: 'accounts@harborview.test' }, { email: null })

    expect(changes).toEqual([
      { key: 'email', label: 'Email', kind: 'plain', from: 'accounts@harborview.test', to: null },
    ])
  })

  /**
   * A tax identifier is one the log may keep and a screen may never print
   * (Phase 72). That it was cleared is the auditable fact; what it was is not.
   */
  it('redacts a value that must not be shown, on both sides', () => {
    expect(changedFields({ taxId: '12-3456789' }, { taxId: null })).toEqual([
      { key: 'taxId', label: 'Tax ID', kind: 'secret', from: 'set', to: null },
    ])

    expect(changedFields({ taxId: '12-3456789' }, { taxId: '98-7654321' })).toEqual([
      { key: 'taxId', label: 'Tax ID', kind: 'secret', from: 'set', to: 'set' },
    ])
  })

  it('keeps a key that only the before had', () => {
    const changes = changedFields({ approvedBy: 'user-1' }, { withdrawn: true })

    expect(changes.map((change) => change.key)).toEqual(['withdrawn', 'approvedBy'])
  })

  it('marks money as money rather than formatting it', () => {
    const [change] = changedFields({ thresholdCents: 0 }, { thresholdCents: 50_000 })

    expect(change).toEqual({
      key: 'thresholdCents',
      label: 'Approval threshold',
      kind: 'money',
      from: '0',
      to: '50000',
    })
  })

  it('reads a boolean as a person would say it', () => {
    const [change] = changedFields({ twoPersonRule: false }, { twoPersonRule: true })

    expect(change.label).toBe('Second pair of eyes')
    expect([change.from, change.to]).toEqual(['no', 'yes'])
  })

  /** `[object Object]` looks like a value, which is worse than an omission. */
  it('skips a nested structure rather than printing it as one', () => {
    expect(changedFields(null, { lines: [{ amountCents: 1 }], number: 'INV-1' })).toEqual([
      { key: 'number', label: 'Number', kind: 'plain', from: null, to: 'INV-1' },
    ])
  })

  it('treats an absent payload on both sides as nothing to say', () => {
    expect(changedFields(null, null)).toEqual([])
    expect(changedFields(undefined, undefined)).toEqual([])
  })
})

describe('naming a field', () => {
  it('un-camel-cases a key rather than inventing a word for it', () => {
    expect(humanise('balanceCents')).toBe('Balance')
    expect(humanise('remittanceSentAt')).toBe('Remittance sent at')
    expect(humanise('vendor_reference')).toBe('Vendor reference')
  })

  it('names the ones worth deciding', () => {
    const [change] = changedFields({ is1099Vendor: false }, { is1099Vendor: true })
    expect(change.label).toBe('Reportable on a 1099')
  })
})

describe('why', () => {
  it('finds the reason Phase 70 asked for', () => {
    expect(reasonFrom({ status: 'void', reason: 'Keyed at ten times the amount' })).toBe(
      'Keyed at ten times the amount',
    )
  })

  it('reads a correction that needed no reason as having none', () => {
    expect(reasonFrom({ approvedBy: null, reason: null })).toBeNull()
    expect(reasonFrom({ approvedBy: null })).toBeNull()
    expect(reasonFrom(null)).toBeNull()
  })

  it('does not count a box somebody typed spaces into', () => {
    expect(reasonFrom({ reason: '   ' })).toBeNull()
  })

  /**
   * The reason is the answer to "why", not a field that changed. Shown as a
   * change it would sit in a list of six other rows and be the one nobody
   * reads — which is the whole thing somebody opened the history for.
   */
  it('keeps the reason out of the list of changes', () => {
    const told = tell({
      action: 'payment.void',
      after: { status: 'void', reason: 'Paid the wrong supplier' },
    })

    expect(told.reason).toBe('Paid the wrong supplier')
    expect(told.changes.map((change) => change.key)).toEqual(['status'])
  })
})

describe('one row, told', () => {
  it('puts the phrase, the changes and the reason together', () => {
    expect(
      tell({
        action: 'bill.approval_withdraw',
        before: { approvedBy: 'user-1' },
        after: { approvedBy: null, reason: 'Wrong cost code' },
      }),
    ).toEqual({
      action: 'bill.approval_withdraw',
      label: 'Approval withdrawn',
      named: true,
      reason: 'Wrong cost code',
      // Null here, and that is the point: only an event that wrote a sentence
      // about itself carries one (Phase 97). Withdrawing an approval does not.
      summary: null,
      changes: [
        { key: 'approvedBy', label: 'Approved by', kind: 'plain', from: 'user-1', to: null },
      ],
    })
  })

  it('tells an unnamed action as its own name plus its diff', () => {
    const told = tell({
      action: 'vendor.update',
      before: { email: 'accounts@harborview.test' },
      after: { email: 'payments@harborv1ew.test' },
    })

    expect(told.named).toBe(false)
    expect(told.label).toBe('vendor.update')
    expect(told.changes).toHaveLength(1)
    expect(told.reason).toBeNull()
  })
})
