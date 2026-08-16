import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { memberships } from '@/db/schema'
import { hasPermission, type Permission, type Role } from '@/modules/permissions'
import { notify } from '@/modules/mobile/notifications'
import { openWork } from '@/modules/engagement/tasks'
import { moduleEnabled } from '@/modules/industry/modules'
import { runRent } from '@/modules/properties/billing'
import { registerHandler, type JobContext } from '../registry'

/**
 * The work that was promised (Phase 22, Phase 23).
 *
 * Both handlers here close a gap the phase that built the feature named in its
 * own ADR, and neither needed the feature changed:
 *
 * > **Nothing chases an overdue follow-up.** It surfaces when somebody opens
 * > the page. The Phase 10 queue and Phase 8's push channel both exist and
 * > neither is wired to this, so a task due Friday nudges nobody on Friday.
 * >
 * > **Nothing schedules the rent run.** It is a button. The queue is right
 * > there and the run is already idempotent — which is the hard half.
 *
 * "Which is the hard half" is the load-bearing sentence. A scheduled job that
 * can run twice is only safe because Phase 23 put the precondition in the
 * database, and Phase 22 did the same for closing a task. Scheduling arrives
 * last because it is the easy part, and it is the easy part only because the
 * safety was built first.
 */

/** Everyone in a company who holds a permission. */
async function recipientsWith(companyId: string, permission: Permission) {
  const rows = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.isActive, true)))

  return rows.filter((row) => hasPermission(row.role as Role, permission)).map((row) => row.userId)
}

/**
 * Chases follow-ups that are late.
 *
 * ## One message per person, not one per task
 *
 * Somebody with eleven late follow-ups gets one notification saying eleven,
 * not eleven notifications. The Phase 8 review nudge learned this the same
 * way — *a phone that buzzes on every imported coffee is a phone with
 * notifications switched off by the end of the week* — and a chaser that
 * becomes noise stops being a chaser.
 *
 * ## Unclaimed work goes to whoever can claim it
 *
 * A task nobody owns is everybody's problem (Phase 22, Decision 10), so the
 * people who could pick it up hear about it. Told separately from a person's
 * own overdue work, because "three of yours are late" and "two are late and
 * unclaimed" are different sentences and merging them produces a number
 * nobody can act on.
 */
registerHandler({
  kind: 'engagement.chase_overdue',
  label: 'Tell people about follow-ups that are late',
  handler: async (context: JobContext) => {
    const actor = context.actor!
    const asOf = String(context.payload.asOf ?? new Date().toISOString().slice(0, 10))

    const overdue = await openWork(actor, { asOf, overdueOnly: true, limit: 500 })
    if (overdue.length === 0) return { asOf, overdue: 0, sent: 0 }

    const mine = new Map<string, number>()
    let unclaimed = 0

    for (const task of overdue) {
      if (task.assignedTo) {
        mine.set(task.assignedTo, (mine.get(task.assignedTo) ?? 0) + 1)
      } else {
        unclaimed += 1
      }
    }

    let sent = 0
    let suppressed = 0

    for (const [userId, count] of mine) {
      const result = await notify({
        companyId: actor.companyId,
        userId,
        topic: 'follow_up_due',
        message: {
          title: count === 1 ? 'A follow-up is late' : `${count} follow-ups are late`,
          body:
            count === 1
              ? overdue.find((task) => task.assignedTo === userId)?.title ?? 'One is past its date.'
              : 'They are past their dates.',
          url: '/crm/work',
          // Replaces yesterday's rather than stacking beside it. A phone with
          // six days of identical chasers is a phone somebody silences.
          tag: 'follow-up-due',
        },
      })

      sent += result.sent
      if (result.suppressed) suppressed += 1
    }

    if (unclaimed > 0) {
      for (const userId of await recipientsWith(actor.companyId, 'crm:manage')) {
        const result = await notify({
          companyId: actor.companyId,
          userId,
          topic: 'follow_up_due',
          message: {
            title: `${unclaimed} late follow-up${unclaimed === 1 ? '' : 's'} with nobody's name on`,
            body: 'Nobody has claimed them, which means nobody is doing them.',
            url: '/crm/work',
            tag: 'follow-up-unclaimed',
          },
        })

        sent += result.sent
        if (result.suppressed) suppressed += 1
      }
    }

    return { asOf, overdue: overdue.length, unclaimed, people: mine.size, sent, suppressed }
  },
})

/**
 * The monthly rent run (Phase 23).
 *
 * Skips rather than throws when the module is off. `runRent` calls
 * `requireModule` and would raise `ModuleDisabledError`, which is right for a
 * person clicking a button and wrong here: this schedule is installed for
 * every company, and a company that lets no property would dead-letter a job
 * every month for ever and fill the operations page with a failure that is not
 * one.
 *
 * Running twice bills once — the unique index on `(lease_id, period_start)`
 * decides, not this handler. That is what makes it safe to retry.
 */
registerHandler({
  kind: 'properties.run_rent',
  label: 'Raise this month’s rent invoices',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    if (!(await moduleEnabled(actor.companyId, 'properties'))) {
      return { skipped: 'The properties module is switched off.' }
    }

    const month = String(
      context.payload.month ?? `${new Date().toISOString().slice(0, 7)}-01`,
    )

    const result = await runRent(actor, { month })

    return {
      month: result.period.periodStart,
      invoicesRaised: result.invoicesRaised,
      totalCents: result.totalCents,
    }
  },
})
