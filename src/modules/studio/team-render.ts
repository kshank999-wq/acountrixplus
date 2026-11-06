/**
 * The half of `team` that a browser may hold (Phase 192).
 *
 * ## Why this file exists
 *
 * `document-render.tsx` is the one renderer the client designer and the
 * client-facing page both use, and it needs `selectTeam`. Until this phase
 * `selectTeam` lived in `team.ts` beside the queries, so importing it dragged
 * `@/db` — and therefore `postgres`, `fs`, `net`, `tls` — into the browser
 * bundle.
 *
 * `npm run build` had been failing on exactly that since Phase 183. Eight
 * phases shipped past it because the loop that ran every phase was `tsc
 * --noEmit` and `vitest`, and **neither bundles for a browser**: a type-only
 * question and a Node-only test runner cannot see a server/client boundary.
 *
 * So the split is not tidiness. A module that a client component imports has
 * to be one that *cannot* reach the database, and the way to guarantee that is
 * for it not to import it — which is a property of a file, not a promise in a
 * comment. `modules/source/client-bundle.ts` measures it.
 *
 * Nothing here touches the database, a session, or a clock.
 */

import type { Block } from '@/modules/design/blocks'

export type RenderedTeamMember = {
  id: string
  name: string
  title: string | null
  bio: string | null
  qualifications: string | null
  headshotAssetId: string | null
  /**
   * Carried into the renderers, which is not decoration.
   *
   * `selectTeam` needs it: a document's pool holds the active directory **and**
   * any retired person a block names by id, so a block with an empty selection
   * has to be able to tell those apart. Without this column the default
   * selection would quietly include somebody who left.
   */
  isActive: boolean
}

/**
 * The ids every `team` block in a document names.
 *
 * Deduplicated, because two blocks naming the same principal is one row to
 * read. A block naming nobody contributes nothing here and is served by the
 * active directory the pool always carries.
 */
export function teamIdsInBlocks(blocks: Block[]): string[] {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'team') continue
    for (const id of block.memberIds) ids.add(id)
  }
  return [...ids]
}

/**
 * Who one block means, out of the document's pool.
 *
 * Pure, and shared by the page, the PDF and the email — three renderers reading
 * `memberIds` themselves is how one document becomes three documents, which is
 * the mistake the table block made in Phase 181 and the comment above
 * `TableBlock` already warns about.
 *
 * A named selection comes back **in the block's order**, not the directory's: an
 * author listing two people has said who leads this pitch, and the firm's
 * standing order is a different fact. A member whose row is gone drops out
 * rather than shifting the rest.
 */
export function selectTeam(pool: RenderedTeamMember[], memberIds: string[]): RenderedTeamMember[] {
  if (memberIds.length === 0) return pool.filter((member) => member.isActive)

  const byId = new Map(pool.map((member) => [member.id, member]))
  return memberIds.flatMap((id) => {
    const member = byId.get(id)
    return member ? [member] : []
  })
}
