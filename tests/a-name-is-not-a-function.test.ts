import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  cashTieOut,
  createFinancialAccount,
  listFinancialAccounts,
  setFinancialAccountActive,
} from '@/modules/banking/accounts'
import { pickableFinancialAccounts } from '@/modules/banking/sync'
import { OPT_IN_CANDIDATES, createCompanyFixture, type Fixture } from './helpers'

/**
 * A name is not a function (Phase 207, spec §4, §13).
 *
 * ## What the nomination counted, and why the count was wrong
 *
 * ADR 0206 nominated *"`listFinancialAccounts`' nine flagless callers, read
 * one at a time"*, on the grounds that a financial account is a **bank
 * account** and offering a retired one is offering to move money through
 * something the business has closed.
 *
 * There were not nine. **There are two exported functions with that name**:
 *
 * | | |
 * | --- | --- |
 * | `banking/sync.ts` | no option, **always** filters on `isActive`. Its docstring said it was *"for inbox filters and account pickers"*. Five screens import it. |
 * | `banking/accounts.ts` | `activeOnly` **opt-in**, a different return shape. Four callers, one of them internal. |
 *
 * Five of the nine were calling the always-filtering one and were correct all
 * along. The count was wrong because it was measured **by name**, and a name
 * is not a function — which is Phases 196–198's own lesson about a scan
 * recognising a query by a name, turned on a grep over function names.
 *
 * So the sync one is `pickableFinancialAccounts` now: `pickable` is the whole
 * claim, every caller is a picker or an inbox filter, and the name says what
 * the body does.
 *
 * ## The one live defect of the four real callers
 *
 * `accounting/payments` fed the **refund** picker with every account the
 * company has ever had. A refund could be paid out of a bank account the
 * business had closed. `listAccounts` was the chart in Phase 206; this is the
 * cash.
 *
 * ## And the one caller that must keep seeing retired accounts
 *
 * Flipping a default is the dangerous half of this, and measuring the callers
 * first is what caught two things it would have broken:
 *
 * - `cashTieOut` ties each account's feed balance to the ledger, and a retired
 *   account that still carries a balance still has to tie out. Excluding them
 *   would **hide a disagreement** rather than tidy a list.
 * - `settings/accounts` splits open from closed and carries the Reopen
 *   control, so defaulting it to live accounts would make a closed account
 *   vanish from the one screen that can bring it back — Phase 206's defect,
 *   reintroduced by Phase 207's own flip.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
})

async function closed(name = 'Old Current Account') {
  const account = await createFinancialAccount(fixture.ctx, { name, kind: 'checking' })
  await setFinancialAccountActive(fixture.ctx, account.id, false)
  return account
}

describe('two functions, one name', () => {
  it('no longer share it', () => {
    /**
     * The structural finding. A call site told you which function it got only
     * by its import line, and the two differ in signature *and* in whether
     * they filter — which is two answers to one question in the purest form
     * this codebase has found it.
     */
    const sync = readFileSync('src/modules/banking/sync.ts', 'utf8')
    const accounts = readFileSync('src/modules/banking/accounts.ts', 'utf8')

    expect(sync).toContain('export async function pickableFinancialAccounts')
    expect(sync).not.toContain('export async function listFinancialAccounts')
    expect(accounts).toContain('export async function listFinancialAccounts')

    // And every screen that used the sync one now names it.
    for (const page of [
      'src/app/funds/page.tsx',
      'src/app/bookkeeping/page.tsx',
      'src/app/accounting/reconcile/page.tsx',
      'src/app/accounting/reconcile/[id]/page.tsx',
      'src/app/properties/page.tsx',
    ]) {
      const source = readFileSync(page, 'utf8')
      expect(source, page).toContain('pickableFinancialAccounts(actor)')
      expect(source, page).not.toContain('listFinancialAccounts')
    }
  })

  it('and the pickable one was right all along', async () => {
    /**
     * The five callers the nomination counted as defects. Asserted rather than
     * assumed, because *"they were already correct"* is the kind of claim this
     * process keeps finding to be unmeasured — and here it is the reason the
     * nominated count was five too high.
     */
    const live = await createFinancialAccount(fixture.ctx, {
      name: 'Current Account',
      kind: 'checking',
    })
    const shut = await closed()

    const pickable = await pickableFinancialAccounts(fixture.ctx)
    const ids = pickable.map((row) => row.id)

    expect(ids).toContain(live.id)
    expect(ids).not.toContain(shut.id)
  })
})

describe('the default that flipped', () => {
  it('offers live accounts to a caller that passes nothing', async () => {
    const live = await createFinancialAccount(fixture.ctx, {
      name: 'Current Account',
      kind: 'checking',
    })
    const shut = await closed()

    const offered = (await listFinancialAccounts(fixture.ctx)).map((row) => row.id)
    expect(offered).toContain(live.id)
    expect(offered).not.toContain(shut.id)

    const all = (await listFinancialAccounts(fixture.ctx, { includeRetired: true })).map(
      (row) => row.id,
    )
    expect(all).toContain(shut.id)
  })

  it('keeps a closed account in the tie-out, which the flip would have hidden', async () => {
    /**
     * The assertion that makes the flip safe rather than tidy. `cashTieOut`
     * compares each account's feed against the ledger; a closed account that
     * still carries a balance still has to agree, and dropping it would turn a
     * disagreement into silence.
     *
     * This is the one caller of the four that asks for retired accounts, and
     * it asks explicitly now.
     */
    const shut = await closed()

    const tie = await cashTieOut(fixture.ctx)
    expect(tie.map((row) => row.financialAccountId)).toContain(shut.id)
  })

  it('leaves the screen that reopens them able to see them', () => {
    /**
     * Phase 206's defect, which Phase 207's own default flip would have
     * reintroduced: `settings/accounts` splits open from closed and carries
     * the Reopen control, so the one screen that can bring an account back
     * must be the one that still asks for it.
     *
     * Asserted on the source because the claim is about which list the board
     * is built from, and the board's own filter cannot show what the query
     * never returned.
     */
    const page = readFileSync('src/app/settings/accounts/page.tsx', 'utf8')
    expect(page).toContain('listFinancialAccounts(actor, { includeRetired: true })')

    const board = readFileSync('src/app/settings/accounts/board.tsx', 'utf8')
    expect(board).toContain('accounts.filter((account) => !account.isActive)')
    expect(board).toContain('Reopen')
  })
})

describe('the refund that could leave a closed account', () => {
  it('is offered live accounts only now', () => {
    /*
      The one live defect of the four real callers. The refund picker on the
      payments board was built from every account the company had ever had.
    */
    const page = readFileSync('src/app/accounting/payments/page.tsx', 'utf8')

    expect(page).toContain('listFinancialAccounts(actor),')
    expect(page).not.toMatch(/listFinancialAccounts\(actor, \{ includeRetired/)

    const board = readFileSync('src/app/accounting/payments/board.tsx', 'utf8')
    expect(board).toContain('refundAccountId')
  })

  it('drops the screen-side filter that duplicated the query’s', () => {
    /*
      `settings/payments` filtered `isActive` in the page after the query had
      not. Now the query does it and the page does not — one answer, where
      there were about to be two that could disagree.
    */
    const page = readFileSync('src/app/settings/payments/page.tsx', 'utf8')

    expect(page).toContain('listFinancialAccounts(actor),')
    // On the construct rather than on the string: the comment recording the
    // removal names the filter it removed, and an assertion that searched for
    // the text found its own explanation.
    expect(page).toContain('accounts={accounts\n          .map(')
    expect(page).not.toContain('accounts={accounts\n          .filter(')
  })
})

describe('what is left of the class', () => {
  it('is five functions, measured rather than counted by name', () => {
    /**
     * Phase 206 declared six list functions with the `activeOnly` opt-in
     * default and Phase 207 closed one, so five keep it: `listAccounts`,
     * `listEmployees`, `listTaxCodes`, `listCostCodes` and
     * `subcontractorSummaries`. Four of those are candidates to flip;
     * `listAccounts` is deliberately not, asserted separately below.
     *
     * Measured from the source over the **same list** Phase 206's test uses,
     * read from `helpers` rather than retyped. Two phases counting one class in two
     * places is what sent the full run red twice in this run — once on the
     * switch register and once on this very count — so the list has one home
     * and both assertions read it.
     */
    const remaining = OPT_IN_CANDIDATES.filter((file) =>
      /activeOnly\?: boolean/.test(readFileSync(file, 'utf8')),
    )

    expect(remaining).toHaveLength(5)

    // The two closed in Phases 206 and 207 are not among them.
    for (const file of ['src/modules/studio/service.ts', 'src/modules/banking/accounts.ts']) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/activeOnly\?: boolean/)
      expect(source, file).toContain('includeRetired?: boolean')
    }

    // `listAccounts` keeps its opt-in flag deliberately: Phase 206 fixed its
    // four pickers at the call sites rather than flipping it, because two of
    // its callers legitimately need the whole chart and the flip was not
    // measured there.
    expect(readFileSync('src/modules/coa/service.ts', 'utf8')).toContain('activeOnly')
  })
})
