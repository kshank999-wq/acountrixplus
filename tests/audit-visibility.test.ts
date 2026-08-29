import { describe, expect, it } from 'vitest'
import { isSecret, maskSecret, permissionToRead } from '@/modules/audit/visibility'

/**
 * What a reader of the audit log may be shown (Phase 72).
 *
 * Pure. No database, no clock.
 */

describe('who may be shown events about what', () => {
  it('asks for the permission that opens the record', () => {
    expect(permissionToRead('bank_transaction')).toBe('bookkeeping:view')
    expect(permissionToRead('vendor')).toBe('accounting:view')
  })

  /**
   * The defect Phase 72 exists to fix. A manager holds `audit:view` and
   * deliberately not `payroll:view` — Phase 9 says so out loud — and Phase 71's
   * activity screen showed them every payroll event on the books.
   */
  it('guards payroll behind the permission that guards payroll', () => {
    expect(permissionToRead('payroll_run')).toBe('payroll:view')
    expect(permissionToRead('employee')).toBe('payroll:view')
  })

  it('guards the tax records behind the tax permission', () => {
    expect(permissionToRead('tax_filing')).toBe('tax:view')
    expect(permissionToRead('tax_remittance')).toBe('tax:view')
  })

  /**
   * The strict end, so that a record type nobody has classified is readable by
   * those who may read everything rather than by anybody with a session.
   */
  it('falls back to the strict permission for a type nobody has placed', () => {
    expect(permissionToRead('something_nobody_has_classified')).toBe('audit:view')
  })
})

describe('values the log keeps and a screen never prints', () => {
  it('knows a tax identifier is one', () => {
    expect(isSecret('taxId')).toBe(true)
  })

  it('leaves an ordinary field alone', () => {
    expect(isSecret('email')).toBe(false)
    expect(isSecret('paymentTermsDays')).toBe(false)
  })

  /**
   * "set", not a row of asterisks. A mask shaped like the value tells somebody
   * how long it was, and a reader shown `••••` reasonably assumes the real
   * thing is a click away.
   */
  it('says that there was one rather than what it was', () => {
    expect(maskSecret('12-3456789')).toBe('set')
  })

  /** Cleared is the half an investigation actually cares about. */
  it('keeps a cleared field readable as cleared', () => {
    expect(maskSecret(null)).toBeNull()
  })
})
