import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { communications, customers, tasks, vendors } from '@/db/schema'
import { addUserWithRole, createCompanyFixture } from './helpers'
import { PermissionError } from '@/modules/permissions'
import {
  createContact,
  createOpportunity,
  createOrganization,
} from '@/modules/crm/opportunities'
import {
  CommunicationError,
  communicationsForOpportunity,
  communicationsForOrganization,
  communicationsForParty,
  lastContactedAt,
  logCommunication,
} from '@/modules/engagement/communications'
import {
  assignTask,
  cancelTask,
  closedWork,
  completeTask,
  createTask,
  myWork,
  openWork,
  reopenTask,
  TaskError,
  tasksForOrganization,
  workSummary,
} from '@/modules/engagement/tasks'
import { organizationTimeline } from '@/modules/engagement/timeline'
import { recordOutboundMail } from '@/modules/engagement/outbound'
import { partsOf } from '@/modules/engagement/entry'
import { holdsALink } from '@/modules/notify/keeping'
import { inviteToCompany } from '@/modules/notify/invitations'
import { sendInvoiceEmail, sendRemittanceEmail } from '@/modules/notify/service'
import { mockTransactionalProvider } from '@/modules/notify/transactional'

/**
 * Communications and follow-ups (spec §6, §16 `Communication` and `Task`,
 * Phase 22).
 *
 * Two claims under test:
 *
 *   **Every letter the system sends is recorded against the person it went
 *   to**, in the same log a hand-logged phone call goes in. One question —
 *   "what have we said to this client?" — with one answer.
 *
 *   **A task is never silently lost.** It survives without an owner, it
 *   surfaces when it is late, and closing it twice closes it once.
 */

const mock = mockTransactionalProvider()

beforeEach(() => {
  mock.reset()
})

async function client(name = 'Harborview Holdings') {
  const fixture = await createCompanyFixture({ name: 'Engagement Co' })
  const organization = await createOrganization(fixture.ctx, { name })
  const contact = await createContact(fixture.ctx, {
    organizationId: organization.id,
    firstName: 'Dana',
    lastName: 'Reeve',
    email: 'dana@harborview.test',
  })

  return { fixture, organization, contact }
}

describe('the communications log', () => {
  it('records what was said, and derives the client from the person', async () => {
    const { fixture, organization, contact } = await client()

    // Only the contact is named. Making somebody also name the company their
    // contact works for is how half the log ends up missing it.
    await logCommunication(fixture.ctx, {
      contactId: contact.id,
      channel: 'call',
      direction: 'inbound',
      summary: 'Rang about the revised scope; wants the copper valley priced.',
    })

    const [row] = await db.select().from(communications)
    expect(row.organizationId).toBe(organization.id)
    expect(row.contactId).toBe(contact.id)
    expect(row.actorName).toBe(fixture.ctx.userName)

    const timeline = await communicationsForOrganization(fixture.ctx, organization.id)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].contactName).toBe('Dana Reeve')
    expect(timeline[0].wasSentByTheSystem).toBe(false)
  })

  it('shows exchanges logged against a contact or a deal on the client timeline', async () => {
    const { fixture, organization, contact } = await client()
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Roof package',
      expectedValueCents: 100_000,
    })

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'letter',
      direction: 'outbound',
      summary: 'Filed directly against the company.',
    })
    await logCommunication(fixture.ctx, {
      contactId: contact.id,
      channel: 'call',
      direction: 'inbound',
      summary: 'Against the person.',
    })
    await logCommunication(fixture.ctx, {
      opportunityId: opportunity.id,
      channel: 'meeting',
      direction: 'outbound',
      summary: 'Against the deal.',
    })

    // Somebody who logged a call against the person they spoke to expects it on
    // the company's page. A query matching only the direct column would show
    // them an empty one.
    const forOrganization = await communicationsForOrganization(fixture.ctx, organization.id)
    expect(forOrganization).toHaveLength(3)

    const forDeal = await communicationsForOpportunity(fixture.ctx, opportunity.id)
    expect(forDeal.map((row) => row.summary)).toEqual(['Against the deal.'])
  })

  it('keeps the day it happened, not the day it was typed', async () => {
    const { fixture, organization } = await client()
    const friday = new Date('2026-03-06T12:00:00Z')

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'inbound',
      summary: "Friday's call, logged on Monday.",
      occurredAt: friday,
    })

    const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
    expect(row.occurredAt.toISOString()).toBe(friday.toISOString())
  })

  it('refuses an exchange with nobody, and one with no summary', async () => {
    const fixture = await createCompanyFixture({ name: 'Empty Co' })

    await expect(
      logCommunication(fixture.ctx, {
        channel: 'note',
        direction: 'internal',
        summary: 'Floating in space.',
      }),
    ).rejects.toBeInstanceOf(CommunicationError)

    await expect(
      logCommunication(fixture.ctx, {
        organizationId: null,
        contactId: null,
        channel: 'note',
        direction: 'internal',
        summary: '   ',
      }),
    ).rejects.toThrow(/one line/i)
  })

  it('refuses another company’s client', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Engagement Co' })
    const theirs = await client('Their Client')

    await expect(
      logCommunication(ours.ctx, {
        organizationId: theirs.organization.id,
        channel: 'call',
        direction: 'outbound',
        summary: 'Should not be possible.',
      }),
    ).rejects.toThrow(/does not exist/i)
  })

  it('needs crm:manage to write and crm:view to read', async () => {
    const { fixture, organization } = await client()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await expect(
      logCommunication(bookkeeper, {
        organizationId: organization.id,
        channel: 'call',
        direction: 'outbound',
        summary: 'Not their job.',
      }),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it('reports when each client was last spoken to, and does not count notes to self', async () => {
    const { fixture, organization } = await client()
    const quiet = await createOrganization(fixture.ctx, { name: 'Never Called Ltd' })

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'outbound',
      summary: 'Spoke to them.',
      occurredAt: new Date('2026-02-01T10:00:00Z'),
    })
    await logCommunication(fixture.ctx, {
      organizationId: quiet.id,
      channel: 'note',
      direction: 'internal',
      summary: 'Must remember to call these people.',
    })

    const seen = await lastContactedAt(fixture.ctx, [organization.id, quiet.id])

    expect(seen.get(organization.id)?.toISOString().slice(0, 10)).toBe('2026-02-01')
    // A note to self is not contact. Counting it would let a team convince
    // itself it had spoken to somebody it had not.
    expect(seen.has(quiet.id)).toBe(false)
  })
})

describe('letters the system sends', () => {
  it('lands on the timeline of the person it went to', async () => {
    const { fixture, organization, contact } = await client()

    // A company invitation to an address the CRM already knows.
    await inviteToCompany(fixture.ctx, {
      email: 'dana@harborview.test',
      name: 'Dana Reeve',
      role: 'readonly',
    })

    const timeline = await communicationsForOrganization(fixture.ctx, organization.id)
    expect(timeline).toHaveLength(1)
    expect(timeline[0].wasSentByTheSystem).toBe(true)
    expect(timeline[0].direction).toBe('outbound')
    expect(timeline[0].actorName).toBe('Accountrix Plus')
    // The summary is the letter's own subject — what was actually sent — not
    // a description somebody would have had to write.
    expect(timeline[0].summary).toContain('invited you to')

    const [row] = await db
      .select()
      .from(communications)
      .where(eq(communications.contactId, contact.id))
    expect(row.transactionalMessageId).not.toBeNull()
  })

  it('says so when the letter did not arrive', async () => {
    const { fixture, organization } = await client()
    mock.failing.add('dana@harborview.test')

    await inviteToCompany(fixture.ctx, { email: 'dana@harborview.test', role: 'readonly' })

    const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
    expect(row.summary).toContain('did not arrive')
    expect(row.body).toContain('Nobody has been told')
  })

  /**
   * Phase 92. `transactional_message_id` has been on the row since Phase 22 and
   * was only ever read as a boolean; Phase 91 gave the letter a body. This is
   * the phase that reads one through the other, so the timeline can say what
   * the letter said rather than only that one went.
   */
  describe('the letter the timeline points at', () => {
    it('reads the words through the link it already had', async () => {
      const { fixture, organization } = await client()

      await inviteToCompany(fixture.ctx, {
        email: 'dana@harborview.test',
        name: 'Dana Reeve',
        role: 'readonly',
      })

      const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
      expect(row.wasSentByTheSystem).toBe(true)
      expect(row.letter).toContain('invited you')

      // Followed, not copied: the entry keeps no body of its own on a delivered
      // letter, and a second copy would be the defect Phase 91 is named after.
      expect(row.body).toBeNull()
    })

    it('resolves to one labelled part for a letter that arrived', async () => {
      const { fixture, organization } = await client()

      await inviteToCompany(fixture.ctx, {
        email: 'dana@harborview.test',
        name: 'Dana Reeve',
        role: 'readonly',
      })

      const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
      const parts = partsOf({
        note: row.body,
        letter: row.letter,
        sentByTheSystem: row.wasSentByTheSystem,
      })

      expect(parts).toHaveLength(1)
      expect(parts[0].source).toBe('letter')
    })

    /** The case both halves matter: it failed, and here is what nobody read. */
    it('shows the failure and the letter on a bounce', async () => {
      const { fixture, organization } = await client()
      mock.failing.add('dana@harborview.test')

      await inviteToCompany(fixture.ctx, { email: 'dana@harborview.test', role: 'readonly' })

      const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
      const parts = partsOf({
        note: row.body,
        letter: row.letter,
        sentByTheSystem: row.wasSentByTheSystem,
      })

      expect(parts.map((part) => part.source)).toEqual(['note', 'letter'])
      expect(parts[0].text).toContain('Nobody has been told')
      expect(parts[1].text).toContain('invited you')
    })

    it('leaves a hand-logged call with no letter', async () => {
      const { fixture, organization } = await client()

      await logCommunication(fixture.ctx, {
        organizationId: organization.id,
        channel: 'call',
        direction: 'inbound',
        summary: 'Rang about the March invoice.',
        body: 'Will pay Friday.',
      })

      const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
      expect(row.wasSentByTheSystem).toBe(false)
      expect(row.letter).toBeNull()
    })

    /**
     * The subquery is correlated rather than a join in the from-clause, so
     * adding it cannot multiply rows. These readers already `or` three matches
     * across two left joins, which is exactly the shape that goes wrong.
     */
    it('adds no rows to the timeline', async () => {
      const { fixture, organization } = await client()

      await inviteToCompany(fixture.ctx, {
        email: 'dana@harborview.test',
        name: 'Dana Reeve',
        role: 'readonly',
      })
      await logCommunication(fixture.ctx, {
        organizationId: organization.id,
        channel: 'call',
        direction: 'inbound',
        summary: 'Rang about the March invoice.',
      })

      const rows = await communicationsForOrganization(fixture.ctx, organization.id)
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    })

    /**
     * Phase 93. `recordOutboundMail` resolved an address through `contacts`
     * alone. An invoice goes to the address on the `customers` row, and a
     * business that bills people it never courted has no contact for any of
     * them — so every invoice, statement and reminder landed on nobody's
     * timeline at all.
     */
    describe('a letter to somebody who is not a CRM contact', () => {
      async function customerOnly(email = 'accounts@nocontact.test') {
        const fixture = await createCompanyFixture({ name: 'Billing Co' })
        const [customer] = await db
          .insert(customers)
          .values({ companyId: fixture.companyId, name: 'No Contact Ltd', email })
          .returning()
        return { fixture, customer, email }
      }

      it('files an invoice on the customer’s own record', async () => {
        const { fixture, customer, email } = await customerOnly()

        await sendInvoiceEmail({
          to: email,
          toName: 'No Contact Ltd',
          companyId: fixture.companyId,
          companyName: 'Billing Co',
          invoiceNumber: 'INV-0042',
          amountDue: '$1,200.00',
          dueDate: '2026-04-01',
          token: 'tok_invoice_93',
          isReminder: false,
          reference: 'inv-93',
        })

        const rows = await communicationsForParty(fixture.ctx, {
          kind: 'customer',
          id: customer.id,
        })

        expect(rows).toHaveLength(1)
        expect(rows[0].wasSentByTheSystem).toBe(true)
        expect(rows[0].summary).toContain('INV-0042')
        // And Phase 91's words came through the Phase 92 join.
        expect(rows[0].letter).toContain('INV-0042')
      })

      it('is invisible on nobody’s timeline before the party existed', async () => {
        // The regression this phase closes: the same send with no customer row
        // still files nothing, because there is nobody to file it against.
        const fixture = await createCompanyFixture({ name: 'Billing Co' })

        await sendInvoiceEmail({
          to: 'stranger@nowhere.test',
          toName: 'A Stranger',
          companyId: fixture.companyId,
          companyName: 'Billing Co',
          invoiceNumber: 'INV-0043',
          amountDue: '$10.00',
          dueDate: '2026-04-01',
          token: 'tok_invoice_93b',
          isReminder: false,
          reference: 'inv-93b',
        })

        expect(await db.select().from(communications)).toHaveLength(0)
      })

      /**
       * The harm the filing core exists to prevent: one shared inbox that is
       * both a customer and a supplier.
       */
      it('does not file our payment advice against somebody’s debt to us', async () => {
        const shared = 'accounts@bothways.test'
        const fixture = await createCompanyFixture({ name: 'Both Ways Co' })

        const [customer] = await db
          .insert(customers)
          .values({ companyId: fixture.companyId, name: 'Both Ways', email: shared })
          .returning()
        const [vendor] = await db
          .insert(vendors)
          .values({ companyId: fixture.companyId, name: 'Both Ways', email: shared })
          .returning()

        await sendRemittanceEmail({
          to: shared,
          toName: 'Both Ways',
          companyId: fixture.companyId,
          companyName: 'Both Ways Co',
          amount: '$500.00',
          summary: 'One bill settled.',
          token: 'tok_remit_93',
          isResend: false,
          reference: 'rem-93',
        })

        // On the supplier's record, because a remittance is a payables
        // document — and on nobody's debt to us.
        expect(
          await communicationsForParty(fixture.ctx, { kind: 'vendor', id: vendor.id }),
        ).toHaveLength(1)
        expect(
          await communicationsForParty(fixture.ctx, { kind: 'customer', id: customer.id }),
        ).toHaveLength(0)
      })

      it('files an invoice to that same inbox on the customer instead', async () => {
        const shared = 'accounts@bothways2.test'
        const fixture = await createCompanyFixture({ name: 'Both Ways Co' })

        const [customer] = await db
          .insert(customers)
          .values({ companyId: fixture.companyId, name: 'Both Ways', email: shared })
          .returning()
        const [vendor] = await db
          .insert(vendors)
          .values({ companyId: fixture.companyId, name: 'Both Ways', email: shared })
          .returning()

        await sendInvoiceEmail({
          to: shared,
          toName: 'Both Ways',
          companyId: fixture.companyId,
          companyName: 'Both Ways Co',
          invoiceNumber: 'INV-0044',
          amountDue: '$99.00',
          dueDate: '2026-04-01',
          token: 'tok_invoice_93c',
          isReminder: false,
          reference: 'inv-93c',
        })

        expect(
          await communicationsForParty(fixture.ctx, { kind: 'customer', id: customer.id }),
        ).toHaveLength(1)
        expect(
          await communicationsForParty(fixture.ctx, { kind: 'vendor', id: vendor.id }),
        ).toHaveLength(0)
      })

      /** A timeline that is quietly wrong is worse than one quietly short. */
      it('files nothing when two customers share an address', async () => {
        const shared = 'accounts@duplicated.test'
        const fixture = await createCompanyFixture({ name: 'Duplicate Co' })

        await db.insert(customers).values([
          { companyId: fixture.companyId, name: 'One Ltd', email: shared },
          { companyId: fixture.companyId, name: 'Two Ltd', email: shared },
        ])

        await sendInvoiceEmail({
          to: shared,
          toName: 'Which One',
          companyId: fixture.companyId,
          companyName: 'Duplicate Co',
          invoiceNumber: 'INV-0045',
          amountDue: '$10.00',
          dueDate: '2026-04-01',
          token: 'tok_invoice_93d',
          isReminder: false,
          reference: 'inv-93d',
        })

        expect(await db.select().from(communications)).toHaveLength(0)
      })

      it('keeps one company’s post out of another’s', async () => {
        const { fixture, customer, email } = await customerOnly('accounts@isolated.test')
        const other = await createCompanyFixture({ name: 'Nosy Co' })

        await sendInvoiceEmail({
          to: email,
          toName: 'No Contact Ltd',
          companyId: fixture.companyId,
          companyName: 'Billing Co',
          invoiceNumber: 'INV-0046',
          amountDue: '$1.00',
          dueDate: '2026-04-01',
          token: 'tok_invoice_93e',
          isReminder: false,
          reference: 'inv-93e',
        })

        // Naming the party is not enough — the reader is scoped by company.
        expect(
          await communicationsForParty(other.ctx, { kind: 'customer', id: customer.id }),
        ).toHaveLength(0)
      })
    })

    /** Phase 91 keeps the words but never the link the letter carried. */
    it('keeps no link in what it shows', async () => {
      const { fixture, organization } = await client()

      await inviteToCompany(fixture.ctx, {
        email: 'dana@harborview.test',
        name: 'Dana Reeve',
        role: 'readonly',
      })

      const [row] = await communicationsForOrganization(fixture.ctx, organization.id)
      expect(holdsALink(row.letter)).toBe(false)
      // The delivered letter did carry one, so this is a real strip.
      expect(mock.sent[0].text).toContain('http')
    })
  })

  it('records nothing for an address the CRM does not know', async () => {
    const fixture = await createCompanyFixture({ name: 'Stranger Co' })

    await inviteToCompany(fixture.ctx, { email: 'nobody@elsewhere.test', role: 'readonly' })

    expect(await db.select().from(communications)).toHaveLength(0)
  })

  it('never fails a send because the log could not be written', async () => {
    // A company that does not exist cannot own a communication, and the letter
    // must go anyway: the mail is what matters and the record of it is not
    // worth failing a password reset for.
    const recorded = await recordOutboundMail({
      companyId: '00000000-0000-0000-0000-000000000000',
      email: 'anyone@example.test',
      subject: 'Anything',
      transactionalMessageId: '00000000-0000-0000-0000-000000000000',
      kind: 'company_invitation',
      delivered: true,
    })

    expect(recorded).toBeNull()
  })

  it('leaves the caller’s transaction usable when it fails', async () => {
    const { fixture, organization } = await client()

    // Catching the error is only half of "never fails a send": a failed
    // statement aborts the whole transaction in Postgres, so a swallowed
    // exception would leave the caller holding a connection where every
    // later statement fails too — and the invitation would be lost to a
    // bookkeeping row nobody asked for.
    const wroteAnyway = await db.transaction(async (tx) => {
      const failed = await recordOutboundMail(
        {
          companyId: fixture.companyId,
          email: 'nobody@example.test',
          subject: 'Anything',
          // No such message — the foreign key refuses it.
          transactionalMessageId: '00000000-0000-0000-0000-000000000000',
          kind: 'company_invitation',
          delivered: true,
        },
        tx,
      )
      expect(failed).toBeNull()

      // The transaction is still alive, which is the whole point.
      return logCommunication(
        fixture.ctx,
        {
          organizationId: organization.id,
          channel: 'call',
          direction: 'outbound',
          summary: 'Written after the log failed.',
        },
        tx,
      )
    })

    expect(wroteAnyway.id).toBeTruthy()
    const log = await communicationsForOrganization(fixture.ctx, organization.id)
    expect(log.map((row) => row.summary)).toEqual(['Written after the log failed.'])
  })
})

describe('follow-ups', () => {
  it('survives without an owner, and stays on the shared list', async () => {
    const { fixture, organization } = await client()

    await createTask(fixture.ctx, {
      title: 'Somebody should call them back',
      organizationId: organization.id,
    })

    // Unassigned is a real state, not an incomplete one — and it appears on
    // everybody's list rather than nobody's.
    const mine = await myWork(fixture.ctx)
    expect(mine).toHaveLength(1)
    expect(mine[0].assignedTo).toBeNull()
    expect(mine[0].organizationName).toBe(organization.name)

    expect(await myWork(fixture.ctx, { includeUnassigned: false })).toHaveLength(0)
  })

  it('derives the client from the deal it was promised on', async () => {
    const { fixture, organization } = await client()
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'The deal it was promised on',
    })

    // Named by deal alone, the way the panel on a proposal raises one.
    await createTask(fixture.ctx, {
      title: 'Come back on the price',
      opportunityId: opportunity.id,
    })

    // It belongs to that deal's client, and says so — otherwise it appears on
    // no client timeline and carries no name on the board.
    const [row] = await myWork(fixture.ctx)
    expect(row.organizationId).toBe(organization.id)
    expect(row.organizationName).toBe(organization.name)

    expect(await tasksForOrganization(fixture.ctx, organization.id)).toHaveLength(1)
  })

  it('closes once, however many people click at the same moment', async () => {
    const { fixture } = await client()
    const task = await createTask(fixture.ctx, { title: 'Contested' })

    const outcomes = await Promise.all([
      completeTask(fixture.ctx, task.id),
      completeTask(fixture.ctx, task.id),
      completeTask(fixture.ctx, task.id),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(1)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row.status).toBe('done')
    expect(row.completedAt).not.toBeNull()
    expect(row.completedBy).toBe(fixture.userId)
  })

  it('keeps a dropped task, with its reason', async () => {
    const { fixture } = await client()
    const task = await createTask(fixture.ctx, { title: 'Not needed after all' })

    expect(await cancelTask(fixture.ctx, task.id, 'Client withdrew the request.')).toBe(true)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row.status).toBe('cancelled')
    expect(row.outcome).toBe('Client withdrew the request.')
    // A finished task carries a finish time, whichever way it finished — the
    // CHECK constraint says so, and every count depends on it.
    expect(row.completedAt).not.toBeNull()

    expect(await openWork(fixture.ctx)).toHaveLength(0)
  })

  it('goes back on the list when it turns out it was not done', async () => {
    const { fixture } = await client()
    const task = await createTask(fixture.ctx, { title: 'Thought it was finished' })

    await completeTask(fixture.ctx, task.id)
    expect(await reopenTask(fixture.ctx, task.id)).toBe(true)

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id))
    expect(row.status).toBe('open')
    expect(row.completedAt).toBeNull()
    expect(await openWork(fixture.ctx)).toHaveLength(1)

    // Already open — nothing to reopen.
    expect(await reopenTask(fixture.ctx, task.id)).toBe(false)
  })

  it('surfaces what is late, against a date rather than the clock', async () => {
    const { fixture } = await client()

    await createTask(fixture.ctx, { title: 'Late one', dueOn: '2026-03-01' })
    await createTask(fixture.ctx, { title: 'Due today', dueOn: '2026-03-10' })
    await createTask(fixture.ctx, { title: 'Later', dueOn: '2026-04-01' })
    await createTask(fixture.ctx, { title: 'No date at all' })

    const overdue = await openWork(fixture.ctx, { asOf: '2026-03-10', overdueOnly: true })
    expect(overdue.map((task) => task.title)).toEqual(['Late one', 'Due today'])

    const summary = await workSummary(fixture.ctx, '2026-03-10')
    expect(summary).toEqual({ open: 4, overdue: 1, dueToday: 1, unassigned: 4, closed: 0 })

    // Dated work outranks undated: something due Tuesday beats something due
    // "eventually".
    const everything = await openWork(fixture.ctx, { asOf: '2026-03-10' })
    expect(everything[everything.length - 1].title).toBe('No date at all')
  })

  it('will not hand work to somebody who does not work here', async () => {
    const { fixture } = await client()
    const outsider = await createCompanyFixture({ name: 'Elsewhere Co' })
    const task = await createTask(fixture.ctx, { title: 'Whose?' })

    await expect(assignTask(fixture.ctx, task.id, outsider.userId)).rejects.toBeInstanceOf(
      TaskError,
    )

    const colleague = await addUserWithRole(fixture, 'manager')
    expect(await assignTask(fixture.ctx, task.id, colleague.userId)).toBe(true)

    // And taking the name off puts it back on the shared list.
    expect(await assignTask(fixture.ctx, task.id, null)).toBe(true)
    expect((await myWork(fixture.ctx))[0].assignedTo).toBeNull()
  })

  it('refuses a task about another company’s client, and an empty title', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Task Co' })
    const theirs = await client('Their Client')

    await expect(
      createTask(ours.ctx, { title: 'Sneaky', organizationId: theirs.organization.id }),
    ).rejects.toThrow(/does not exist/i)

    await expect(createTask(ours.ctx, { title: '   ' })).rejects.toThrow(/needs a title/i)
  })

  it('keeps one company’s work off another’s list', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Work Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Work Co' })

    await createTask(theirs.ctx, { title: 'Theirs' })

    expect(await openWork(ours.ctx)).toHaveLength(0)
    expect(await openWork(theirs.ctx)).toHaveLength(1)
  })

  it('lists a client’s follow-ups with the open ones first', async () => {
    const { fixture, organization } = await client()

    const done = await createTask(fixture.ctx, {
      title: 'Already handled',
      organizationId: organization.id,
    })
    await completeTask(fixture.ctx, done.id)
    await createTask(fixture.ctx, {
      title: 'Still to do',
      organizationId: organization.id,
      dueOn: '2026-05-01',
    })

    const list = await tasksForOrganization(fixture.ctx, organization.id)
    expect(list.map((task) => task.title)).toEqual(['Still to do', 'Already handled'])
  })

  it('shows what was closed, so that closing it can be undone', async () => {
    const { fixture } = await client()

    const finished = await createTask(fixture.ctx, { title: 'Rang them back' })
    const dropped = await createTask(fixture.ctx, { title: 'Not needed' })
    await createTask(fixture.ctx, { title: 'Still open' })

    await completeTask(fixture.ctx, finished.id, 'Spoke to Sam.')
    await cancelTask(fixture.ctx, dropped.id, 'They cancelled the project.')

    // Done and dropped sit together, because both are finished — and both keep
    // what was said about them.
    const closed = await closedWork(fixture.ctx)
    expect(closed.map((task) => task.title).sort()).toEqual(['Not needed', 'Rang them back'])
    expect(closed.find((task) => task.title === 'Not needed')?.outcome).toBe(
      'They cancelled the project.',
    )

    // The count in the header is counted over the same window as the list under
    // it, which is why `since` is a parameter rather than two separate clocks.
    const summary = await workSummary(fixture.ctx, '2026-03-10')
    expect(summary.open).toBe(1)
    expect(summary.closed).toBe(2)

    // And the way back out.
    expect(await reopenTask(fixture.ctx, finished.id)).toBe(true)
    expect((await closedWork(fixture.ctx)).map((task) => task.title)).toEqual(['Not needed'])
    expect((await workSummary(fixture.ctx, '2026-03-10')).closed).toBe(1)
  })

  it('does not count work closed before the window', async () => {
    const { fixture } = await client()
    const old = await createTask(fixture.ctx, { title: 'Closed a month ago' })
    await completeTask(fixture.ctx, old.id)

    // Backdated in the database rather than by waiting a week.
    await db
      .update(tasks)
      .set({ completedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(tasks.id, old.id))

    expect(await closedWork(fixture.ctx, { since: '2026-02-01' })).toHaveLength(0)
    expect((await workSummary(fixture.ctx, '2026-03-10', '2026-02-01')).closed).toBe(0)

    expect(await closedWork(fixture.ctx, { since: '2025-12-01' })).toHaveLength(1)
    expect((await workSummary(fixture.ctx, '2026-03-10', '2025-12-01')).closed).toBe(1)
  })

  it('keeps one company’s closed work off another’s list', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Closed Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Closed Co' })

    const task = await createTask(theirs.ctx, { title: 'Theirs, finished' })
    await completeTask(theirs.ctx, task.id)

    expect(await closedWork(ours.ctx)).toHaveLength(0)
    expect(await closedWork(theirs.ctx)).toHaveLength(1)
  })
})

describe('the timeline', () => {
  it('merges what the system did, what people said, and what is owed', async () => {
    const { fixture, organization, contact } = await client()

    await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Roof package',
      expectedValueCents: 100_000,
    })

    await logCommunication(fixture.ctx, {
      contactId: contact.id,
      channel: 'call',
      direction: 'inbound',
      summary: 'Asked about the timeline.',
      occurredAt: new Date('2026-03-02T10:00:00Z'),
    })

    await createTask(fixture.ctx, {
      title: 'Send the revised price',
      organizationId: organization.id,
      dueOn: '2026-03-05',
    })

    const timeline = await organizationTimeline(fixture.ctx, organization.id)
    const kinds = new Set(timeline.map((entry) => entry.kind))

    expect(kinds.has('communication')).toBe(true)
    expect(kinds.has('task')).toBe(true)
    // Creating an opportunity logs an activity, which is the system's own
    // record and belongs on the same page as the other two.
    expect(kinds.has('activity')).toBe(true)

    // Newest first, whatever the source.
    for (let index = 1; index < timeline.length; index += 1) {
      expect(timeline[index - 1].at.getTime()).toBeGreaterThanOrEqual(
        timeline[index].at.getTime(),
      )
    }
  })

  it('places an open follow-up at its due date, not when it was typed', async () => {
    const { fixture, organization } = await client()

    await logCommunication(fixture.ctx, {
      organizationId: organization.id,
      channel: 'call',
      direction: 'outbound',
      summary: 'Spoke today.',
    })
    await createTask(fixture.ctx, {
      title: 'Chase next month',
      organizationId: organization.id,
      dueOn: '2099-01-01',
    })

    // A follow-up dated next year belongs at the top of the timeline, not
    // buried at the moment somebody typed it.
    const timeline = await organizationTimeline(fixture.ctx, organization.id)
    expect(timeline[0].kind).toBe('task')
  })

  it('shows nothing of another company', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Timeline Co' })
    const theirs = await client('Their Client')

    await logCommunication(theirs.fixture.ctx, {
      organizationId: theirs.organization.id,
      channel: 'call',
      direction: 'inbound',
      summary: 'Private.',
    })

    expect(await organizationTimeline(ours.ctx, theirs.organization.id)).toHaveLength(0)
  })
})
