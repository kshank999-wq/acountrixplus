import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { recordNotes } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import {
  EVIDENCE_SUBJECTS,
  requireSubject,
  subjectDefinition,
  type EvidenceSubject,
  type SubjectRef,
} from './subjects'
import { DomainError } from '@/modules/errors'

/**
 * Accountant notes (spec §13 "audit trail, accountant notes, attachments").
 *
 * ## Why this is not the audit log
 *
 * The audit log records what the software did: who reclassified what, when,
 * from what to what. It is complete, it is not editable, and it answers no
 * question beginning with *why*. A note records what a person concluded —
 * "supplier confirms this is a deposit, not a prepayment" — and that is the
 * thing a reviewer reads first at year end, months after the person who knew
 * has moved on.
 *
 * ## A question is a different thing from a remark
 *
 * "What is this?" left on forty transactions is a work list. A remark is not.
 * The distinction earns a column because a work list nobody can filter for is
 * forty questions nobody answers — and it is exactly the list an accountant
 * hands back to a client, which is spec §14's whole reason for practice mode.
 *
 * Resolving closes a question without deleting it. Nothing here is ever
 * deleted: a note that can be quietly removed is not evidence of anything, and
 * the point of writing one down is that it survives the disagreement.
 */

export class NoteError extends DomainError {
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'NoteError'
  }
}

export type WriteNoteInput = SubjectRef & {
  body: string
  /** A question goes on the work list and can be resolved. A remark cannot. */
  isQuestion?: boolean
}

export async function writeNote(
  ctx: ActorContext,
  input: WriteNoteInput,
  exec?: Executor,
): Promise<{ id: string }> {
  requirePermission(ctx, subjectDefinition(input.subjectType).manage)

  const body = input.body.trim()
  if (!body) throw new NoteError('A note needs something in it.')
  if (body.length > 4000) throw new NoteError('That note is longer than 4,000 characters.')

  const write = async (tx: Executor) => {
    await requireSubject(ctx.companyId, input, tx)

    const [note] = await tx
      .insert(recordNotes)
      .values({
        companyId: ctx.companyId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        body,
        isQuestion: input.isQuestion ?? false,
        authorId: ctx.userId,
        // Frozen, and it carries the practice name when an accountant writes
        // it — the same attribution the audit log uses, for the same reason:
        // "Dana Chen (Hartley & Co) asked this" is the useful sentence.
        authorName: ctx.viaPractice ? `${ctx.userName} (${ctx.viaPractice})` : ctx.userName,
      })
      .returning({ id: recordNotes.id })

    await recordAudit(
      ctx,
      {
        action: 'note.write',
        entityType: input.subjectType,
        entityId: input.subjectId,
        after: { noteId: note.id, isQuestion: input.isQuestion ?? false },
      },
      tx,
    )

    return note
  }

  return exec ? write(exec) : db.transaction(write)
}

/**
 * Answers a question.
 *
 * The database refuses to resolve a remark — `record_notes_resolvable` — so
 * this cannot quietly hide a statement from a list it was never on.
 */
export async function resolveNote(
  ctx: ActorContext,
  noteId: string,
  answer?: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [note] = await tx
      .select()
      .from(recordNotes)
      .where(and(eq(recordNotes.id, noteId), eq(recordNotes.companyId, ctx.companyId)))
      .limit(1)

    if (!note) return false
    requirePermission(ctx, subjectDefinition(note.subjectType).manage)

    if (!note.isQuestion) {
      throw new NoteError('That is a remark, not a question. There is nothing to answer.')
    }

    // The precondition lives in the write, as everywhere else: two people
    // answering at once leaves one answer and one honest refusal.
    const claimed = await tx
      .update(recordNotes)
      .set({ resolvedAt: new Date(), resolvedBy: ctx.userId })
      .where(and(eq(recordNotes.id, noteId), isNull(recordNotes.resolvedAt)))
      .returning({ id: recordNotes.id })

    if (claimed.length === 0) return false

    // The answer is a note of its own rather than an edit of the question.
    // Overwriting the question with its answer loses what was asked, which is
    // half of what makes the exchange worth keeping.
    if (answer?.trim()) {
      await writeNote(
        ctx,
        {
          subjectType: note.subjectType,
          subjectId: note.subjectId,
          body: answer.trim(),
        },
        tx,
      )
    }

    await recordAudit(
      ctx,
      {
        action: 'note.resolve',
        entityType: note.subjectType,
        entityId: note.subjectId,
        after: { noteId },
      },
      tx,
    )

    return true
  })
}

export type Note = {
  id: string
  body: string
  isQuestion: boolean
  authorName: string
  createdAt: Date
  resolvedAt: Date | null
}

/** Notes on one record, oldest first — a conversation reads downwards. */
export async function notesFor(ctx: ActorContext, ref: SubjectRef): Promise<Note[]> {
  requirePermission(ctx, subjectDefinition(ref.subjectType).view)

  return db
    .select({
      id: recordNotes.id,
      body: recordNotes.body,
      isQuestion: recordNotes.isQuestion,
      authorName: recordNotes.authorName,
      createdAt: recordNotes.createdAt,
      resolvedAt: recordNotes.resolvedAt,
    })
    .from(recordNotes)
    .where(
      scoped(
        ctx,
        recordNotes,
        eq(recordNotes.subjectType, ref.subjectType),
        eq(recordNotes.subjectId, ref.subjectId),
      ),
    )
    .orderBy(recordNotes.createdAt)
}

/** Notes for a page of records at once, for the same reason as evidence. */
export async function notesForMany(
  ctx: ActorContext,
  subjectType: EvidenceSubject,
  subjectIds: string[],
): Promise<Map<string, Note[]>> {
  if (subjectIds.length === 0) return new Map()
  requirePermission(ctx, subjectDefinition(subjectType).view)

  const rows = await db
    .select({
      subjectId: recordNotes.subjectId,
      id: recordNotes.id,
      body: recordNotes.body,
      isQuestion: recordNotes.isQuestion,
      authorName: recordNotes.authorName,
      createdAt: recordNotes.createdAt,
      resolvedAt: recordNotes.resolvedAt,
    })
    .from(recordNotes)
    .where(
      scoped(
        ctx,
        recordNotes,
        eq(recordNotes.subjectType, subjectType),
        inArray(recordNotes.subjectId, subjectIds),
      ),
    )
    .orderBy(recordNotes.createdAt)

  const grouped = new Map<string, Note[]>()
  for (const { subjectId, ...note } of rows) {
    const list = grouped.get(subjectId) ?? []
    list.push(note)
    grouped.set(subjectId, list)
  }

  return grouped
}

export type OpenQuestion = Note & {
  subjectType: EvidenceSubject
  subjectId: string
}

/**
 * Every unanswered question in the company, newest first.
 *
 * The work list. Deliberately company-wide rather than per record: the whole
 * value is seeing the forty at once, and an accountant who has to open forty
 * records to find them has no list at all.
 *
 * Filtered by what the caller may see, kind by kind, rather than by one
 * permission for the lot. Somebody without `payroll:view` should not learn what
 * questions were asked about the payroll run, and a single gate would have
 * meant either leaking those or hiding everything from a bookkeeper.
 */
export async function openQuestions(ctx: ActorContext, limit = 100): Promise<OpenQuestion[]> {
  const visible = EVIDENCE_SUBJECTS.filter((subject) => {
    try {
      requirePermission(ctx, subjectDefinition(subject).view)
      return true
    } catch {
      return false
    }
  })

  if (visible.length === 0) return []

  return db
    .select({
      id: recordNotes.id,
      body: recordNotes.body,
      isQuestion: recordNotes.isQuestion,
      authorName: recordNotes.authorName,
      createdAt: recordNotes.createdAt,
      resolvedAt: recordNotes.resolvedAt,
      subjectType: recordNotes.subjectType,
      subjectId: recordNotes.subjectId,
    })
    .from(recordNotes)
    .where(
      scoped(
        ctx,
        recordNotes,
        eq(recordNotes.isQuestion, true),
        isNull(recordNotes.resolvedAt),
        inArray(recordNotes.subjectType, visible),
      ),
    )
    .orderBy(desc(recordNotes.createdAt))
    .limit(limit)
}

/** How many notes hang on each of a list of records, for a page of rows. */
export async function noteCounts(
  ctx: ActorContext,
  subjectType: EvidenceSubject,
  subjectIds: string[],
): Promise<Map<string, { total: number; openQuestions: number }>> {
  if (subjectIds.length === 0) return new Map()
  requirePermission(ctx, subjectDefinition(subjectType).view)

  const rows = await db
    .select({
      subjectId: recordNotes.subjectId,
      total: sql<string>`count(*)`,
      openQuestions: sql<string>`count(*) filter (
        where ${recordNotes.isQuestion} and ${recordNotes.resolvedAt} is null
      )`,
    })
    .from(recordNotes)
    .where(
      scoped(
        ctx,
        recordNotes,
        eq(recordNotes.subjectType, subjectType),
        inArray(recordNotes.subjectId, subjectIds),
      ),
    )
    .groupBy(recordNotes.subjectId)

  return new Map(
    rows.map((row) => [
      row.subjectId,
      { total: Number(row.total), openQuestions: Number(row.openQuestions) },
    ]),
  )
}
