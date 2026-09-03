import { describe, expect, it } from 'vitest'
import {
  describeAbsorbed,
  describeArchived,
  MOVED_ID_LIMIT,
  movedIdsAreComplete,
  movedRecordFor,
  tallyOf,
} from '@/modules/parties/merged'
import { summaryFrom, tell } from '@/modules/audit/story'

/**
 * What a merged-away record says about itself (Phase 97).
 *
 * The property that matters most: a truncated list of moved ids says it is
 * truncated. A list that silently ends leads somebody to conclude a document
 * did not move when it did — which is worse than never having kept the ids,
 * because it looks like an answer.
 */

describe('what the archived row says', () => {
  it('names where a merged record went', () => {
    expect(
      describeArchived({
        side: 'customer',
        isActive: false,
        mergedInto: { id: 'w', name: 'Cascade Joinery' },
      }),
    ).toBe('merged into Cascade Joinery')
  })

  it('still says plain archived for one that was only retired', () => {
    // Phase 56's archive and Phase 96's merge are different acts, and a row
    // that called them the same thing would be the vocabulary defect Phase 70
    // exists to prevent, in miniature.
    expect(describeArchived({ side: 'customer', isActive: false, mergedInto: null })).toBe(
      'archived',
    )
  })

  it('says nothing at all about a live record', () => {
    expect(
      describeArchived({ side: 'vendor', isActive: true, mergedInto: null }),
    ).toBeNull()
  })
})

describe('what the surviving record says', () => {
  it('explains where its extra documents came from', () => {
    expect(
      describeAbsorbed({
        side: 'customer',
        loserName: 'Cascade Joinery Ltd',
        moved: [
          { table: 'invoices', rows: 4 },
          { table: 'payments', rows: 2 },
        ],
      }),
    ).toBe('Absorbed Cascade Joinery Ltd, and 6 records with it.')
  })

  it('says so when the record it absorbed was empty', () => {
    expect(
      describeAbsorbed({ side: 'vendor', loserName: 'Spare Ltd', moved: [] }),
    ).toBe('Absorbed Spare Ltd, a supplier with nothing on it.')
  })

  it('counts one record as one', () => {
    expect(
      describeAbsorbed({
        side: 'customer',
        loserName: 'B',
        moved: [{ table: 'invoices', rows: 1 }],
      }),
    ).toContain('1 record with it')
  })
})

describe('the evidence of what moved', () => {
  it('keeps the ids, so "did this invoice move" has an answer', () => {
    const record = movedRecordFor({ table: 'invoices', ids: ['a', 'b', 'c'] })

    expect(record).toEqual({
      table: 'invoices',
      rows: 3,
      ids: ['a', 'b', 'c'],
      truncated: false,
    })
  })

  it('counts exactly even when the list stops', () => {
    const ids = Array.from({ length: MOVED_ID_LIMIT + 7 }, (_, i) => `id-${i}`)
    const record = movedRecordFor({ table: 'invoices', ids })

    expect(record.rows).toBe(MOVED_ID_LIMIT + 7)
    expect(record.ids).toHaveLength(MOVED_ID_LIMIT)
    expect(record.truncated).toBe(true)
  })

  it('does not call a merge of exactly the cap truncated', () => {
    // The reason `truncated` is a field rather than an inference from
    // `ids.length === MOVED_ID_LIMIT`, which is wrong for precisely this case.
    const ids = Array.from({ length: MOVED_ID_LIMIT }, (_, i) => `id-${i}`)
    const record = movedRecordFor({ table: 'invoices', ids })

    expect(record.ids).toHaveLength(MOVED_ID_LIMIT)
    expect(record.truncated).toBe(false)
    expect(movedIdsAreComplete([record])).toBe(true)
  })

  it('says the trail is incomplete when any table was truncated', () => {
    const small = movedRecordFor({ table: 'payments', ids: ['a'] })
    const big = movedRecordFor({
      table: 'invoices',
      ids: Array.from({ length: MOVED_ID_LIMIT + 1 }, (_, i) => `id-${i}`),
    })

    expect(movedIdsAreComplete([small])).toBe(true)
    expect(movedIdsAreComplete([small, big])).toBe(false)
  })

  it('is complete for a merge that moved nothing', () => {
    expect(movedIdsAreComplete([])).toBe(true)
  })

  it('reduces to the tally the preview and the notice already speak in', () => {
    // One answer to "how many moved", not a second count computed elsewhere.
    const moved = [
      movedRecordFor({ table: 'invoices', ids: ['a', 'b'] }),
      movedRecordFor({ table: 'payments', ids: ['c'] }),
    ]

    expect(tallyOf(moved)).toEqual([
      { table: 'invoices', rows: 2 },
      { table: 'payments', rows: 1 },
    ])
  })
})

describe('the story core carries a written sentence', () => {
  it('surfaces a summary on its own rather than as a field', () => {
    const told = tell({
      action: 'party.merge',
      after: {
        summary: 'Absorbed Cascade Joinery Ltd, and 5 records with it.',
        reason: 'One business.',
        role: 'absorbed',
        side: 'customer',
      },
    })

    expect(told.summary).toBe('Absorbed Cascade Joinery Ltd, and 5 records with it.')
    expect(told.reason).toBe('One business.')
  })

  it('does not render the payload’s own filing as a change', () => {
    // Browser verification showed "Role nothing → absorbed" and "Side nothing
    // → customer" above the sentence somebody actually wanted.
    const told = tell({
      action: 'party.merge',
      after: { summary: 'Absorbed B.', reason: 'One business.', role: 'absorbed', side: 'customer' },
    })

    expect(told.changes.map((change) => change.key)).toEqual([])
  })

  it('is null for the events that write no sentence', () => {
    expect(tell({ action: 'customer.update', after: { name: 'New' } }).summary).toBeNull()
    expect(summaryFrom({ summary: '   ' })).toBeNull()
    expect(summaryFrom(null)).toBeNull()
  })
})
