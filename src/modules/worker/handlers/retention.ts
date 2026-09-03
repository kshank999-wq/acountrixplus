import { registerHandler, type JobContext } from '../registry'
import { sweepAll } from '@/modules/retention/sweep'

/**
 * Retention (spec §19).
 *
 * Global, and one job for every policy rather than a job each. They are ranged
 * deletes measured in milliseconds; splitting them would put a row a night per
 * policy on the operations page saying "0 removed" and bury the one night
 * something is worth reading.
 *
 * No count in that sentence, deliberately: it said "nine" for three phases
 * while the answer was ten (Phase 101).
 *
 * ## What this closes
 *
 * Four phases each left a retention job owed and each said so in the README:
 *
 * > **`login_attempts` is never pruned.** The table grows with every failed
 * > sign-in on the internet and an attacker controls that rate.
 * >
 * > **`action_tokens` is pruned on demand, never on a schedule.**
 * >
 * > **`sweepOrphanedBlobs` is not scheduled.** It exists and is safe to run at
 * > any time; the Phase 10 queue is right there and nothing calls it.
 *
 * None of them needed code written. They needed a policy that said how long,
 * and something to call them.
 */
registerHandler({
  kind: 'housekeeping.retention',
  label: 'Delete what the retention policy no longer keeps',
  global: true,
  handler: async (context: JobContext) => {
    // `asOf` from the payload rather than the clock, so a run can be replayed
    // for a date — and so a test can assert on one.
    const asOf = context.payload.asOf ? new Date(String(context.payload.asOf)) : new Date()

    const results = await sweepAll(asOf)
    const removed = results.reduce((sum, row) => sum + row.removed, 0)

    return {
      asOf: asOf.toISOString().slice(0, 10),
      removed,
      byPolicy: Object.fromEntries(
        results.filter((row) => row.removed > 0).map((row) => [row.kind, row.removed]),
      ),
    }
  },
})
