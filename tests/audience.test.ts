import { describe, expect, it } from 'vitest'
import {
  assertTopicBelongs,
  audienceOf,
  columnsFor,
  topicsFor,
  TOPIC_AUDIENCE,
  WrongAudienceError,
  type Audience,
} from '@/modules/mobile/audience'
import { notificationTopicEnum } from '@/db/schema'

/**
 * Who a notification preference belongs to (Phase 89).
 *
 * Phase 8's switch is keyed on `(user, company, topic)` with a non-null
 * company, because every notification this application sent belonged to a
 * company. Phase 88's firm brief belongs to a practice, so the one channel that
 * arrives unannounced in an inbox is the one with no switch — and the
 * machinery cannot be pointed at it, because there is nowhere to put the row.
 */

const COMPANY: Audience = { kind: 'company', companyId: 'c1' }
const PRACTICE: Audience = { kind: 'practice', practiceId: 'p1' }

describe('a preference names exactly one owner', () => {
  it('reads a company row as a company audience', () => {
    expect(audienceOf({ companyId: 'c1', practiceId: null })).toEqual(COMPANY)
  })

  it('reads a practice row as a practice audience', () => {
    expect(audienceOf({ companyId: null, practiceId: 'p1' })).toEqual(PRACTICE)
  })

  /**
   * A row naming two owners would be read by whichever query asked first, and
   * one naming none would be read by nobody. Both are programming errors, so
   * both are loud.
   */
  it('refuses a row that names two', () => {
    expect(() => audienceOf({ companyId: 'c1', practiceId: 'p1' })).toThrow(/one owner, not two/)
  })

  it('refuses a row that names none', () => {
    expect(() => audienceOf({ companyId: null, practiceId: null })).toThrow(/names an owner/)
  })

  it('round-trips through the columns it stores', () => {
    expect(audienceOf(columnsFor(COMPANY))).toEqual(COMPANY)
    expect(audienceOf(columnsFor(PRACTICE))).toEqual(PRACTICE)
    expect(columnsFor(PRACTICE).companyId).toBeNull()
  })
})

describe('a topic belongs to one kind of audience', () => {
  /**
   * A company topic stored against a practice is a preference nothing ever
   * reads — worse than no preference at all, because the person set it and
   * believes they are covered.
   */
  it('refuses a company topic set for a firm', () => {
    expect(() => assertTopicBelongs('invoice_paid', PRACTICE)).toThrow(WrongAudienceError)
    expect(() => assertTopicBelongs('invoice_paid', PRACTICE)).toThrow(
      /invoice_paid is a company topic/,
    )
  })

  it('refuses the firm brief set for a company', () => {
    expect(() => assertTopicBelongs('practice_brief', COMPANY)).toThrow(WrongAudienceError)
  })

  it('allows each where it belongs', () => {
    expect(() => assertTopicBelongs('invoice_paid', COMPANY)).not.toThrow()
    expect(() => assertTopicBelongs('practice_brief', PRACTICE)).not.toThrow()
  })

  /**
   * Listed exhaustively rather than defaulted, so the next topic added has to
   * make the choice deliberately instead of inheriting one.
   */
  it('has an answer for every topic the database knows', () => {
    for (const topic of notificationTopicEnum.enumValues) {
      expect(TOPIC_AUDIENCE[topic], `${topic} has no audience`).toBeDefined()
    }

    expect(Object.keys(TOPIC_AUDIENCE).sort()).toEqual(
      [...notificationTopicEnum.enumValues].sort(),
    )
  })

  it('splits the topics into the two settings screens', () => {
    const all = notificationTopicEnum.enumValues
    const company = topicsFor('company', all)
    const practice = topicsFor('practice', all)

    expect(practice).toEqual(['practice_brief'])
    expect(company).not.toContain('practice_brief')
    // Every topic lands on exactly one screen.
    expect(company.length + practice.length).toBe(all.length)
  })
})
