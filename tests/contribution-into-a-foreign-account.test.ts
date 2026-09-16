import { beforeEach, describe, expect, it } from 'vitest'
import { createCompanyFixture, type Fixture } from './helpers'
import { createFinancialAccount } from '@/modules/banking/accounts'
import { recordContribution, receivePledge } from '@/modules/funds/contributions'
import { createFund } from '@/modules/funds/service'

/**
 * A donation banked into an account the books do not keep (Phase 133 → 141).
 *
 * ## Unskipped by Phase 151, which wired it
 *
 * `recordContribution` was deliberately **not** routed through
 * `bankGlAccountFor` while the cores were being staged. It is now, the entry is
 * off `PENDING_WIRING`, and this is what says it worked.
 *
 * ## The defect it described, which is now repaired
 *
 * The gift branch reads `financialAccounts.chartAccountId` straight out of the
 * table and debits that account. Nothing asks what currency the account is held
 * in, so a $1,200 donation recorded against a euro account asserts that $1,200
 * landed there — when what landed was some number of euros nobody wrote down.
 *
 * Its sibling forty lines below does it correctly. `receivePledge` calls
 * `bankGlAccountFor`, which refuses a foreign account in a sentence naming the
 * account, both currencies and what to do instead. So the same business is told
 * no when a pledge is received into that account, and nothing at all when a gift
 * is.
 *
 * ## Why Phase 133 missed it
 *
 * That phase found its sites by scanning for `chartAccountId: bank.chartAccountId`
 * or a variable whose name contains `gl`. This function assigns the account to
 * `debitAccountId` first and posts *that*, so it is absent from `BANK_POSTINGS`
 * altogether — a scan that looked for a spelling rather than for the fact, which
 * is the sixth time this codebase has found that shape.
 */

let fixture: Fixture
let euroAccountId: string
let fundId: string

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Harbour Trust', industry: 'nonprofit' })

  const account = await createFinancialAccount(fixture.ctx, {
    name: 'Frankfurt Current',
    kind: 'checking',
    currency: 'EUR',
    mask: '8802',
  })
  euroAccountId = account.id

  const fund = await createFund(fixture.ctx, {
    code: 'ROOF',
    name: 'Building Fund',
    restriction: 'restricted',
  })
  fundId = fund.id
})

describe('recording a gift into an account the books are not kept in', () => {
  it('refuses, naming the account and both currencies', async () => {
    // Phase 119's standard for a refusal somebody has to act on, and the same
    // sentence `receivePledge` already produces.
    await expect(
      recordContribution(fixture.ctx, {
        fundId,
        receivedOn: '2026-09-01',
        amountCents: 120_000,
        financialAccountId: euroAccountId,
      }),
    ).rejects.toThrow(/Frankfurt Current[\s\S]*EUR[\s\S]*USD/)
  })

  it('says which act was refused, not that an operation failed', async () => {
    await expect(
      recordContribution(fixture.ctx, {
        fundId,
        receivedOn: '2026-09-01',
        amountCents: 120_000,
        financialAccountId: euroAccountId,
      }),
    ).rejects.toThrow(/journal entry/)
  })

  it('gives the same answer as its sibling for the same account', async () => {
    // The point of the phase in one assertion: two functions in one file, both
    // debiting a bank account, must not disagree about whether a euro account is
    // allowed. Today one refuses and the other posts.
    const gift = await recordContribution(fixture.ctx, {
      fundId,
      receivedOn: '2026-09-01',
      amountCents: 120_000,
      financialAccountId: euroAccountId,
    }).then(
      () => 'posted',
      () => 'refused',
    )

    const pledge = await recordContribution(fixture.ctx, {
      fundId,
      kind: 'pledge',
      receivedOn: '2026-09-01',
      amountCents: 120_000,
    }).then(async (row) =>
      receivePledge(fixture.ctx, {
        contributionId: row.id,
        amountCents: 120_000,
        receivedOn: '2026-09-02',
        financialAccountId: euroAccountId,
      }).then(
        () => 'posted',
        () => 'refused',
      ),
    )

    expect(gift).toBe(pledge)
    expect(gift).toBe('refused')
  })
})

describe('a domestic gift, which is every one so far', () => {
  it('still posts, untouched', async () => {
    // Why this went a hundred and forty phases unnoticed, and the assertion that
    // keeps the repair from becoming a refusal nobody wanted: with one currency
    // the gate has nothing to refuse.
    const result = await recordContribution(fixture.ctx, {
      fundId,
      receivedOn: '2026-09-01',
      amountCents: 120_000,
      financialAccountId: fixture.financialAccountId,
    })

    expect(result.journalEntryId).toBeTruthy()
  })
})
