import { registerHandler, type JobContext } from '../registry'
import { sweepAll } from '@/modules/retention/sweep'
import { assertCrossTenantSight } from '@/modules/tenancy/cross-tenant'

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

    /*
      Before sweeping, not after (Phase 163).

      This handler sums what it removed and returns `{ removed, byPolicy }`.
      Blinded by a tenant policy it returns `{ removed: 0, byPolicy: {} }` — which
      is exactly what it returns when there was genuinely nothing to remove — and
      the job is then recorded as **succeeded**. Retention stops working and the
      first symptom is tables growing that a policy says should not.

      No amount of care after the fact distinguishes those two, because the
      information is not in the result: zero rows and zero visible rows are the
      same number. It is in the catalogue, so that is what is asked.
    */
    await assertCrossTenantSight('retention/sweep:sweepAll')

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
