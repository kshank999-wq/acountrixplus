'use server'

import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { findPracticesByName } from '@/modules/practice/service'

/**
 * Practice lookup for the client's invite form.
 *
 * In its own file because a `'use server'` module may export only async
 * functions, and this one returns data rather than an `ActionResult` — mixing
 * the two shapes in `practice.ts` made every caller there check which kind it
 * had got back.
 *
 * Returns name and contact email only. A directory that told anybody how many
 * clients a firm has would be a competitive-intelligence feed.
 */
export async function findPracticesAction(
  query: unknown,
): Promise<Array<{ id: string; name: string; contactEmail: string | null }>> {
  // Signed in, but no particular permission: this is a public directory of
  // firms that have chosen to exist, not anybody's private data.
  await requireActor()

  const practices = await findPracticesByName(z.string().parse(query))
  return practices.map((practice) => ({
    id: practice.id,
    name: practice.name,
    contactEmail: practice.contactEmail,
  }))
}
