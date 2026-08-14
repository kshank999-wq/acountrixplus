import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { bankConnections } from '@/db/schema'
import { syncConnection } from '@/modules/banking/sync'
import { registerHandler, type JobContext } from '../registry'

/**
 * Bank sync on a schedule (spec §18: "background worker/queue for **bank
 * sync**, document generation, campaign sends, and AI jobs").
 *
 * Sync has always been the first item on that list and the last thing to move.
 * Until now it ran inline on a button press, which ADR 0008 noted was starting
 * to matter — an import that posts journal entries is not a request somebody
 * should be holding a browser tab open for.
 *
 * ## Why this is safe to run twice
 *
 * Because Phase 1 made it so, and it has been tested since:
 * `importTransactions` deduplicates on the provider's transaction id with a
 * database unique constraint, so a sync that runs twice imports nothing the
 * second time. That property was built for retried button presses and it is
 * exactly what an at-least-once queue needs — which is the argument for
 * putting the idempotency in the service rather than in whatever calls it.
 */

registerHandler({
  kind: 'bank.sync_all',
  label: 'Sync every connected bank feed for a company',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const connections = await db
      .select({ id: bankConnections.id, institutionName: bankConnections.institutionName })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.companyId, actor.companyId),
          eq(bankConnections.status, 'active'),
        ),
      )

    let imported = 0
    let duplicates = 0
    const failures: Array<{ institution: string; reason: string }> = []

    for (const connection of connections) {
      try {
        const summary = await syncConnection(actor, connection.id)
        imported += summary.imported
        duplicates += summary.duplicates
      } catch (error) {
        // One institution being down must not stop the others. Collected and
        // returned rather than thrown, so the job succeeds with a visible
        // partial result instead of retrying every healthy feed to reach the
        // broken one.
        failures.push({
          institution: connection.institutionName,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      connections: connections.length,
      imported,
      duplicates,
      failures,
    }
  },
})
