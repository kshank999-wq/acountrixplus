import { describe, expect, it } from 'vitest'
import { CONTROL_ACCOUNTS, creditableByReceipt } from '@/modules/inventory/receipt-credit'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'

/**
 * What a stock receipt may be credited to (Phase 117). No database, no clock.
 *
 * `receiveStock` takes its credit account from the caller and said why — a
 * goods receipt, an opening balance and a customer return differ only in what
 * gets credited. What it never said was what is *illegitimate*, and this
 * repository's own seed then credited `2000 Accounts Payable` four times.
 */

describe('the accounts a receipt may not credit', () => {
  it('names both control accounts, and only those', () => {
    expect(CONTROL_ACCOUNTS.map((row) => row.number).sort()).toEqual(['1100', '2000'])
  })

  it('gives each one a reason in the terms of the books', () => {
    // A bare list of numbers is a fact that looks the same whether it is right
    // or wrong; the argument is the part a reader needs.
    for (const account of CONTROL_ACCOUNTS) {
      expect(account.because.length, account.number).toBeGreaterThan(80)
    }
  })
})

describe('refusing a control account', () => {
  it('refuses Accounts Payable, which is what the seed did', () => {
    const verdict = creditableByReceipt({
      number: SYSTEM_ACCOUNTS.accountsPayable,
      name: 'Accounts Payable',
    })

    expect(verdict.ok).toBe(false)
  })

  it('refuses Accounts Receivable too, from the other side', () => {
    expect(
      creditableByReceipt({ number: SYSTEM_ACCOUNTS.accountsReceivable, name: 'Accounts Receivable' })
        .ok,
    ).toBe(false)
  })

  it('says what is wrong and where to put it instead', () => {
    // A refusal somebody reads beats a number nobody can reconcile — so it
    // names the account, says why a control account cannot hold this, and
    // points at the two accounts that can.
    const verdict = creditableByReceipt({
      number: SYSTEM_ACCOUNTS.accountsPayable,
      name: 'Accounts Payable',
    })

    if (verdict.ok) throw new Error('expected a refusal')
    expect(verdict.why).toContain('2000 Accounts Payable')
    expect(verdict.why).toContain('nobody to pay it to')
    expect(verdict.why).toContain('2050')
  })
})

describe('permitting everything else', () => {
  it('permits Goods Received Not Invoiced, which the purchase-order path uses', () => {
    expect(
      creditableByReceipt({
        number: SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced,
        name: 'Goods Received Not Invoiced',
      }).ok,
    ).toBe(true)
  })

  it('permits work in process, which a manufacturing run credits', () => {
    expect(creditableByReceipt({ number: '1450', name: 'Work in Process' }).ok).toBe(true)
  })

  it('permits a bank account, for stock bought outright', () => {
    expect(creditableByReceipt({ number: '1000', name: 'Checking Account' }).ok).toBe(true)
  })

  it('permits opening balance equity, for stock brought across', () => {
    // Deliberately a deny-list rather than an allow-list: the legitimate
    // credits are genuinely varied, and enumerating them would refuse the next
    // honest one. What is excluded is a single, statable class.
    expect(
      creditableByReceipt({
        number: SYSTEM_ACCOUNTS.openingBalanceEquity,
        name: 'Opening Balance Equity',
      }).ok,
    ).toBe(true)
  })
})
