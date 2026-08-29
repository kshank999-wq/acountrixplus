'use server'

import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { historyFor } from '@/modules/audit'
import { tell, type Told } from '@/modules/audit/story'
import { messageFor } from '@/modules/errors'

/**
 * What happened to one record (spec §19, Phase 71).
 *
 * Read-only, and the only way a screen reaches the audit log. The permission
 * is decided by `historyFor` from the entity type rather than passed in from
 * here — a client component naming its own permission is a client component
 * choosing what it may see.
 */

export type HistoryLine = Told & {
  id: string
  /** ISO, formatted by the screen — the server's locale is not the reader's. */
  at: string
  actorName: string | null
  isUndo: boolean
}

export type HistoryResult =
  | { ok: true; lines: HistoryLine[] }
  | { ok: false; error: string }

const schema = z.object({
  entityType: z.string().trim().min(1),
  entityId: z.string().uuid(),
})

export async function recordHistoryAction(input: unknown): Promise<HistoryResult> {
  try {
    const actor = await requireActor()
    const { entityType, entityId } = schema.parse(input)

    const rows = await historyFor(actor, entityType, entityId)

    return {
      ok: true,
      lines: rows.map((row) => ({
        ...tell(row),
        id: row.id,
        at: row.createdAt.toISOString(),
        actorName: row.actorName,
        isUndo: row.isUndo,
      })),
    }
  } catch (error) {
    // A refusal here is nearly always a permission one, and saying so is the
    // point — "you may not read this record's history" is a different answer
    // from "this record has no history", and a screen that shows an empty list
    // for both teaches somebody the wrong thing about their own books.
    return { ok: false, error: messageFor(error, 'That history could not be read.') }
  }
}
