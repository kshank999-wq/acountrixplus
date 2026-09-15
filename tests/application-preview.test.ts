import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  priceApplicationLines,
  willPost,
  type ProgressEntry,
  type ScheduleItem,
} from '@/modules/jobs/application'

/**
 * The preview that promised what the post refuses (Phase 146).
 *
 * No database, no clock.
 */

const PANEL = 'src/app/jobs/[id]/panels.tsx'
const SERVICE = 'src/modules/jobs/billing.ts'

/**
 * `BillingPanel`'s preview as it stands today, kept to prove the difference —
 * the device Phase 140 used for the broken symbol reader.
 *
 * Transcribed from the `useMemo`: the percent is read from a text field, the
 * per-item amount is clamped at zero, and retainage is applied to the clamped
 * total. There is no bound on either percent.
 */
function screenPreview(
  items: readonly ScheduleItem[],
  typed: Record<string, string>,
  retainagePercent: string,
): { thisPeriod: number; retained: number; net: number } {
  const thisPeriod = items.reduce((sum, item) => {
    const raw = typed[item.id]
    if (raw === undefined || raw.trim() === '') return sum
    const bp = Math.round(Number(raw) * 100)
    if (!Number.isFinite(bp)) return sum
    const completed = Math.round((item.scheduledValueCents * bp) / 10_000)
    return sum + Math.max(0, completed - item.previouslyBilledCents)
  }, 0)

  const bp = Math.round(Number(retainagePercent || '0') * 100)
  const retained = Math.round((thisPeriod * (Number.isFinite(bp) ? bp : 0)) / 10_000)
  return { thisPeriod, retained, net: thisPeriod - retained }
}

const ITEMS: ScheduleItem[] = [
  { id: 'a', itemNumber: '01', scheduledValueCents: 1_000_000, previouslyBilledCents: 400_000 },
  { id: 'b', itemNumber: '02', scheduledValueCents: 500_000, previouslyBilledCents: 250_000 },
]

const at = (percents: Record<string, number>): ProgressEntry[] =>
  Object.entries(percents).map(([scheduleOfValuesId, percent]) => ({
    scheduleOfValuesId,
    percentCompleteBp: Math.round(percent * 100),
  }))

describe('what an application bills when nothing is wrong', () => {
  it('agrees with the screen, which is why this went unnoticed', () => {
    // The ordinary case, and the reason two rules could sit side by side for
    // this long: on every application anybody has actually filed correctly,
    // the screen and the service produce the same three figures.
    const priced = priceApplicationLines(ITEMS, at({ a: 60, b: 70 }), 1_000)
    const preview = screenPreview(ITEMS, { a: '60', b: '70' }, '10')

    expect(willPost(priced)).toBe(true)
    expect(priced.thisPeriodCents).toBe(preview.thisPeriod)
    expect(priced.retainedCents).toBe(preview.retained)
    expect(priced.netDueCents).toBe(preview.net)

    // 60% of $10,000 is $6,000, less the $4,000 already billed.
    expect(priced.thisPeriodCents).toBe(200_000 + 100_000)
    expect(priced.retainedCents).toBe(30_000)
    expect(priced.netDueCents).toBe(270_000)
  })

  it('rounds retainage once on the total, not once per line', () => {
    // True here, unlike the sales tax comment Phase 145 found — and asserted
    // rather than trusted, which is the difference.
    // The same three amounts Phase 145 found the sales tax drifting on, since
    // whether a set of parts drifts is a property of the numbers rather than
    // of what they are being charged for.
    const items: ScheduleItem[] = [
      { id: 'a', itemNumber: '01', scheduledValueCents: 1_000, previouslyBilledCents: 0 },
      { id: 'b', itemNumber: '02', scheduledValueCents: 2_000, previouslyBilledCents: 0 },
      { id: 'c', itemNumber: '03', scheduledValueCents: 3_333, previouslyBilledCents: 0 },
    ]
    const priced = priceApplicationLines(items, at({ a: 100, b: 100, c: 100 }), 825)

    const perLine = priced.lines.reduce(
      (sum, line) => sum + Math.round((line.thisPeriodCents * 825) / 10_000),
      0,
    )

    expect(priced.thisPeriodCents).toBe(6_333)
    expect(priced.retainedCents).toBe(Math.round((priced.thisPeriodCents * 825) / 10_000))
    expect(priced.retainedCents).toBe(522)
    expect(perLine).toBe(523)
  })
})

describe('the four places the preview and the post disagree', () => {
  it('shows a total for a line the service will refuse outright', () => {
    // **The assertion the phase exists for.** Item 02 is dropped from 50% to
    // 20% when $2,500 of it has already been billed. The screen clamps that
    // line to zero and shows $2,000 — which is what item 01 comes to on its
    // own — and the service refuses the whole application.
    const priced = priceApplicationLines(ITEMS, at({ a: 60, b: 20 }), 1_000)
    const preview = screenPreview(ITEMS, { a: '60', b: '20' }, '10')

    expect(preview.thisPeriod).toBe(200_000)
    expect(willPost(priced)).toBe(false)
    expect(priced.problems.map((problem) => problem.itemNumber)).toEqual(['02'])
    expect(priced.problems[0].why).toMatch(/cannot go backwards/)
  })

  it('bills past the scheduled value where the service refuses', () => {
    const entries = at({ a: 120 })
    const priced = priceApplicationLines(ITEMS, entries, 1_000)
    const preview = screenPreview(ITEMS, { a: '120' }, '10')

    // The screen happily previews $8,000 of a $10,000 item that is only
    // $10,000 in total and already $4,000 billed.
    expect(preview.thisPeriod).toBe(800_000)
    expect(willPost(priced)).toBe(false)
    expect(priced.problems[0].why).toMatch(/percent complete must be between 0% and 100%/)
  })

  it('accepts a percent the service bounds', () => {
    // 100.5% is not a typo somebody can see. It previews a figure and is
    // refused on the server, and the two refusals differ in which one arrives
    // before the click.
    const priced = priceApplicationLines(ITEMS, at({ a: 100.5 }), 1_000)
    const preview = screenPreview(ITEMS, { a: '100.5' }, '10')

    expect(preview.thisPeriod).toBeGreaterThan(0)
    expect(willPost(priced)).toBe(false)
  })

  it('accepts a retainage the service bounds', () => {
    const priced = priceApplicationLines(ITEMS, at({ a: 60 }), 12_000)
    const preview = screenPreview(ITEMS, { a: '60' }, '120')

    // The screen retains more than the application is worth and shows a
    // negative net due.
    expect(preview.net).toBeLessThan(0)
    expect(willPost(priced)).toBe(false)
    expect(priced.problems.map((problem) => problem.why)).toContain(
      'Retainage must be between 0% and 100%.',
    )
    // And nothing is retained against an application that will not post.
    expect(priced.retainedCents).toBe(0)
  })
})

describe('what a preview has to be able to say', () => {
  it('reports every problem at once, not the first one', () => {
    // Why wiring the screen to `priceApplication` would not have been enough:
    // it throws, so a person fixing twelve items would meet one refusal per
    // click. Three faults, three sentences, one pass.
    const items: ScheduleItem[] = [
      ...ITEMS,
      { id: 'c', itemNumber: '03', scheduledValueCents: 200_000, previouslyBilledCents: 0 },
    ]
    const priced = priceApplicationLines(items, at({ a: 120, b: 20, c: 50 }), 1_000)

    expect(priced.problems).toHaveLength(2)
    expect(priced.problems.map((problem) => problem.itemNumber)).toEqual(['01', '02'])

    // The sound line is still priced, so the preview has something to show.
    expect(priced.lines.map((line) => line.itemNumber)).toEqual(['03'])
    expect(priced.thisPeriodCents).toBe(100_000)
  })

  it('puts each sentence against the row it belongs to', () => {
    // Phase 119: a refusal somebody can act on. The item number is a field
    // rather than only a phrase inside the sentence, so a screen can render it
    // on the line instead of in a list at the bottom.
    const priced = priceApplicationLines(ITEMS, at({ b: 20 }), 1_000)

    expect(priced.problems[0].scheduleOfValuesId).toBe('b')
    expect(priced.problems[0].itemNumber).toBe('02')
  })

  it('refuses an item that is not on the job', () => {
    const priced = priceApplicationLines(ITEMS, at({ zzz: 50 }), 1_000)

    expect(willPost(priced)).toBe(false)
    expect(priced.problems[0].why).toBe('That contract item is not on this job.')
  })

  it('prices an amount stated directly, which the service also allows', () => {
    const priced = priceApplicationLines(
      ITEMS,
      [{ scheduleOfValuesId: 'a', thisPeriodCents: 150_000 }],
      1_000,
    )

    expect(willPost(priced)).toBe(true)
    expect(priced.thisPeriodCents).toBe(150_000)
    expect(priced.lines[0].completedToDateCents).toBe(550_000)
  })

  it('says nothing about an application with no lines', () => {
    const priced = priceApplicationLines(ITEMS, [], 1_000)

    expect(willPost(priced)).toBe(true)
    expect(priced).toMatchObject({ thisPeriodCents: 0, retainedCents: 0, netDueCents: 0 })
  })
})

describe('the sentences this moved', () => {
  it('uses the ones the service already shows people', () => {
    // Moved rather than restated. If the service's wording changes and this
    // does not, somebody meets two different sentences for one refusal — which
    // is the fault this module exists to end, reappearing in the prose.
    const service = readFileSync(SERVICE, 'utf8')

    for (const sentence of [
      'percent complete must be between 0% and 100%.',
      'Completion cannot go backwards on an application; raise a credit instead.',
      'would be billed beyond its scheduled value. Approve a change order first.',
      'Retainage must be between 0% and 100%.',
      'That contract item is not on this job.',
    ]) {
      expect(service.includes(sentence), sentence).toBe(true)
    }
  })

  it('is still not wired, and the screen still works it out for itself', () => {
    // The register says this is outstanding; this is what keeps that true.
    // When the wiring pass lands, both of these flip and the entry comes off
    // `PENDING_WIRING` — a stale entry being exactly what that register
    // refuses to hold.
    const panel = readFileSync(PANEL, 'utf8')

    expect(panel.includes('priceApplicationLines')).toBe(false)
    expect(panel.includes('Math.max(0, completed - item.billedCents)')).toBe(true)
    expect(readFileSync(SERVICE, 'utf8').includes('priceApplicationLines')).toBe(false)
  })
})
