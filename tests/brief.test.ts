import { describe, expect, it } from 'vitest'
import { briefFor, NAMED_LIMIT, type BriefClient } from '@/modules/practice/brief'
import { triageFor, type Rung } from '@/modules/practice/triage'

/**
 * The firm's morning brief (Phase 88).
 *
 * The judgement under test is **news, not state**. Phase 87 can already say
 * what most needs somebody at every client; sending that every morning would
 * be a message that says the same thing every day, which is a message nobody
 * reads — the same failure ADR 0024 named, by a slower route.
 */

const TODAY = new Date('2026-09-02T07:00:00.000Z')

/** A client whose triage lands on a chosen rung, built from real facts. */
function client(companyName: string, rung: Rung): BriefClient {
  const facts = {
    awaitingReview: 0,
    oldestAwaiting: null as string | null,
    integrity: { asOf: '2026-09-02', faults: 0, errors: 0 },
    deadJobs: 0,
    bouncedMail: 0,
    sending: null as { level: 'ok' | 'watch' | 'urgent'; worsening: boolean } | null,
  }

  if (rung === 'wrong') facts.integrity = { asOf: '2026-09-02', faults: 1, errors: 0 }
  if (rung === 'spending') facts.sending = { level: 'urgent', worsening: false }
  if (rung === 'stuck') facts.deadJobs = 1
  if (rung === 'waiting') {
    facts.awaitingReview = 12
    facts.oldestAwaiting = '2026-09-01'
  }
  if (rung === 'unchecked') facts.integrity = null as never

  const triage = triageFor(facts, TODAY)
  expect(triage.rung).toBe(rung)

  return { companyId: `id-${companyName}`, companyName, triage }
}

function said(entries: Array<[string, Rung]>): Map<string, Rung> {
  return new Map(entries.map(([name, rung]) => [`id-${name}`, rung]))
}

describe('nothing new means nothing at all', () => {
  it('says nothing when every client is where it was', () => {
    const brief = briefFor(
      [client('Alpha Ltd', 'wrong'), client('Beta Ltd', 'stuck')],
      said([
        ['Alpha Ltd', 'wrong'],
        ['Beta Ltd', 'stuck'],
      ]),
    )

    // The firm already knows. The roster is there when they want to look.
    expect(brief).toBeNull()
  })

  it('says nothing when a firm has no clients', () => {
    expect(briefFor([], new Map())).toBeNull()
  })

  it('says nothing about a client that got better', () => {
    const brief = briefFor([client('Alpha Ltd', 'waiting')], said([['Alpha Ltd', 'wrong']]))

    // A firm does not need waking to be told something improved.
    expect(brief).toBeNull()
  })

  /**
   * The memory has to hold the recovery even though nothing was said about it,
   * or the relapse below cannot be told from a standing problem.
   */
  it('still records where a client that got better ended up', () => {
    const brief = briefFor(
      [client('Alpha Ltd', 'waiting'), client('Beta Ltd', 'wrong')],
      said([
        ['Alpha Ltd', 'wrong'],
        ['Beta Ltd', 'stuck'],
      ]),
    )!

    expect(brief.lines.map((line) => line.companyName)).toEqual(['Beta Ltd'])
    expect(brief.observed).toEqual([
      { companyId: 'id-Alpha Ltd', rung: 'waiting' },
      { companyId: 'id-Beta Ltd', rung: 'wrong' },
    ])
  })
})

describe('a client that got worse', () => {
  it('is news, and says what it is now', () => {
    const brief = briefFor([client('Alpha Ltd', 'wrong')], said([['Alpha Ltd', 'waiting']]))!

    expect(brief.lines).toHaveLength(1)
    expect(brief.lines[0].from).toBe('waiting')
    expect(brief.lines[0].rung).toBe('wrong')
    expect(brief.lines[0].headline).toBe('1 check disagrees with the ledger')
    expect(brief.subject).toBe('Alpha Ltd needs a look')
  })

  /**
   * Each step is a thing that changed, so each is worth one line — this is
   * `newlyBroken`'s rule read forwards rather than a once-and-never-again.
   */
  it('is news again on every step of a slide', () => {
    const first = briefFor([client('Alpha Ltd', 'stuck')], said([['Alpha Ltd', 'waiting']]))
    const second = briefFor([client('Alpha Ltd', 'wrong')], said([['Alpha Ltd', 'stuck']]))

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second!.lines[0].from).toBe('stuck')
  })

  it('is news again after a recovery', () => {
    const brief = briefFor([client('Alpha Ltd', 'wrong')], said([['Alpha Ltd', 'waiting']]))

    expect(brief).not.toBeNull()
  })
})

/**
 * A firm that has just taken a client on should be told what is wrong with
 * those books — the answer `newlyBroken` gives for a first run.
 */
describe('the first time a client is seen', () => {
  it('reports whatever is wrong with it', () => {
    const brief = briefFor([client('New Ltd', 'stuck')], new Map())!

    expect(brief.lines[0].from).toBeNull()
    expect(brief.lines[0].companyName).toBe('New Ltd')
  })

  it('says nothing about one that arrives clear', () => {
    expect(briefFor([client('New Ltd', 'clear')], new Map())).toBeNull()
  })

  /** Not knowing is worth a first-morning mention; it is why nobody has run a check. */
  it('mentions one that arrives unchecked', () => {
    const brief = briefFor([client('New Ltd', 'unchecked')], new Map())!

    expect(brief.lines[0].headline).toBe('The books have never been checked')
  })
})

describe('what the brief says out loud', () => {
  it('leads worst first', () => {
    const brief = briefFor(
      [client('Zebra Ltd', 'waiting'), client('Alpha Ltd', 'wrong')],
      new Map(),
    )!

    expect(brief.lines.map((line) => line.companyName)).toEqual(['Alpha Ltd', 'Zebra Ltd'])
    expect(brief.subject).toBe('2 clients need a look')
  })

  /** A list of forty names is not a message. Three and a count is. */
  it('names a few and counts the rest', () => {
    const many = ['A Ltd', 'B Ltd', 'C Ltd', 'D Ltd', 'E Ltd'].map((name) =>
      client(name, 'stuck'),
    )

    const brief = briefFor(many, new Map())!

    expect(brief.body[0]).toBe('A Ltd, B Ltd and C Ltd and 2 more changed since we last wrote.')
    expect(NAMED_LIMIT).toBe(3)
    // Every one of them still gets its own line below the summary.
    expect(brief.lines).toHaveLength(5)
  })

  it('reads as one sentence when only one client changed', () => {
    const brief = briefFor([client('Alpha Ltd', 'stuck')], new Map())!

    expect(brief.body[0]).toBe('Alpha Ltd changed since we last wrote.')
  })

  /**
   * A reader seeing their first brief needs to know what the silence means;
   * one who has understood it does not need convincing again, so it is one
   * line at the bottom rather than a preamble.
   */
  it('says what its own silence means', () => {
    const brief = briefFor([client('Alpha Ltd', 'stuck')], new Map())!

    expect(brief.body[brief.body.length - 1]).toBe(
      'Nothing else has changed. This only arrives when something does.',
    )
  })
})
