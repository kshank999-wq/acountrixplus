import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db'
import { projects } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { installDefaultCostCodes } from '@/modules/jobs/cost-codes'
import {
  priceApplication,
  setScheduleOfValues,
  type DraftApplication,
} from '@/modules/jobs/billing'
import type { PricedApplication } from '@/modules/jobs/application'

/**
 * What `priceApplication` returns once it is wired.
 *
 * Spelled out rather than cast away, because the gap between this and
 * `DraftApplication` **is** the outstanding work: when the service prices
 * through the core, `problems` comes with it and this alias collapses to
 * `DraftApplication`. A bare `as any` would have compiled and said nothing.
 */
type WiredDraft = DraftApplication & Pick<PricedApplication, 'problems'>
// Phase 151 wired it, so `DraftApplication` carries `problems` itself and this
// alias has collapsed to `DraftApplication` — which is exactly what it said
// would happen. Kept as the record of what the gap was.

/**
 * A preview that matches the post (Phase 146).
 *
 * ## Unskipped by Phase 151, which wired it
 *
 * `priceApplication` prices through `priceApplicationLines` now and returns its
 * problems; `createProgressBilling` is where the refusal moved to.
 *
 * ## What it asserts, and what it cannot
 *
 * It asserts the **service** half: that pricing an application reports every
 * problem rather than throwing on the first, so a screen calling it has
 * something to render on each row.
 *
 * It cannot assert the screen half. `BillingPanel` is a React component and this
 * suite has no browser; what keeps that side honest is
 * `tests/application-preview.test.ts`, which holds a transcription of the
 * panel's own `useMemo` against the core and fails when they disagree. Saying so
 * here rather than writing an assertion that only looks like one is ADR 0139's
 * rule: a test that cannot fail for the right reason is fiction.
 */

let ctx: Awaited<ReturnType<typeof createCompanyFixture>>['ctx']
let projectId: string
let itemIds: string[]

beforeEach(async () => {
  const fixture = await createCompanyFixture({ industry: 'construction' })
  await installDefaultCostCodes(fixture.ctx)
  ctx = fixture.ctx

  const [job] = await db
    .insert(projects)
    .values({
      companyId: fixture.companyId,
      code: 'JOB-1001',
      name: 'Mill Street',
      contractValueCents: 1_500_000,
      startDate: '2026-01-05',
    })
    .returning()
  projectId = job.id

  const revenue = await fixture.account('4200')

  const items = await setScheduleOfValues(ctx, projectId, [
    {
      itemNumber: '01',
      description: 'Groundworks',
      scheduledValueCents: 1_000_000,
      chartAccountId: revenue.id,
    },
    {
      itemNumber: '02',
      description: 'Frame',
      scheduledValueCents: 500_000,
      chartAccountId: revenue.id,
    },
  ])
  itemIds = items.map((item) => item.id)
})

describe('pricing an application with more than one thing wrong', () => {
  it('reports every problem instead of throwing on the first', async () => {
    // The change that makes the function usable as a preview. Today this
    // throws a Refusal naming item 01 and says nothing about item 02.
    const draft = (await priceApplication(ctx, {
      projectId,
      retainagePercentBp: 1_000,
      lines: [
        { scheduleOfValuesId: itemIds[0], percentCompleteBp: 12_000 },
        { scheduleOfValuesId: itemIds[1], percentCompleteBp: 11_000 },
      ],
    })) as WiredDraft

    expect(draft.problems.map((problem) => problem.itemNumber)).toEqual(['01', '02'])
  })

  it('still prices the lines that are sound, so a preview has a figure', async () => {
    const draft = (await priceApplication(ctx, {
      projectId,
      retainagePercentBp: 1_000,
      lines: [
        { scheduleOfValuesId: itemIds[0], percentCompleteBp: 12_000 },
        { scheduleOfValuesId: itemIds[1], percentCompleteBp: 5_000 },
      ],
    })) as WiredDraft

    expect(draft.lines.map((line) => line.itemNumber)).toEqual(['02'])
    expect(draft.thisPeriodCents).toBe(250_000)
  })
})

describe('an application with nothing wrong', () => {
  it('prices exactly as it always has', async () => {
    // What must not move. Every application anybody has filed correctly gets
    // the same three figures as before, which is the assertion that keeps the
    // repair from being a change to what people are billed.
    const draft = (await priceApplication(ctx, {
      projectId,
      retainagePercentBp: 1_000,
      lines: [
        { scheduleOfValuesId: itemIds[0], percentCompleteBp: 6_000 },
        { scheduleOfValuesId: itemIds[1], percentCompleteBp: 7_000 },
      ],
    })) as WiredDraft

    expect(draft.problems).toEqual([])
    expect(draft.thisPeriodCents).toBe(600_000 + 350_000)
    expect(draft.retainedCents).toBe(95_000)
    expect(draft.netDueCents).toBe(855_000)
  })
})
