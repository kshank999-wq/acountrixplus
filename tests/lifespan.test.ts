import { describe, expect, it } from 'vitest'
import {
  LifespanError,
  absorbedBy,
  excludedNote,
  heldAt,
  onBooksAt,
  positionAsAt,
  type DatedMovement,
} from '@/modules/ledger/lifespan'

/**
 * What was on the books at a date (Phase 111).
 *
 * Phase 110 read the two checks it had left `today_only` and found both
 * present-tense for reasons only the query shows. Measured on the development
 * books afterwards:
 *
 * ```
 * assets.register    2026-03-31: agrees  cost 10125000/10125000
 *                    2025-12-31: DIFFERS cost 10125000/0
 * manufacturing.wip  2026-03-31: agrees  12600/12600
 *                    2025-12-31: DIFFERS 12600/0
 * ```
 *
 * Both are faults, so asking about last December reported $101,250 of broken
 * books on books that were correct.
 */

const life = (openedOn: string | null, closedOn: string | null = null) => ({ openedOn, closedOn })

describe('whether a thing was on the books', () => {
  it('is on from the day it arrives, not the day after', () => {
    // Inclusive, because the entry that puts it there is dated that day and a
    // report as at that day includes it.
    expect(onBooksAt(life('2026-03-01'), '2026-03-01')).toBe(true)
    expect(onBooksAt(life('2026-03-01'), '2026-02-28')).toBe(false)
  })

  it('is off from the day it leaves, not the day after', () => {
    // Exclusive, for the mirror-image reason: the entry that removes it is
    // dated that day, so the ledger as at that day has already let it go.
    expect(onBooksAt(life('2026-03-01', '2026-06-30'), '2026-06-30')).toBe(false)
    expect(onBooksAt(life('2026-03-01', '2026-06-30'), '2026-06-29')).toBe(true)
  })

  it('stays on while it has not closed', () => {
    expect(onBooksAt(life('2026-03-01', null), '2030-01-01')).toBe(true)
  })

  it('is never on when it never opened', () => {
    // A draft work order has no start date because nothing has happened to it.
    // Reading that as the beginning of time would put every draft on every
    // historical report.
    expect(onBooksAt(life(null), '2026-03-01')).toBe(false)
    expect(onBooksAt(life(null, null), '1900-01-01')).toBe(false)
  })

  it('refuses a lifespan that closed before it opened', () => {
    // Both silent answers are wrong half the time, on a report somebody
    // reconciles against.
    expect(() => onBooksAt(life('2026-06-30', '2026-03-01'), '2026-04-01')).toThrow(LifespanError)
    expect(() => onBooksAt(life('2026-06-30', '2026-03-01'), '2026-04-01')).toThrow(
      /before it opened/,
    )
  })

  it('allows a thing that opened and closed on one day', () => {
    // Bought and sold the same day: on the books for no part of any report.
    expect(onBooksAt(life('2026-03-01', '2026-03-01'), '2026-03-01')).toBe(false)
    expect(onBooksAt(life('2026-03-01', '2026-03-01'), '2026-02-28')).toBe(false)
  })
})

describe('what it had absorbed by then', () => {
  const movements: DatedMovement[] = [
    { on: '2026-03-05', cents: 4_000 },
    { on: '2026-03-20', cents: 1_500 },
    { on: '2026-06-01', cents: 9_000 },
  ]

  it('counts what happened on or before the date', () => {
    expect(absorbedBy(movements, '2026-03-04')).toBe(0)
    expect(absorbedBy(movements, '2026-03-05')).toBe(4_000)
    expect(absorbedBy(movements, '2026-03-31')).toBe(5_500)
    expect(absorbedBy(movements, '2026-12-31')).toBe(14_500)
  })

  it('holds what it absorbed while it is open', () => {
    expect(heldAt(life('2026-03-05'), movements, '2026-03-31')).toBe(5_500)
  })

  it('holds nothing once it is closed, whatever the movements say', () => {
    // The entry that closed it released the whole balance. Carrying the
    // movements past that point double-counts them against a ledger that has
    // already let them go.
    expect(heldAt(life('2026-03-05', '2026-04-30'), movements, '2026-06-30')).toBe(0)
    // And still holds them the day before it closed.
    expect(heldAt(life('2026-03-05', '2026-04-30'), movements, '2026-04-29')).toBe(5_500)
  })

  it('holds nothing before it opened', () => {
    expect(heldAt(life('2026-03-05'), movements, '2026-01-01')).toBe(0)
  })
})

describe('a set of holdings at a date', () => {
  const holdings = [
    { subject: 'excavator', life: life('2026-01-10'), movements: [{ on: '2026-01-10', cents: 500_000 }] },
    { subject: 'trailer', life: life('2026-05-01'), movements: [{ on: '2026-05-01', cents: 80_000 }] },
    {
      subject: 'sold van',
      life: life('2025-06-01', '2026-02-15'),
      movements: [{ on: '2025-06-01', cents: 300_000 }],
    },
  ]

  it('counts only what was there, and says which', () => {
    const march = positionAsAt(holdings, '2026-03-31')

    expect(march.cents).toBe(500_000)
    expect(march.on).toEqual(['excavator'])
    expect(march.off).toEqual(['trailer', 'sold van'])
  })

  it('picks up something bought later when asked later', () => {
    const june = positionAsAt(holdings, '2026-06-30')

    expect(june.cents).toBe(580_000)
    expect(june.on).toEqual(['excavator', 'trailer'])
  })

  it('sees the one that was sold, before it was sold', () => {
    const january = positionAsAt(holdings, '2026-01-31')

    expect(january.cents).toBe(800_000)
    expect(january.on).toEqual(['excavator', 'sold van'])
  })

  it('names the members rather than only the total', () => {
    // The first question after "these disagree by $101,250" is which ones, and
    // a caller that has to re-run the filter is a second place for the boundary
    // to be decided.
    const { on, off } = positionAsAt(holdings, '2026-03-31')
    expect(on.length + off.length).toBe(holdings.length)
  })
})

describe('what the page says about the ones left out', () => {
  const noun = { one: 'asset', many: 'assets' }

  it('agrees with itself on the count', () => {
    expect(excludedNote(1, noun, '2025-12-31')).toContain('1 asset is left out')
    expect(excludedNote(3, noun, '2025-12-31')).toContain('3 assets are left out')
  })

  it('names the date that left them out', () => {
    expect(excludedNote(2, noun, '2025-12-31')).toContain('2025-12-31')
  })

  it('stays quiet when the date left nothing out', () => {
    expect(excludedNote(0, noun, '2025-12-31')).toBeUndefined()
  })
})
