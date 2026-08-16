'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import {
  attachDocument,
  deleteDocument,
  detachDocument,
  storeDocument,
} from '@/modules/evidence/service'
import { resolveNote, writeNote } from '@/modules/evidence/notes'
import { EVIDENCE_SUBJECTS } from '@/modules/evidence/subjects'

/** Server actions for attachments and accountant notes (spec §13, Phase 20). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const subject = z.object({
  subjectType: z.enum(EVIDENCE_SUBJECTS as [string, ...string[]]),
  subjectId: z.string().uuid(),
})

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    // Evidence shows up on a lot of pages, and which one the person is looking
    // at is not knowable from here.
    for (const path of ['/bookkeeping', '/accounting', '/documents', '/time', '/payroll']) {
      revalidatePath(path, 'layout')
    }
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' }
  }
}

/**
 * Uploads a file and hangs it on a record in one step.
 *
 * The two-step split the mobile API keeps exists because a phone uploads while
 * the person is still typing. At a desk the file and the record are chosen in
 * the same gesture, and making somebody press upload and then press attach is
 * a step that exists only because the server has two functions.
 */
export async function uploadEvidenceAction(form: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = subject.parse({
      subjectType: form.get('subjectType'),
      subjectId: form.get('subjectId'),
    })

    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a file first.')

    const stored = await storeDocument(actor, {
      filename: file.name || 'attachment',
      contentType: file.type,
      data: Buffer.from(await file.arrayBuffer()),
      note: (form.get('note') as string | null)?.trim() || null,
    })

    const attached = await attachDocument(actor, {
      subjectType: parsed.subjectType as never,
      subjectId: parsed.subjectId,
      documentId: stored.id,
    })

    if (attached.alreadyAttached) return 'That file is already on this record.'
    return stored.deduplicated
      ? `Attached. You already had ${stored.filename}, so it is stored once and used twice.`
      : `Attached ${stored.filename}.`
  })
}

/** Hangs a document already held by this company on another record. */
export async function attachExistingAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = subject.extend({ documentId: z.string().uuid() }).parse(input)

    const result = await attachDocument(actor, {
      subjectType: parsed.subjectType as never,
      subjectId: parsed.subjectId,
      documentId: parsed.documentId,
    })

    return result.alreadyAttached ? 'It was already there.' : 'Attached.'
  })
}

export async function detachEvidenceAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = subject.extend({ documentId: z.string().uuid() }).parse(input)

    const removed = await detachDocument(actor, {
      subjectType: parsed.subjectType as never,
      subjectId: parsed.subjectId,
      documentId: parsed.documentId,
    })

    if (!removed) throw new Error('That was not attached to this record.')
    return 'Removed from this record. The file is still in your documents.'
  })
}

export async function deleteDocumentAction(documentId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await deleteDocument(actor, z.string().uuid().parse(documentId))

    if (!done) throw new Error('That document does not exist.')
    return 'Deleted, everywhere it was attached.'
  })
}

export async function writeNoteAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const parsed = subject
      .extend({ body: z.string().trim().min(1, 'A note needs something in it.'), isQuestion: z.boolean().optional() })
      .parse(input)

    await writeNote(actor, {
      subjectType: parsed.subjectType as never,
      subjectId: parsed.subjectId,
      body: parsed.body,
      isQuestion: parsed.isQuestion,
    })

    return parsed.isQuestion ? 'Asked. It is on the open-questions list until somebody answers.' : 'Noted.'
  })
}

export async function resolveNoteAction(
  noteId: unknown,
  answer?: unknown,
): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    const done = await resolveNote(
      actor,
      z.string().uuid().parse(noteId),
      typeof answer === 'string' ? answer : undefined,
    )

    if (!done) throw new Error('That question has already been answered.')
    return 'Answered.'
  })
}
