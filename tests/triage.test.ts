import { describe, expect, it } from 'vitest'
import {
  byUrgency,
  triageFor,
  RUNGS,
  STALE_BACKLOG_DAYS,
  STALE_CHECK_DAYS,
  type ClientFacts,
  type Triage,
} from '@/modules/practice/triage'

/**
 * Which client needs somebody today (Phase 87).
 *
 * The judgement being tested is that concerns are ranked by **what happens if
 * you leave it until next week**, not compressed into a score — and two rules
 * this phase shares with the ones before it: a count without an age is not a
 * signal, and "never checked" is not "clean".
 */

const TODAY = new Date('2026-09-01T09:00:00.000Z')

function facts(overrides: Partial<ClientFacts> = {}): ClientFacts {
  return {
    awaitingReview: 0,
    oldestAwaiting: null,
    // Checked this morning, nothing wrong. The quiet baseline.
    integrity: { asOf: '2026-09-01', faults: 0, errors: 0 },
    deadJobs: 0,
    bouncedMail: 0,
    sending: null,
    ...overrides,
  }
}

/** `days` before TODAY, as `YYYY-MM-DD`. */
function ago(days: number): string {
  return new Date(Date.parse('2026-09-01T00:00:00Z') - days * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

describe('a quiet client', () => {
  it('is clear, and says nothing at all', () => {
    const triage = triageFor(facts(), TODAY)

    expect(triage.rung).toBe('clear')
    expect(triage.headline).toBeNull()
    expect(triage.others).toBe(0)
  })
})

describe('the ladder', () => {
  /**
   * Leave it until next week and something gets filed that is not true.
   * Nothing outranks it.
   */
  it('puts books that disagree with themselves above everything', () => {
    const triage = triageFor(
      facts({
        integrity: { asOf: '2026-09-01', faults: 1, errors: 0 },
        awaitingReview: 400,
        oldestAwaiting: ago(200),
        deadJobs: 9,
        sending: { level: 'urgent', worsening: true },
      }),
      TODAY,
    )

    expect(triage.rung).toBe('wrong')
    expect(triage.headline).toBe('1 check disagrees with the ledger')
    // Everything else is still counted, so the row can say there is more.
    expect(triage.others).toBe(3)
  })

  /**
   * ADR 0084's argument: a sending reputation is the one failure here that
   * costs more the longer nobody acts, because the provider is scoring the
   * sender the whole time. A dead job is still there tomorrow, unchanged.
   */
  it('puts what is getting worse above what is merely stuck', () => {
    const triage = triageFor(
      facts({ deadJobs: 5, sending: { level: 'watch', worsening: false } }),
      TODAY,
    )

    expect(triage.rung).toBe('spending')
    expect(triage.headline).toBe('Marketing email is bouncing more than it should')
    expect(triage.others).toBe(1)
  })

  it('puts work the machine gave up on above work waiting for a person', () => {
    const triage = triageFor(
      facts({ deadJobs: 1, bouncedMail: 2, awaitingReview: 90, oldestAwaiting: ago(3) }),
      TODAY,
    )

    expect(triage.rung).toBe('stuck')
    expect(triage.headline).toBe('1 job and 2 letters gave up')
  })

  it('treats a backlog as the normal state of bookkeeping', () => {
    const triage = triageFor(facts({ awaitingReview: 40, oldestAwaiting: ago(3) }), TODAY)

    expect(triage.rung).toBe('waiting')
    expect(triage.headline).toBe('40 waiting to be categorized')
  })

  it('has no rung the ladder does not name', () => {
    // The array is the ordering; a rung added without a place in it would sort
    // to the front by accident.
    expect(new Set(RUNGS).size).toBe(RUNGS.length)
    expect(RUNGS[0]).toBe('wrong')
    expect(RUNGS[RUNGS.length - 1]).toBe('clear')
  })
})

/**
 * Forty transactions is Tuesday. Forty transactions whose oldest is from June
 * is a client nobody is serving, and the count alone cannot tell you which.
 */
describe('a count without an age is not a signal', () => {
  it('says how old the backlog is once it has stopped being this week’s work', () => {
    const triage = triageFor(
      facts({ awaitingReview: 40, oldestAwaiting: ago(STALE_BACKLOG_DAYS) }),
      TODAY,
    )

    expect(triage.headline).toBe(`40 waiting, oldest ${STALE_BACKLOG_DAYS} days`)
  })

  it('ranks a small old backlog above a large fresh one', () => {
    const stale = {
      companyName: 'Aardvark Ltd',
      triage: triageFor(facts({ awaitingReview: 6, oldestAwaiting: ago(120) }), TODAY),
    }
    const fresh = {
      companyName: 'Beacon Ltd',
      triage: triageFor(facts({ awaitingReview: 600, oldestAwaiting: ago(1) }), TODAY),
    }

    expect([fresh, stale].sort(byUrgency)[0].companyName).toBe('Aardvark Ltd')
  })
})

/**
 * The rule Phase 84 drew with `null` rather than `ok`, and Phase 86 drew
 * between "we do not know yet" and "it is steady". A roster showing a green
 * tick for a company nobody has examined would be lying quietly, at scale.
 */
describe('never checked is not clean', () => {
  it('does not call a company nobody has looked at clear', () => {
    const triage = triageFor(facts({ integrity: null }), TODAY)

    expect(triage.rung).toBe('unchecked')
    expect(triage.headline).toBe('The books have never been checked')
  })

  it('notices when the nightly check stopped running', () => {
    const triage = triageFor(
      facts({ integrity: { asOf: ago(STALE_CHECK_DAYS), faults: 0, errors: 0 } }),
      TODAY,
    )

    expect(triage.rung).toBe('unchecked')
    expect(triage.headline).toBe(`Last checked ${STALE_CHECK_DAYS} days ago`)
  })

  it('is still quiet next to a real backlog', () => {
    // Unchecked ranks below waiting: not knowing is worse news than a clean
    // bill of health, and still less urgent than work sitting there.
    const triage = triageFor(
      facts({ integrity: null, awaitingReview: 5, oldestAwaiting: ago(2) }),
      TODAY,
    )

    expect(triage.rung).toBe('waiting')
    expect(triage.others).toBe(1)
  })

  /** A check that threw is an admission, not an assertion. */
  it('treats a check that could not run as unchecked, never as passed', () => {
    const triage = triageFor(
      facts({ integrity: { asOf: '2026-09-01', faults: 0, errors: 2 } }),
      TODAY,
    )

    expect(triage.rung).toBe('unchecked')
    expect(triage.headline).toBe('2 checks could not run')
  })
})

describe('a rate that is fine and heading the wrong way', () => {
  it('is worth a line, which is the whole point of keeping a history', () => {
    const triage = triageFor(
      facts({ sending: { level: 'ok', worsening: true } }),
      TODAY,
    )

    expect(triage.rung).toBe('spending')
    expect(triage.headline).toBe('Marketing email is still fine and getting worse')
  })

  it('says nothing about sending that is fine and steady', () => {
    const triage = triageFor(facts({ sending: { level: 'ok', worsening: false } }), TODAY)

    expect(triage.rung).toBe('clear')
  })
})

describe('the roster order', () => {
  function client(companyName: string, triage: Triage) {
    return { companyName, triage }
  }

  it('is worst first', () => {
    const rows = [
      client('Quiet Ltd', triageFor(facts(), TODAY)),
      client('Backlog Ltd', triageFor(facts({ awaitingReview: 5, oldestAwaiting: ago(1) }), TODAY)),
      client(
        'Broken Ltd',
        triageFor(facts({ integrity: { asOf: '2026-09-01', faults: 2, errors: 0 } }), TODAY),
      ),
      client('Dead Ltd', triageFor(facts({ deadJobs: 3 }), TODAY)),
    ].sort(byUrgency)

    expect(rows.map((row) => row.companyName)).toEqual([
      'Broken Ltd',
      'Dead Ltd',
      'Backlog Ltd',
      'Quiet Ltd',
    ])
  })

  /**
   * A roster that reshuffled itself between page loads for no reason a reader
   * could see would be worse than one that never sorted at all.
   */
  it('falls back to alphabetical when two clients are equally urgent', () => {
    const rows = [
      client('Zephyr Ltd', triageFor(facts({ deadJobs: 2 }), TODAY)),
      client('Alpha Ltd', triageFor(facts({ deadJobs: 2 }), TODAY)),
    ].sort(byUrgency)

    expect(rows.map((row) => row.companyName)).toEqual(['Alpha Ltd', 'Zephyr Ltd'])
  })
})
