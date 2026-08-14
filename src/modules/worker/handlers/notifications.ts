import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { memberships } from '@/db/schema'
import { hasPermission, type Permission, type Role } from '@/modules/permissions'
import {
  notifyComplianceExpiring,
  notifyInvoicePaid,
  notifyProposalDecided,
} from '@/modules/mobile/notifications'
import { registerHandler, type JobContext } from '../registry'

/**
 * Notification delivery, driven by the outbox.
 *
 * ## What changes by moving these here
 *
 * `announceAcceptance` used to call `notifyProposalDecided` inline and swallow
 * anything it threw, with the comment *"a notification is a courtesy; the
 * acceptance is the record"*. That reasoning was sound and its conclusion was
 * forced only because there were two options — block the signature on a push
 * service, or lose the notification.
 *
 * Delivering from a job gives the third: the acceptance commits with an event
 * beside it, and the send happens afterwards where a failure gets the queue's
 * backoff, five attempts, and a row on the operations page. Nothing is on the
 * critical path of a signature, and nothing is silently lost.
 *
 * ## Why running twice is safe
 *
 * A duplicate push is the mildest failure in this codebase — and `tag` on each
 * message means the browser *replaces* rather than stacks, so a redelivered
 * notification about the same proposal collapses into one on the device.
 */

/** Everyone in a company who holds a permission. */
async function recipientsWith(companyId: string, permission: Permission) {
  const rows = await db
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.isActive, true)))

  return rows.filter((row) => hasPermission(row.role as Role, permission)).map((row) => row.userId)
}

registerHandler({
  kind: 'notify.proposal_decided',
  label: 'Tell the team a proposal was accepted or declined',
  handler: async (context: JobContext) => {
    const { companyId } = context.actor!
    const proposalNumber = String(context.payload.proposalNumber ?? '')
    const clientName = String(context.payload.clientName ?? 'A client')
    const won = context.payload.won !== false

    const userIds = await recipientsWith(companyId, 'proposals:manage')

    let sent = 0
    let suppressed = 0

    for (const userId of userIds) {
      const result = await notifyProposalDecided({
        companyId,
        userId,
        proposalNumber,
        clientName,
        won,
      })
      sent += result.sent
      if (result.suppressed) suppressed++
    }

    return { recipients: userIds.length, sent, suppressed }
  },
})

registerHandler({
  kind: 'notify.invoice_paid',
  label: 'Tell the team an invoice was paid',
  handler: async (context: JobContext) => {
    const { companyId } = context.actor!

    const userIds = await recipientsWith(companyId, 'accounting:view')

    let sent = 0

    for (const userId of userIds) {
      const result = await notifyInvoicePaid({
        companyId,
        userId,
        invoiceNumber: String(context.payload.invoiceNumber ?? ''),
        customerName: String(context.payload.customerName ?? 'A customer'),
        amount: String(context.payload.amount ?? ''),
      })
      sent += result.sent
    }

    return { recipients: userIds.length, sent }
  },
})

registerHandler({
  kind: 'notify.compliance_expiring',
  label: 'Warn that a subcontractor document is expiring',
  handler: async (context: JobContext) => {
    const { companyId } = context.actor!

    const userIds = await recipientsWith(companyId, 'jobs:manage')

    let sent = 0

    for (const userId of userIds) {
      const result = await notifyComplianceExpiring({
        companyId,
        userId,
        vendorName: String(context.payload.vendorName ?? 'A subcontractor'),
        expiresOn: String(context.payload.expiresOn ?? ''),
      })
      sent += result.sent
    }

    return { recipients: userIds.length, sent }
  },
})
