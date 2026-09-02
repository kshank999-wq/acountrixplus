import { describe, expect, it } from 'vitest'
import {
  correction,
  everyCorrection,
  mustSayWhy,
  reasonFor,
  REASON_LIMIT,
  type CorrectionKind,
} from '@/modules/corrections/vocabulary'

/**
 * What the product calls it when somebody undoes something (Phase 70).
 *
 * ADR 0068 noticed the collision and ADR 0069 made it worse: "Take it back"
 * meant three different operations, and "Undo it" a fourth. And `voidPayment`
 * had insisted on a reason since Phase 52 while the other four corrections took
 * none — the same reasoning producing opposite behaviour by screen.
 */

const ALL: CorrectionKind[] = [
  'payment.void',
  'refund.void',
  'document.void',
  'deposit.void',
  'approval.withdraw',
  'party.merge',
]

describe('one phrase, one meaning', () => {
  /** The defect this phase exists to fix, pinned so it cannot come back. */
  it('gives no two corrections the same verb', () => {
    const verbs = everyCorrection().map((row) => row.verb)
    expect(new Set(verbs).size).toBe(verbs.length)
  })

  it('gives no two corrections the same past-tense phrase either', () => {
    const done = everyCorrection().map((row) => row.done)
    expect(new Set(done).size).toBe(done.length)
  })

  it('names every correction the product offers', () => {
    expect(everyCorrection().map((row) => row.kind).sort()).toEqual([...ALL].sort())
  })

  /** The three that used to share "Take it back" now say three things. */
  it('separates the three that collided', () => {
    expect(correction('approval.withdraw').verb).toBe('Withdraw approval')
    expect(correction('payment.void').verb).toBe('Void the payment')
    expect(correction('refund.void').verb).toBe('Undo the refund')
  })
})

describe('which corrections must say why', () => {
  /**
   * The rule: money that moved, or a document somebody outside has seen.
   * Anything that only rearranges our own records does not have to.
   */
  it('insists where money moved', () => {
    expect(mustSayWhy('payment.void')).toBe(true)
    expect(mustSayWhy('refund.void')).toBe(true)
  })

  it('insists where a document reached somebody', () => {
    expect(mustSayWhy('document.void')).toBe(true)
  })

  it('does not insist where only our own records move', () => {
    expect(mustSayWhy('deposit.void')).toBe(false)
    expect(mustSayWhy('approval.withdraw')).toBe(false)
  })

  /** The boolean is derived from what the correction disturbs, not typed in. */
  it('derives the rule from reach rather than a hand-set flag', () => {
    for (const row of everyCorrection()) {
      expect(mustSayWhy(row.kind)).toBe(row.reach !== 'internal')
    }
  })

  it('gives a prompt to exactly those that ask for one', () => {
    for (const row of everyCorrection()) {
      expect(row.reasonPrompt === null).toBe(!mustSayWhy(row.kind))
    }
  })
})

describe('the reason a correction is given', () => {
  it('refuses a blank one where it is required', () => {
    const verdict = reasonFor({ kind: 'payment.void', reason: '   ' })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain('Why is this payment being voided?')
  })

  /** The refusal is the prompt, so being stopped reads like being asked. */
  it('refuses with the same sentence that asked', () => {
    for (const row of everyCorrection().filter((r) => mustSayWhy(r.kind))) {
      const verdict = reasonFor({ kind: row.kind })
      expect(verdict.ok).toBe(false)
      expect(verdict.ok === false && verdict.why.startsWith(row.reasonPrompt!)).toBe(true)
    }
  })

  it('allows a blank one where it is not', () => {
    const verdict = reasonFor({ kind: 'deposit.void' })

    expect(verdict.ok).toBe(true)
    expect(verdict.ok === true && verdict.reason).toBeNull()
  })

  it('keeps a reason given anyway on an internal correction', () => {
    const verdict = reasonFor({ kind: 'approval.withdraw', reason: '  wrong bill  ' })

    expect(verdict.ok === true && verdict.reason).toBe('wrong bill')
  })

  it('trims what it keeps', () => {
    const verdict = reasonFor({ kind: 'payment.void', reason: '  keyed twice ' })
    expect(verdict.ok === true && verdict.reason).toBe('keyed twice')
  })

  it('refuses one longer than the limit', () => {
    const verdict = reasonFor({ kind: 'payment.void', reason: 'x'.repeat(REASON_LIMIT + 1) })

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.why).toContain(String(REASON_LIMIT))
  })

  it('allows one exactly at the limit', () => {
    expect(reasonFor({ kind: 'payment.void', reason: 'x'.repeat(REASON_LIMIT) }).ok).toBe(true)
  })
})
