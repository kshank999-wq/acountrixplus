import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { journalEntries } from '@/db/schema'
import { formatCents } from '@/lib/money'
import { accountByNumber } from '@/modules/coa/service'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { draftJournalEntry } from '@/modules/ledger/journal'
import { wipSummary } from '@/modules/jobs/reports'
import { moduleEnabled } from '@/modules/industry/modules'
import { liabilityPositions } from '@/modules/payroll/remittance'
import { notify } from '@/modules/mobile/notifications'
import { memberships } from '@/db/schema'
import { hasPermission, type Role } from '@/modules/permissions'
import { registerHandler, type JobContext } from '../registry'

/**
 * Period-end work that a person still decides.
 *
 * Two handlers here, and the interesting thing about both is what they refuse
 * to do.
 */

/**
 * The WIP adjusting entry — proposed, never posted.
 *
 * ADR 0007 said this, and it still holds:
 *
 * > **WIP does not post its adjusting entry.** The schedule reports over- and
 * > under-billings; `1160` and `2560` install with the pack and stay empty
 * > until an accountant posts to them. Automating a period-end adjustment
 * > nobody reviewed is how a WIP schedule becomes a source of surprises.
 *
 * Having a worker did not change that judgement, and it would have been easy
 * to decide it had. The objection was never that the arithmetic was hard — it
 * is a subtraction the report already does. The objection was about **who
 * decides**, and a scheduler deciding is worse than a person deciding late.
 *
 * So this writes a **draft**: balanced, validated, numbered, and invisible to
 * every statement until an accountant opens it and posts it. The work is done;
 * the decision is not taken.
 */
registerHandler({
  kind: 'jobs.propose_wip_entry',
  label: 'Propose the WIP adjusting entry (as a draft)',
  handler: async (context: JobContext) => {
    const actor = context.actor!

    if (!(await moduleEnabled(actor.companyId, 'job_costing'))) {
      return { skipped: 'Job costing is not switched on for this company.' }
    }

    // The end of the *previous* month, not today. A period-end adjustment for
    // a period that has not ended is an adjustment against half a month of
    // costs — it would be wrong on the day it was proposed, and the schedule
    // fires on the 1st precisely so it has a closed month to work from.
    const asOfDate = String(context.payload.asOfDate ?? previousMonthEnd())
    const summary = await wipSummary(actor, { asOfDate })

    if (summary.costsInExcessCents === 0 && summary.billingsInExcessCents === 0) {
      return { skipped: 'Nothing over- or under-billed at this date.' }
    }

    // Already proposed for this date? A monthly schedule that fires twice
    // because a worker was restarted must not leave two drafts for an
    // accountant to reconcile against each other.
    const [existing] = await db
      .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, actor.companyId),
          eq(journalEntries.status, 'draft'),
          eq(journalEntries.sourceType, 'wip_adjustment'),
          eq(journalEntries.entryDate, asOfDate),
        ),
      )
      .limit(1)

    if (existing) {
      return { skipped: `Already proposed as entry ${existing.entryNumber}.` }
    }

    const [costsInExcess, billingsInExcess, contractRevenue] = await Promise.all([
      accountByNumber(actor.companyId, INDUSTRY_ACCOUNTS.costsInExcessOfBillings),
      accountByNumber(actor.companyId, INDUSTRY_ACCOUNTS.billingsInExcessOfCosts),
      accountByNumber(actor.companyId, '4200'),
    ])

    if (!costsInExcess || !billingsInExcess || !contractRevenue) {
      return {
        skipped:
          'This chart of accounts is missing 1160, 2560, or 4200 — the construction pack installs them.',
      }
    }

    // Underbilled work is an asset and overbilled work a liability; the
    // difference between them is revenue earned but not yet invoiced. One
    // entry, netting to that difference.
    const lines = []
    if (summary.costsInExcessCents > 0) {
      lines.push({
        chartAccountId: costsInExcess.id,
        debitCents: summary.costsInExcessCents,
        memo: 'Costs in excess of billings',
      })
    }
    if (summary.billingsInExcessCents > 0) {
      lines.push({
        chartAccountId: billingsInExcess.id,
        creditCents: summary.billingsInExcessCents,
        memo: 'Billings in excess of costs',
      })
    }

    const net = summary.costsInExcessCents - summary.billingsInExcessCents
    if (net > 0) {
      lines.push({ chartAccountId: contractRevenue.id, creditCents: net, memo: 'Revenue earned not billed' })
    } else if (net < 0) {
      lines.push({ chartAccountId: contractRevenue.id, debitCents: -net, memo: 'Revenue billed not earned' })
    }

    const entry = await draftJournalEntry(actor, {
      entryDate: asOfDate,
      memo: `WIP adjustment at ${asOfDate} — proposed, not posted. Review before posting.`,
      source: 'manual',
      sourceType: 'wip_adjustment',
      lines,
    })

    return {
      proposed: true,
      entryNumber: entry.entryNumber,
      totalCents: entry.totalCents,
      costsInExcessCents: summary.costsInExcessCents,
      billingsInExcessCents: summary.billingsInExcessCents,
    }
  },
})

/**
 * Tells somebody an agency is owed money.
 *
 * ADR 0009's follow-up called this "the one somebody would lose money over",
 * and unlike the WIP entry there is no decision being taken here — a reminder
 * is not an action. So this one really is just the missing clock.
 */
registerHandler({
  kind: 'payroll.remittance_due',
  label: 'Remind about unremitted payroll and sales tax',
  handler: async (context: JobContext) => {
    const actor = context.actor!
    const asOfDate = String(context.payload.asOfDate ?? today())

    const positions = await liabilityPositions(actor, { asOfDate })

    // Net Pay Payable is excluded deliberately: it sits outstanding between
    // posting payroll and paying people, which is normal and would make this
    // reminder fire every single month regardless. A reminder that is always
    // on is a reminder nobody reads.
    const owed = positions.filter(
      (entry) => entry.accountNumber !== '2350' && entry.balanceCents > 0,
    )

    if (owed.length === 0) return { skipped: 'Nothing owed to any agency.' }

    const total = owed.reduce((sum, entry) => sum + entry.balanceCents, 0)
    const detail = owed
      .map((entry) => `${entry.accountNumber} ${entry.accountName}: ${formatCents(entry.balanceCents)}`)
      .join(', ')

    const recipients = await db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.isActive, true)))

    let notified = 0

    for (const recipient of recipients) {
      if (!hasPermission(recipient.role as Role, 'tax:manage')) continue

      const result = await notify({
        companyId: actor.companyId,
        userId: recipient.userId,
        topic: 'remittance_due',
        message: {
          title: `${formatCents(total)} owed to agencies`,
          body: detail,
          url: '/payroll/liabilities',
        },
      })

      if (result.sent > 0) notified++
    }

    return { totalOwedCents: total, accounts: owed.length, notified }
  },
})

/**
 * Drafts that nobody has decided on.
 *
 * Read by the operations page and the accounting workspace. A proposal that
 * sits unreviewed for a quarter is its own kind of problem, and the only way
 * anybody finds out is if something counts them.
 */
export async function pendingDraftCount(companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        eq(journalEntries.status, 'draft'),
        isNull(journalEntries.postedAt),
      ),
    )

  return Number(row?.count ?? 0)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The last day of the month before this one, in UTC.
 *
 * Day 0 of the current month is the last day of the previous one, which also
 * gets February right without a table of month lengths.
 */
function previousMonthEnd(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
    .toISOString()
    .slice(0, 10)
}
