'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { updateMembership } from '@/modules/tenancy/memberships'
import { PERMISSIONS, ROLE_NAMES } from '@/modules/permissions'
import { messageFor } from '@/modules/errors'

/** Server actions for who can open these books (spec §14, Phase 202). */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const changeSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(ROLE_NAMES).optional(),
  grant: z.array(z.enum(PERMISSIONS)).optional(),
  revoke: z.array(z.enum(PERMISSIONS)).optional(),
  isActive: z.boolean().optional(),
})

/**
 * Changes somebody's role, their granular overrides, or their standing.
 *
 * One action for all three because they are one row and one decision — see
 * `updateMembership`, which also holds the four refusals. The message names
 * what changed rather than saying "saved", for the reason `describeChanges`
 * exists: an access change is the kind somebody wants to see confirmed in
 * words before they close the page.
 */
export async function updateMembershipAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = changeSchema.parse(input)

    const row = await updateMembership(actor, parsed.userId, {
      role: parsed.role,
      grant: parsed.grant,
      revoke: parsed.revoke,
      isActive: parsed.isActive,
    })

    revalidatePath('/settings/access')

    const said: string[] = []
    if (parsed.role !== undefined) said.push(`role set to ${row.role}`)
    if (parsed.grant !== undefined || parsed.revoke !== undefined) {
      const grant = parsed.grant ?? []
      const revoke = parsed.revoke ?? []
      said.push(
        grant.length === 0 && revoke.length === 0
          ? 'overrides cleared, so the role decides'
          : `${grant.length} granted and ${revoke.length} revoked on top of the role`,
      )
    }
    if (parsed.isActive !== undefined) {
      said.push(
        parsed.isActive
          ? 'access restored'
          : 'access revoked, with effect on their next request',
      )
    }

    return {
      ok: true,
      message: said.length > 0 ? `Saved — ${said.join(', ')}.` : 'Nothing changed.',
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}
