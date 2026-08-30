import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { communications, contacts } from '@/db/schema'
import { OUR_NAME } from '@/modules/brand/voice'
import type { CommunicationChannel } from './communications'

/**
 * Recording the letters this application sends (spec §6, §16).
 *
 * Phase 19 built a transactional channel and logs every send in
 * `transactional_messages`, which answers "did the mail go?". It does not
 * answer the question a salesperson asks, which is "what have we said to this
 * client?" — because that table is keyed by email address and knows nothing
 * about the CRM.
 *
 * This joins the two. When a letter goes to an address that belongs to a known
 * contact, it lands on that contact's timeline beside the phone calls somebody
 * logged by hand. One log, one answer.
 *
 * ## Why campaigns are deliberately not recorded here
 *
 * `campaign_recipients` already records every marketing send per contact, with
 * opens and clicks. Mirroring those into the communications log would put a row
 * on every recipient's timeline for every newsletter, and a log where the
 * quarterly mailshot outnumbers the three sentences somebody typed after a
 * difficult call is a log people stop reading. Transactional mail is
 * individual, deliberate and rare, which is exactly what belongs on a timeline.
 */

/** No `ActorContext`: the sender is the system, not a signed-in person. */
export type OutboundMail = {
  companyId: string
  email: string
  subject: string
  transactionalMessageId: string
  /** Whether it actually went. A bounce is worth seeing on the timeline. */
  delivered: boolean
}

/**
 * Files a sent letter against whoever it went to.
 *
 * Returns null when the address belongs to nobody in the CRM — which is the
 * common case for a password reset to a colleague, and is not a failure.
 *
 * **Never throws, and never damages the caller.** A communications log that
 * cannot be written must not stop a password reset going out.
 *
 * Catching the error is only half of that. When the caller handed us its own
 * transaction, a failed statement aborts the *whole* transaction in Postgres,
 * and swallowing the exception leaves the caller holding a connection where
 * every subsequent statement fails with "current transaction is aborted" — the
 * invitation would be lost to a bookkeeping row nobody asked for. So the work
 * runs in a nested transaction, which drizzle emits as a savepoint: a failure
 * rolls back to the savepoint and the caller's transaction carries on intact.
 */
export async function recordOutboundMail(
  input: OutboundMail,
  exec: Executor = db,
): Promise<{ id: string } | null> {
  try {
    return await exec.transaction(async (tx) => {
      const email = input.email.trim().toLowerCase()

      const [contact] = await tx
        .select({ id: contacts.id, organizationId: contacts.organizationId })
        .from(contacts)
        .where(
          and(
            eq(contacts.companyId, input.companyId),
            isNotNull(contacts.email),
            sql`lower(${contacts.email}) = ${email}`,
          ),
        )
        .limit(1)

      if (!contact) return null

      const [row] = await tx
        .insert(communications)
        .values({
          companyId: input.companyId,
          organizationId: contact.organizationId,
          contactId: contact.id,
          channel: 'email' satisfies CommunicationChannel,
          direction: 'outbound',
          summary: input.delivered
            ? input.subject
            : `${input.subject} — did not arrive`,
          body: input.delivered
            ? null
            : 'The mail provider refused this address. Nobody has been told.',
          transactionalMessageId: input.transactionalMessageId,
          recordedBy: null,
          // Not a person. Attributing an automatic send to whoever happened to
          // trigger it would put their name on a letter they never wrote.
          actorName: OUR_NAME,
        })
        .returning({ id: communications.id })

      return row
    })
  } catch {
    return null
  }
}
