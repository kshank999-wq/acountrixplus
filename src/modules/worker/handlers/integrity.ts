import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { memberships } from '@/db/schema'
import { hasPermission, type Role } from '@/modules/permissions'
import { notify } from '@/modules/mobile/notifications'
import { formatCents } from '@/lib/money'
import { newlyBroken, runIntegrityChecks } from '@/modules/integrity/service'
import { registerHandler, type JobContext } from '../registry'

/**
 * The nightly books check (spec §19).
 *
 * ## What this closes
 *
 * Eleven phases each wrote a reconciliation and each surfaced it on a page.
 * Measured before this phase: **nine reconciliation functions across nine
 * modules, and not one of the seventeen scheduled job kinds ran any of them.**
 * ADR 0031 and ADR 0032 both listed running one of them nightly as a
 * follow-up, which by the rule Phase 31 learned means it was not a feature
 * request.
 *
 * A check nobody runs is not a check. This is the thing that runs them.
 *
 * ## Silent when there is nothing new
 *
 * The same rule as `ops.failure_digest`, and it matters more here. A drift is
 * *persistent* by nature — a stock difference from a bad import in March is
 * still there in April — so a digest that reported everything wrong tonight
 * would send the same message every night until somebody fixed it, and the
 * predictable result is that the message stops being read at about the point
 * a second, different drift appears.
 *
 * So: notify about what broke **since last night**, and say nothing otherwise.
 * The full picture is on the operations page for anybody who wants it. What
 * arrives on a phone is news.
 *
 * The run itself is always written down even when nothing is sent, because
 * "no findings" and "the job stopped firing three weeks ago" have to be
 * distinguishable — which is this phase's whole argument, one level up.
 */
registerHandler({
  kind: 'books.integrity_check',
  label: 'Check that the books still agree with themselves',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    const asOf = context.payload.asOf ? String(context.payload.asOf) : undefined
    const run = await runIntegrityChecks(actor, { asOf })
    const news = await newlyBroken(actor, run)

    const summary = {
      runId: run.id,
      asOf: run.asOf,
      checksRun: run.checksRun,
      checksSkipped: run.checksSkipped,
      faults: run.faults,
      errors: run.errors,
    }

    // Nothing new. The run is on the record; the phone stays quiet.
    if (news.length === 0) {
      return { ...summary, newlyBroken: 0, sent: 0 }
    }

    const rows = await db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.isActive, true)))

    // `reports:financial` rather than `company:manage`: the person who needs to
    // know the stock ledger has drifted is whoever reads the balance sheet,
    // which is not necessarily whoever administers the account.
    const recipients = rows
      .filter((row) => hasPermission(row.role as Role, 'reports:financial'))
      .map((row) => row.userId)

    const title =
      news.length === 1
        ? news[0].label
        : `${news.length} checks stopped agreeing`

    let sent = 0
    let suppressed = 0

    for (const userId of recipients) {
      const result = await notify({
        companyId: actor.companyId,
        userId,
        topic: 'books_disagree',
        message: {
          title,
          // One real difference rather than a tally, for the reason the failure
          // digest leads with one real error: somebody reading this on a phone
          // is deciding whether to open a laptop, and a number does not help
          // them decide while an amount does.
          body: bodyFor(news[0]),
          url: '/settings/operations',
          tag: 'integrity',
        },
      })

      sent += result.sent
      if (result.suppressed) suppressed += 1
    }

    return { ...summary, newlyBroken: news.length, sent, suppressed }
  },
})

/** What one broken check reads like in a notification. */
function bodyFor(finding: {
  label: string
  differenceCents: number
  detail: string | null
  error: string | null
}): string {
  if (finding.error) {
    return `The check itself did not finish: ${finding.error}`
  }

  const amount = formatCents(Math.abs(finding.differenceCents))
  return finding.detail ? `${amount} apart — ${finding.detail}` : `${amount} apart.`
}
