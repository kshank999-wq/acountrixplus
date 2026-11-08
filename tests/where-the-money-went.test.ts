import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, chartAccounts, giftCards, journalLines } from '@/db/schema'
import {
  APPOINTMENT_ACCOUNTS,
  closeGiftCard,
  listGiftCards,
  redeemGiftCard,
  reissueGiftCard,
  sellGiftCard,
} from '@/modules/appointments/service'
import { giftCardPosition } from '@/modules/appointments/reporting'
import { accountByNumber } from '@/modules/coa/service'
import { setModuleEnabled } from '@/modules/industry/modules'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * Where the money went (Phase 203, spec §5).
 *
 * ## What ADR 0202 nominated, and the half of it that was missing
 *
 * `gift_cards.isActive` is read by `redeemGiftCard`, which refuses an inactive
 * card by name — *"Gift card X is no longer valid"* — and **nothing could set
 * it false**. Phase 202 found it among six such switches and nominated this
 * one because the thing nobody could turn off is money.
 *
 * Measuring it found the nomination was the second half of a screen with no
 * first half: **there was no list of gift cards anywhere.**
 * `giftCardPosition` returned four totals, `sellGiftCard` wrote a row, and the
 * only place a card's own code and balance appeared was the §19 portability
 * export. A business could not answer *"what is on GC-1004?"* except by
 * attempting a redemption against a completed appointment and reading the
 * refusal.
 *
 * ## The claim this phase is
 *
 * A card holds a liability on account 2590, and `giftCardPosition` reconciles
 * the sum of card balances against the ledger. So there are three dishonest
 * ways to stop a card and one honest one:
 *
 * | | |
 * | --- | --- |
 * | flip the flag, leave the balance | 2590 keeps a liability nobody can ever settle. The reconciliation agrees and the balance sheet is wrong. |
 * | zero the balance, post nothing | the subledger moves and the ledger does not, so the check cries wolf on books somebody deliberately changed. |
 * | zero both, pick the account silently | somebody's money lands in income because a default said so. |
 *
 * The honest one is to **refuse**: a card with something left on it cannot be
 * stopped without saying where the money went, because *"this cannot be
 * spent"* and *"we still owe it"* cannot both be true.
 *
 * ## Two columns that were waiting
 *
 * `depositAccountId` was **written by `sellGiftCard` and read by nothing** —
 * Phase 49's shape mirrored, and invisible to Phases 201–202's census, which
 * only looks for the opposite. It is the default refund destination now,
 * which is what the schema's *"where the money went when it was sold"* was
 * recorded for. And `code` was insert-only — one of the 770 Phase 202
 * measured and could not report — which a reissue is the update for.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Fenwick Row', industry: 'personal_care' })
  await setModuleEnabled(fixture.ctx, 'appointments', true)
})

async function card(code = 'GC-1001', amountCents = 5_000) {
  return sellGiftCard(fixture.ctx, { code, amountCents, issuedOn: '2026-03-01' })
}

/** The balance of one account, from the ledger rather than the subledger. */
async function ledger(number: string): Promise<number> {
  const account = await accountByNumber(fixture.companyId, number)
  if (!account) throw new Error(`no account ${number}`)

  const lines = await db
    .select({ debit: journalLines.debitCents, credit: journalLines.creditCents })
    .from(journalLines)
    .where(
      and(
        eq(journalLines.companyId, fixture.companyId),
        eq(journalLines.chartAccountId, account.id),
      ),
    )

  return lines.reduce((total, line) => total + line.debit - line.credit, 0)
}

describe('the list that did not exist', () => {
  it('shows a card’s code, what is on it, and whether it was stopped', async () => {
    await card('GC-1001', 5_000)
    await card('GC-1002', 2_500)

    const cards = await listGiftCards(fixture.ctx)

    expect(cards.map((row) => row.code).sort()).toEqual(['GC-1001', 'GC-1002'])
    expect(cards.every((row) => row.isActive)).toBe(true)
    expect(cards.find((row) => row.code === 'GC-1001')?.balanceCents).toBe(5_000)
  })

  it('keeps a stopped card listed, and lists it first', async () => {
    /**
     * *"That code was stopped"* is the thing somebody looks up when a customer
     * arrives holding one, so a closed card is not hidden — it is the answer.
     */
    await card('GC-1001', 5_000)
    await card('GC-1002', 2_500)

    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'refund',
      closedOn: '2026-03-10',
    })

    const cards = await listGiftCards(fixture.ctx)

    expect(cards).toHaveLength(2)
    expect(cards[0].code).toBe('GC-1001')
    expect(cards[0].isActive).toBe(false)
    expect(cards[0].balanceCents).toBe(0)
    // And what it was sold for is still there, because the question asked
    // later is what the business took, not what is left.
    expect(cards[0].issuedCents).toBe(5_000)
  })
})

describe('a card with money left on it', () => {
  it('refuses to be stopped without saying where the money went', async () => {
    /**
     * The substance of the phase. The sentence is the feature: a toggle here
     * would leave account 2590 carrying a liability nobody could ever settle,
     * and the reconciliation would go on agreeing.
     */
    await card('GC-1001', 5_000)

    await expect(
      closeGiftCard(fixture.ctx, { code: 'GC-1001', closedOn: '2026-03-10' }),
    ).rejects.toThrow(/Say where it goes/)

    // And nothing changed, so a refused close is not a half-done one.
    const [row] = await db
      .select({ balanceCents: giftCards.balanceCents, isActive: giftCards.isActive })
      .from(giftCards)
      .where(eq(giftCards.companyId, fixture.companyId))

    expect(row).toMatchObject({ balanceCents: 5_000, isActive: true })
    expect(await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)).toBe(-5_000)
  })

  it('settles the liability when it is refunded, into the account it was sold from', async () => {
    /**
     * `depositAccountId` had a writer and no reader, which is the mirror of
     * what Phases 201–202 measured. The money goes back where it came from,
     * which is both the obvious answer and the one the column was recorded
     * for.
     */
    await card('GC-1001', 5_000)

    const before = await ledger('1000')
    const result = await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'refund',
      closedOn: '2026-03-10',
    })

    expect(result).toMatchObject({ releasedCents: 5_000, disposition: 'refund' })

    // 2590 is square: the sale credited it and the refund debited it back.
    expect(await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)).toBe(0)
    // And the cash the sale brought in has left again.
    expect(await ledger('1000')).toBe(before - 5_000)
  })

  it('releases it to income when it is written off, never to service revenue', async () => {
    /**
     * ADR 0029 refuses breakage — *"a judgement about how many never come
     * back"* — and that argument is about an **estimate across many cards**.
     * Nothing here sweeps, ages or expires anything: this is one card a person
     * decided about by name, with the account named and the entry in the audit
     * trail.
     *
     * `8100 Other Income` rather than `4700 Service Revenue - Appointments`,
     * because no service was given.
     */
    await card('GC-1001', 5_000)

    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'write_off',
      closedOn: '2026-03-10',
    })

    expect(await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)).toBe(0)
    expect(await ledger('8100')).toBe(-5_000)
    expect(await ledger(APPOINTMENT_ACCOUNTS.serviceRevenue)).toBe(0)
  })

  it('refuses to release it anywhere the profit and loss cannot see', async () => {
    /*
      The type check, and the reason it is a refusal rather than a default: a
      balance released from 2590 onto another balance-sheet account is a
      liability that disappeared with nothing to show for it, which is the one
      outcome a write-off must not be able to produce by accident.
    */
    await card('GC-1001', 5_000)

    await expect(
      closeGiftCard(fixture.ctx, {
        code: 'GC-1001',
        disposition: 'write_off',
        accountNumber: '1000',
        closedOn: '2026-03-10',
      }),
    ).rejects.toThrow(/not an income account/)

    // And the other direction: a refund has to leave an account money is in.
    await expect(
      closeGiftCard(fixture.ctx, {
        code: 'GC-1001',
        disposition: 'refund',
        accountNumber: '8100',
        closedOn: '2026-03-10',
      }),
    ).rejects.toThrow(/not an asset/)
  })

  it('leaves the subledger and the ledger agreeing either way', async () => {
    /**
     * The assertion that makes the three dishonest designs impossible to ship.
     * `giftCardPosition` computes the two sides separately — the sum of card
     * balances, and the ledger balance of 2590 — so this is a reconciliation
     * rather than a restatement, and a close that moved one without the other
     * would show up here.
     */
    await card('GC-1001', 5_000)
    await card('GC-1002', 2_500)
    await card('GC-1003', 1_000)

    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'refund',
      closedOn: '2026-03-10',
    })
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1002',
      disposition: 'write_off',
      closedOn: '2026-03-10',
    })

    const position = await giftCardPosition(fixture.ctx)

    expect(position.agrees).toBe(true)
    expect(position.outstandingCents).toBe(1_000)
    expect(position.differenceCents).toBe(0)
  })
})

describe('a card with nothing left on it', () => {
  it('is stopped with no disposition and no entry', async () => {
    // There is no money to place, so stopping a spent code is housekeeping and
    // asking where nothing went would be noise.
    await card('GC-1001', 5_000)
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'refund',
      closedOn: '2026-03-10',
    })

    await card('GC-1002', 1_000)
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1002',
      disposition: 'write_off',
      closedOn: '2026-03-10',
    })

    // A third, spent down to nothing by hand rather than through a visit, so
    // the case under test is the balance rather than the route to it.
    await card('GC-1003', 1_000)
    await db
      .update(giftCards)
      .set({ balanceCents: 0 })
      .where(
        and(eq(giftCards.companyId, fixture.companyId), eq(giftCards.code, 'GC-1003')),
      )

    const entriesBefore = await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)

    const result = await closeGiftCard(fixture.ctx, {
      code: 'GC-1003',
      closedOn: '2026-03-10',
    })

    expect(result).toMatchObject({ releasedCents: 0, disposition: null })
    expect(await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)).toBe(entriesBefore)
  })
})

describe('stopping a card stops it', () => {
  it('is what redeemGiftCard had been refusing on all along', async () => {
    /**
     * The point of the whole phase, asserted through the reader rather than
     * the column: `redeemGiftCard` has refused an inactive card since Phase 29
     * and the state was unreachable. This is the first test in the repository
     * that can reach it.
     */
    await card('GC-1001', 5_000)
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'write_off',
      closedOn: '2026-03-10',
    })

    await expect(
      redeemGiftCard(fixture.ctx, {
        code: 'GC-1001',
        appointmentId: '11111111-1111-1111-1111-111111111111',
        redeemedOn: '2026-03-11',
      }),
    ).rejects.toThrow(/no longer valid/)
  })

  it('refuses to be stopped twice', async () => {
    await card('GC-1001', 5_000)
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'refund',
      closedOn: '2026-03-10',
    })

    await expect(
      closeGiftCard(fixture.ctx, { code: 'GC-1001', closedOn: '2026-03-11' }),
    ).rejects.toThrow(/already closed/)
  })
})

describe('a lost card reprinted', () => {
  it('is the same card with a different number, and posts nothing', async () => {
    /**
     * The common thing that happens to a gift card. What the business wants is
     * the old number dead and the customer's money intact — one card with a
     * new number on it, not a card destroyed and another sold, which would
     * post a sale that never happened and inflate what the business took.
     */
    await card('GC-1001', 5_000)
    const before = await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)

    const moved = await reissueGiftCard(fixture.ctx, {
      code: 'GC-1001',
      newCode: 'GC-1001B',
    })

    expect(moved.code).toBe('GC-1001B')
    expect(moved.balanceCents).toBe(5_000)

    // Nothing posted, and nothing to reconcile.
    expect(await ledger(APPOINTMENT_ACCOUNTS.giftCardsOutstanding)).toBe(before)
    expect((await giftCardPosition(fixture.ctx)).agrees).toBe(true)

    // One card, not two — so what the business took is still £50.
    const cards = await listGiftCards(fixture.ctx)
    expect(cards).toHaveLength(1)
    expect(cards[0].isActive).toBe(true)

    // The old number is gone.
    await expect(
      reissueGiftCard(fixture.ctx, { code: 'GC-1001', newCode: 'GC-1001C' }),
    ).rejects.toThrow(/No gift card with code GC-1001/)
  })

  it('is spendable under the new number and not the old', async () => {
    await card('GC-1001', 5_000)
    await reissueGiftCard(fixture.ctx, { code: 'GC-1001', newCode: 'GC-1001B' })

    // Both refusals name the code, which is what distinguishes "that card does
    // not exist" from "that card was stopped".
    await expect(
      redeemGiftCard(fixture.ctx, {
        code: 'GC-1001',
        appointmentId: '11111111-1111-1111-1111-111111111111',
        redeemedOn: '2026-03-11',
      }),
    ).rejects.toThrow(/No gift card with code GC-1001/)
  })

  it('refuses to reprint a card that was stopped', async () => {
    /*
      Reissuing a closed card would put a balance back without the entry that
      reversing one needs — the only way the refusals above could be walked
      around.
    */
    await card('GC-1001', 5_000)
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001',
      disposition: 'write_off',
      closedOn: '2026-03-10',
    })

    await expect(
      reissueGiftCard(fixture.ctx, { code: 'GC-1001', newCode: 'GC-1001B' }),
    ).rejects.toThrow(/has been closed/)
  })

  it('refuses the code it already has', async () => {
    await card('GC-1001', 5_000)

    await expect(
      reissueGiftCard(fixture.ctx, { code: 'GC-1001', newCode: 'gc-1001' }),
    ).rejects.toThrow(/the same code/)
  })
})

describe('the audit trail of account 2590', () => {
  it('records all four movements, not two', async () => {
    /**
     * Selling was the only one of the four missing from this log while
     * redeeming had been in it since Phase 29 — an asymmetry rather than a
     * decision. The journal says a liability arrived; the audit trail is where
     * somebody asks who took the money and under what code, and for a
     * write-off, who decided to give a balance up.
     */
    await card('GC-1001', 5_000)
    await reissueGiftCard(fixture.ctx, { code: 'GC-1001', newCode: 'GC-1001B' })
    await closeGiftCard(fixture.ctx, {
      code: 'GC-1001B',
      disposition: 'write_off',
      closedOn: '2026-03-10',
    })

    const events = await db
      .select({ action: auditEvents.action, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.companyId, fixture.companyId))

    const actions = events.map((row) => row.action)
    expect(actions).toContain('giftcard.sell')
    expect(actions).toContain('giftcard.reissue')
    expect(actions).toContain('giftcard.close')

    // The disposition and the account are on the close, because the entry
    // alone cannot say whether a balance was handed back or given up.
    const close = events.find((row) => row.action === 'giftcard.close')
    expect(close?.after).toMatchObject({ disposition: 'write_off', creditAccount: '8100' })
  })
})

describe('the sentence on the screen', () => {
  it('names all four things that move 2590', () => {
    /**
     * The board's own prose said *"nothing legitimately moves 2590 except
     * selling and spending a card, and both do it in the same transaction as
     * the balance"*. True when it was written and false the moment a refund
     * and a write-off existed — the shape Phase 179 built `PINNED_CLAIMS`
     * for, except that this claim is a list rather than a number and nothing
     * can pin it.
     *
     * So it is asserted here: the four names, in the file that makes the
     * claim. A fifth way to move 2590 would need this test changed, which is
     * the cheapest available substitute for pinning a sentence that has no
     * figure in it.
     */
    const board = readFileSync('src/app/appointments/board.tsx', 'utf8')
    const paragraph = board.slice(
      board.indexOf('things that move 2590'),
      board.indexOf('things that move 2590') + 400,
    )

    for (const movement of ['selling', 'spending', 'refunding', 'releasing']) {
      expect(paragraph, movement).toContain(movement)
    }
  })
})

describe('what the census could not have found', () => {
  it('leaves depositAccountId with a reader for the first time', () => {
    /**
     * `gift_cards.depositAccountId` was written by `sellGiftCard` and read by
     * nothing — Phase 49's shape mirrored. Phases 201–202's census asks the
     * opposite question, *which columns does something read that nothing
     * writes*, so this was invisible to it and was found by reading.
     *
     * And the mirror census cannot be built from the same predicate.
     * `writerCandidates` uses "named outside the schema" as the test for
     * *read*, which is conservative in the safe direction — a missed read
     * loses a candidate. Inverted it becomes the exclusion test, and a single
     * `.select()` with no projection reads every column of a table while
     * naming none: `recentRequests` in `ai/settings.ts` is one, so every
     * column of `ai_requests` looks unread. Measured, the mirror reports 683
     * columns, which is the size of the error rather than a finding.
     *
     * Asserted on the source because the claim is about where the column is
     * read, and the reader is a default rather than a figure a test can see
     * from outside.
     */
    const service = readFileSync('src/modules/appointments/service.ts', 'utf8')

    expect(service).toContain('card.depositAccountId')
    expect(service.match(/depositAccountId/g)?.length).toBeGreaterThan(1)
  })
})
