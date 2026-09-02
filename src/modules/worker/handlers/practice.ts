import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { practiceBriefState, practiceMembers, practices, users } from '@/db/schema'
import { briefFor, type Brief } from '@/modules/practice/brief'
import { practiceWorkQueue } from '@/modules/practice/switching'
import type { Rung } from '@/modules/practice/triage'
import { sendTransactional } from '@/modules/notify/service'
import { record, topicEnabled } from '@/modules/mobile/notifications'
import { SWITCHED_OFF } from '@/modules/mobile/decision'
import { appBaseUrl } from '@/modules/notify/transactional'
import { registerHandler, type JobContext } from '../registry'

/**
 * The firm's morning brief (spec §14, Phase 88).
 *
 * ## Why this has no tenant
 *
 * A practice is not a company. Every other scheduled job here either belongs to
 * one company or is housekeeping across all of them; this belongs to a *firm*,
 * which is a third thing. It is registered `global: true` for the same reason
 * `housekeeping.retention` is — the worker schema's own comment: *pretending it
 * belongs to one of them would be a lie that `scoped()` would then enforce.*
 *
 * So it fans out over practices itself, and every client set it reads comes
 * from `practiceWorkQueue`, which derives that set inside itself from the
 * member's own live engagements and has no parameter that can widen it.
 *
 * ## Why mail rather than the push topic
 *
 * Phase 24's digest goes through Phase 8's push channel, and a push
 * subscription is keyed on `(company, user)`. An accountant has one per client,
 * so that route would deliver a firm's brief once per client — the forty
 * messages this phase exists to avoid.
 *
 * The deeper reason is that **a roster does not fit in a push notification**. A
 * per-company digest is one sentence and belongs on a phone; a firm's morning
 * list is a list, and belongs in an inbox. Phase 19's mail channel takes a
 * nullable `companyId`, which is exactly the shape a firm-wide letter needs.
 */
registerHandler({
  kind: 'practice.morning_brief',
  label: 'Tell each firm which of its clients got worse overnight',
  global: true,
  handler: async (context: JobContext) => {
    // From the payload rather than the clock, so a run can be replayed for a
    // date and a test can assert on one.
    const asOf = context.payload.asOf ? new Date(String(context.payload.asOf)) : new Date()
    const seenOn = asOf.toISOString().slice(0, 10)

    const firms = await db
      .select({ id: practices.id, name: practices.name })
      .from(practices)
      .where(eq(practices.isActive, true))

    let sent = 0
    let briefed = 0
    let quieted = 0

    for (const firm of firms) {
      const staff = await db
        .select({ userId: practiceMembers.userId, email: users.email, name: users.name })
        .from(practiceMembers)
        .innerJoin(users, eq(users.id, practiceMembers.userId))
        .where(
          and(eq(practiceMembers.practiceId, firm.id), eq(practiceMembers.isActive, true)),
        )

      if (staff.length === 0) continue

      /*
        The roster is read once for the firm, through the first member —
        `practiceWorkQueue` is scoped to the caller's own engagements, and
        under `assigned_only` staffing two members legitimately see different
        clients. Reading it per member would be correct and would also mean a
        five-query-per-client scan repeated for every person at the firm.

        So the brief is the firm's, not each person's: one roster, one letter,
        the same to everybody who works there. That is a real simplification
        and it is written down in the ADR rather than hidden here.
      */
      const roster = await practiceWorkQueue(staff[0].userId, firm.id, asOf)
      if (roster.length === 0) continue

      const memory = await db
        .select({
          companyId: practiceBriefState.companyId,
          rung: practiceBriefState.rung,
        })
        .from(practiceBriefState)
        .where(eq(practiceBriefState.practiceId, firm.id))

      const lastSaid = new Map<string, Rung>(
        memory.map((row) => [row.companyId, row.rung as Rung]),
      )

      const brief = briefFor(
        roster.map((client) => ({
          companyId: client.companyId,
          companyName: client.companyName,
          triage: client.triage,
        })),
        lastSaid,
      )

      /*
        The memory is written whether or not anything is said, and before the
        letter goes out. A run that sent mail and then failed to record what it
        observed would send the same brief again tomorrow; a run that recorded
        and failed to send says nothing about a real change, which is the
        quieter and less damaging of the two.
      */
      await remember(firm.id, seenOn, observedFrom(roster, brief))

      if (!brief) continue
      briefed++

      const audience = { kind: 'practice', practiceId: firm.id } as const

      for (const person of staff) {
        /*
          Phase 89. The brief arrived in Phase 88 with no way to switch it off,
          in an application that has given every other topic a per-person
          switch since Phase 8 — because a channel nobody can quiet is a
          channel that gets filtered to a folder, and then the one message that
          mattered is filtered with it.

          Checked per person rather than per firm: one member wanting out is
          not the firm wanting out.
        */
        if (!(await topicEnabled(audience, person.userId, 'practice_brief'))) {
          quieted++
          /*
            Phase 90. The suppression is the row that matters most and was the
            one nowhere recorded: a send at least left a letter in
            `transactional_messages`, while a person who switched the brief off
            in March had, in July, no way to find out that they had. A counter
            in a job result is not an answer to that question.
          */
          await record({
            audience,
            userId: person.userId,
            topic: 'practice_brief',
            channel: 'mail',
            outcome: 'suppressed',
            title: brief.subject,
            detail: SWITCHED_OFF,
            provider: 'none',
          })
          continue
        }

        const result = await sendTransactional({
          to: person.email,
          toName: person.name,
          kind: 'practice_brief',
          subject: brief.subject,
          body: brief.body,
          action: { label: 'Open the roster', url: `${appBaseUrl()}/practice` },
          footnote:
            'Sent to everybody at your firm. Counts only — you are in nobody’s ledger until you open it.',
          // A firm-wide letter is about no single company, and saying it was
          // about one of them would put it on that client's record.
          companyId: null,
          reference: firm.id,
        })

        if (result.ok) sent++

        /*
          The send is recorded here too, and carries no body: the letter's own
          text is in `transactional_messages`, and a second copy in a second
          table is the defect this project keeps finding. `channel: 'mail'` is
          what tells a reader that the null body means "the text is over there"
          rather than "there was nothing to say" — see `mobile/decision`.
        */
        await record({
          audience,
          userId: person.userId,
          topic: 'practice_brief',
          channel: 'mail',
          outcome: result.ok ? 'sent' : 'failed',
          title: brief.subject,
          url: '/practice',
          detail: result.ok ? null : result.error,
          // Phase 91: the join Phase 90 left unmade. The decision row now names
          // the letter it produced, so "what did it say" is one hop rather than
          // a guess from a subject and a date. Carried on a failure too — a
          // letter that did not arrive is still the letter we tried to send.
          messageId: result.recordId,
          provider: 'mail',
        })
      }
    }

    return { asOf: seenOn, firms: firms.length, briefed, sent, quieted }
  },
})

/** Every client's rung as observed today, whether or not it was reported. */
function observedFrom(
  roster: Array<{ companyId: string; triage: { rung: Rung } }>,
  brief: Brief | null,
): Array<{ companyId: string; rung: Rung }> {
  return (
    brief?.observed ??
    roster.map((client) => ({ companyId: client.companyId, rung: client.triage.rung }))
  )
}

async function remember(
  practiceId: string,
  seenOn: string,
  observed: Array<{ companyId: string; rung: Rung }>,
): Promise<void> {
  for (const row of observed) {
    await db
      .insert(practiceBriefState)
      .values({ practiceId, companyId: row.companyId, rung: row.rung, seenOn })
      .onConflictDoUpdate({
        target: [practiceBriefState.practiceId, practiceBriefState.companyId],
        set: { rung: row.rung, seenOn, updatedAt: new Date() },
      })
  }
}
