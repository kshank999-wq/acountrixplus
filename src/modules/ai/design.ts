/**
 * The AI Design Assistant (Phase 166, spec §11).
 *
 * ## What §11 asks for, read closely
 *
 * > generate layout suggestions, brand-consistent variations,
 * > background/graphic concepts, image prompts, and logo ideation; preserve
 * > user control and provenance
 *
 * Every one of those is **advisory**: *suggestions*, *variations*, *concepts*,
 * *prompts*, *ideation*. None of it is pixel generation, and the bullet that
 * sounds closest — *"image prompts"* — is explicitly text for a person to take
 * elsewhere.
 *
 * That is worth stating because it would have been easy to read §11 as asking
 * for an image model, conclude the platform cannot do it, and either add a
 * dependency nobody asked for or declare the capability blocked. It asks for
 * neither. There is no image model behind the gateway and none is needed.
 *
 * ## So this assistant proposes a layout and a person applies it
 *
 * Which means it reuses the machinery that already exists rather than inventing
 * any: `ask` for the structured call and the usage ledger, `recordSuggestion`
 * for the proposal, and `markAccepted` for the decision — the one that records
 * *"the person who accepted, not the model, because the person is who
 * decided."*
 *
 * The only new thing is where the provenance lands, and that is the finding
 * Phase 166 opened with: Phase 165 put it on `assets`, and an accepted layout
 * suggestion writes to the *document*.
 */

import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { designDocuments } from '@/db/schema'
import { can, scoped, type ActorContext } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import { ask } from './gateway'
import { getSuggestion, markAccepted, recordSuggestion } from './suggestions'
import { parseBlocks, validateBlocks } from '@/modules/design/blocks'
import { permissionFor } from '@/modules/design/documents'

/**
 * What the assistant may propose.
 *
 * Deliberately **not** a block list. A model returning a whole document would
 * be a model deciding, and §12's rule — and the shared rule in every system
 * prompt — is that it proposes while a person disposes. More practically: a
 * returned block list would have to be validated, repaired, merged with what is
 * already there, and reconciled with ids the model invented, and the first thing
 * to go wrong would be silent content loss on somebody's proposal.
 *
 * So it proposes an **ordering and a rationale over the blocks that already
 * exist**, identified by the ids it was given. Anything it names that was not in
 * the document is dropped by `applyLayoutSuggestion`, and anything it omits is
 * appended in its original order — so the worst a bad suggestion can do is
 * rearrange, never delete.
 */
export const layoutSuggestionSchema = z.object({
  /** Block ids, in the order proposed. Ids the model was not given are ignored. */
  order: z.array(z.string()).max(200),
  /** Why, in one or two sentences a person can disagree with. */
  rationale: z.string().max(600),
  /** Optional: concepts for imagery, as text. §11's "image prompts". */
  imagePrompts: z.array(z.string().max(300)).max(6).default([]),
  confidence: z.number().int().min(0).max(10000),
})

export type LayoutSuggestion = z.infer<typeof layoutSuggestionSchema>

export const layoutSuggestionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['order', 'rationale', 'confidence'],
  properties: {
    order: { type: 'array', items: { type: 'string' }, maxItems: 200 },
    rationale: { type: 'string', maxLength: 600 },
    imagePrompts: {
      type: 'array',
      items: { type: 'string', maxLength: 300 },
      maxItems: 6,
    },
    confidence: { type: 'integer', minimum: 0, maximum: 10000 },
  },
} as const

/** One line per block, so the model sees structure without seeing the prose. */
function outline(blocks: ReturnType<typeof parseBlocks>): string {
  return blocks
    .map((block, index) => {
      const record = block as Record<string, unknown>
      const label =
        typeof record.title === 'string' && record.title
          ? record.title
          : typeof record.text === 'string' && record.text
            ? String(record.text).slice(0, 60)
            : ''
      return `${index + 1}. id=${record.id} type=${record.type}${label ? ` — ${label}` : ''}`
    })
    .join('\n')
}

/**
 * Proposes a layout for a document, and records it for a person to decide on.
 *
 * Returns the suggestion row rather than applying anything. §12's
 * human-in-the-loop requirement is not a flag on this function; it is the shape
 * of it.
 */
export async function suggestLayout(ctx: ActorContext, documentId: string) {
  /*
    The document is read before the permission is checked, because the
    permission depends on what kind of document it is: one designer serves
    proposals and marketing creative, and `permissionFor` is the single answer
    to which role may edit which. The read is tenant-scoped, so a document of
    another company is simply not found.
  */
  const [document] = await db
    .select({
      id: designDocuments.id,
      name: designDocuments.name,
      kind: designDocuments.kind,
      blocks: designDocuments.blocks,
    })
    .from(designDocuments)
    .where(scoped(ctx, designDocuments, eq(designDocuments.id, documentId)))
    .limit(1)

  if (!document) {
    return { ok: false as const, message: 'That document was not found.', reason: 'not_found' as const }
  }

  if (!can(ctx, permissionFor(document.kind, 'manage'))) {
    return {
      ok: false as const,
      message: 'Your role does not include editing this document.',
      reason: 'permission' as const,
    }
  }

  const blocks = parseBlocks(document.blocks)

  if (blocks.length < 2) {
    // Nothing to rearrange, and a suggestion saying so would still cost a
    // provider call and a ledger row. Refused before the gateway rather than
    // after.
    return {
      ok: false as const,
      message: 'That document has too little in it to suggest a layout for.',
      reason: 'not_enough_content' as const,
    }
  }

  const result = await ask(ctx, {
    feature: 'design',
    promptKey: 'design.layout',
    values: {
      documentName: document.name,
      documentKind: document.kind,
      blockCount: String(blocks.length),
      outline: outline(blocks),
    },
    input: {
      documentName: document.name,
      documentKind: document.kind,
      blocks: blocks.map((block) => {
        const record = block as Record<string, unknown>
        return { id: record.id, type: record.type }
      }),
    },
    schema: layoutSuggestionSchema,
    jsonSchema: layoutSuggestionJsonSchema,
  })

  if (!result.ok) return result

  const suggestion = await recordSuggestion(ctx, {
    feature: 'design',
    requestId: result.requestId,
    entityType: 'design_document',
    entityId: documentId,
    payload: result.data as unknown as Record<string, unknown>,
    confidenceBp: result.data.confidence,
    rationale: result.data.rationale,
  })

  return { ok: true as const, suggestion, data: result.data, requestId: result.requestId }
}

/**
 * Applies an accepted layout suggestion, and records that a machine laid it out.
 *
 * Three things in one transaction, and the order matters: the blocks move, the
 * document's provenance becomes `ai-assisted` against the request that produced
 * the suggestion, and only then is the suggestion marked accepted — which is
 * `suggestions.ts`'s own rule, that a suggestion is never marked accepted until
 * the ordinary service has actually performed the action.
 */
export async function applyLayoutSuggestion(
  ctx: ActorContext,
  suggestionId: string,
  exec: Executor = db,
) {
  const suggestion = await getSuggestion(ctx, suggestionId)

  if (!suggestion || suggestion.entityType !== 'design_document' || !suggestion.entityId) {
    return { ok: false as const, message: 'That layout suggestion was not found.' }
  }

  const parsed = layoutSuggestionSchema.safeParse(suggestion.payload)
  if (!parsed.success) {
    return { ok: false as const, message: 'That suggestion is no longer readable.' }
  }

  if (!suggestion.requestId) {
    /*
      A suggestion with no ledger row behind it cannot be applied, because the
      document's CHECK requires a machine origin to point at one. Phase 165's
      constraint reaching one level up and refusing an unprovable claim rather
      than letting the document be disclosed as hand-made.
    */
    return {
      ok: false as const,
      message:
        'That suggestion has no AI request recorded against it, so applying it could not be ' +
        'disclosed honestly.',
    }
  }

  const documentId = suggestion.entityId

  return exec.transaction(async (tx) => {
    const [document] = await tx
      .select({ blocks: designDocuments.blocks, kind: designDocuments.kind })
      .from(designDocuments)
      .where(
        and(eq(designDocuments.id, documentId), eq(designDocuments.companyId, ctx.companyId)),
      )
      .limit(1)

    if (!document) return { ok: false as const, message: 'That document was not found.' }

    /*
      Checked here and not only in `suggestLayout`. `getSuggestion` reads by
      tenant and asks nothing about role, so without this a reader who has the
      id of a pending suggestion could apply it — and the two calls are
      separate requests, so the permission held at propose time proves nothing
      about the permission held now.
    */
    if (!can(ctx, permissionFor(document.kind, 'manage'))) {
      return {
        ok: false as const,
        message: 'Your role does not include editing this document.',
      }
    }

    const current = parseBlocks(document.blocks)
    const byId = new Map(
      current.map((block) => [String((block as Record<string, unknown>).id), block]),
    )

    /*
      Reordered, never rewritten. Ids the model named that are not in the
      document are dropped; blocks it omitted are appended in their original
      order. So the worst a bad suggestion can do is rearrange — a model cannot
      delete somebody's content by leaving it out of a list.
    */
    const reordered = parsed.data.order
      .map((id) => byId.get(id))
      .filter((block): block is NonNullable<typeof block> => block !== undefined)

    const placed = new Set(
      reordered.map((block) => String((block as Record<string, unknown>).id)),
    )
    for (const block of current) {
      if (!placed.has(String((block as Record<string, unknown>).id))) reordered.push(block)
    }

    // Validated on the way in, as `saveDocument` does: a malformed result must
    // not be able to corrupt a document a client may be reading.
    const validated = validateBlocks(reordered)
    if (validated.errors.length > 0) {
      return {
        ok: false as const,
        message: `That suggestion would not produce a valid document — ${validated.errors[0]}`,
      }
    }

    await tx
      .update(designDocuments)
      .set({
        blocks: validated.blocks,
        provenanceOrigin: 'ai-assisted',
        aiRequestId: suggestion.requestId,
        updatedAt: new Date(),
      })
      .where(eq(designDocuments.id, documentId))

    await recordAudit(
      ctx,
      {
        action: 'ai_suggestion.accept',
        entityType: 'design_document',
        entityId: documentId,
        after: { blocks: validated.blocks.length, origin: 'ai-assisted' },
      },
      tx,
    )

    // Last, so the suggestion is only accepted once the document actually moved.
    await markAccepted(ctx, suggestionId, undefined, tx)

    return { ok: true as const, blocks: validated.blocks.length }
  })
}
