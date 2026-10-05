import { beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { designDocuments } from '@/db/schema'
import { BUILT_IN_PROMPTS } from '@/modules/ai/prompts'
import { mockAiProvider, registerAiProvider } from '@/modules/ai/registry'
import { applyLayoutSuggestion, suggestLayout } from '@/modules/ai/design'
import { getSuggestion } from '@/modules/ai/suggestions'
import { updateSettings } from '@/modules/ai/settings'
import {
  createMarketingDocument,
  disclosureForDocument,
  duplicateDocument,
  saveDocument,
} from '@/modules/design/documents'
import { parseBlocks } from '@/modules/design/blocks'
import { addUserWithRole, createCompanyFixture, type Fixture } from './helpers'

/**
 * A layout a machine proposed (Phase 166).
 *
 * ADR 0165 nominated the AI Design Assistant. Reading spec §11 closely before
 * building it found a gap in Phase 165's own work.
 *
 * §11 asks it to *"generate layout suggestions, brand-consistent variations,
 * background/graphic concepts, image prompts, and logo ideation"* — every one
 * advisory, none of it pixels, and the bullet that sounds closest (*"image
 * prompts"*) explicitly text. So what it generates is the **layout**, which is
 * the document — and Phase 165 put provenance on `assets`.
 *
 * Measured: `disclosureForDocument` read only the assets a document's blocks
 * referenced, so a document laid out entirely by an accepted suggestion and
 * illustrated with the client's own photographs disclosed **nothing**. Phase
 * 165's rule applied one level short: true about every part, false about the
 * whole.
 */

let fixture: Fixture

/** Four blocks, so there is an order to propose. */
const BLOCKS = [
  { id: 'cover', type: 'cover', title: 'Kitchen fit-out' },
  { id: 'scope', type: 'heading', text: 'Scope of work', align: 'left' },
  { id: 'price', type: 'pricingTable', showTotals: true },
  { id: 'terms', type: 'heading', text: 'Terms', align: 'left' },
]

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Marchetti Design' })
  registerAiProvider(mockAiProvider())
  // Off by default is `settings.ts`'s deliberate default (§23: the core
  // product works without AI), so every one of these tests has to switch it on
  // the way an owner would.
  await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })
})

/** A document with the four blocks in a deliberately poor order. */
async function aDocument(name = 'One-sheet') {
  const document = await createMarketingDocument(fixture.ctx, { name })
  await saveDocument(fixture.ctx, document.id, {
    blocks: [BLOCKS[2], BLOCKS[0], BLOCKS[3], BLOCKS[1]],
  })
  return document
}

describe('the prompt, and what it refuses to let the model do', () => {
  it('is registered as a built-in', () => {
    const prompt = BUILT_IN_PROMPTS.find((entry) => entry.key === 'design.layout')

    expect(prompt).toBeTruthy()
    expect(prompt?.version).toBe(1)
    // The constraint that makes this safe, stated in the prompt itself.
    expect(prompt?.systemPrompt).toContain('Reorder only')
    expect(prompt?.systemPrompt).toContain('cannot add, remove, merge or rewrite')
    // And §11's "image prompts" — text for a person, not images it claims to have made.
    expect(prompt?.systemPrompt).toContain('Do not describe them as images you have made')
  })

  it('brings §11 to six of seven capabilities', () => {
    // ADR 0164's audit counted five. `strategic_account` is the remaining one
    // and gets its prompt in the phase that builds it.
    const keys = BUILT_IN_PROMPTS.map((entry) => entry.key)

    expect(keys).toContain('design.layout')
    expect(keys.filter((key) => key.startsWith('strategic'))).toEqual([])
  })
})

describe('it proposes, and a person disposes', () => {
  it('records a suggestion rather than changing the document', async () => {
    const document = await aDocument()
    const before = await db
      .select({ blocks: designDocuments.blocks, origin: designDocuments.provenanceOrigin })
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    const result = await suggestLayout(fixture.ctx, document.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The suggestion exists and is pending.
    const suggestion = await getSuggestion(fixture.ctx, result.suggestion.id)
    expect(suggestion?.status).toBe('pending')
    expect(suggestion?.entityType).toBe('design_document')
    expect(suggestion?.entityId).toBe(document.id)

    // The document has not moved, and still says a person laid it out.
    const after = await db
      .select({ blocks: designDocuments.blocks, origin: designDocuments.provenanceOrigin })
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(after[0].blocks).toEqual(before[0].blocks)
    expect(after[0].origin).toBe('authored')
  })

  it('refuses a document with too little in it, before spending anything', async () => {
    // Refused ahead of the gateway rather than after: a suggestion saying there
    // is nothing to rearrange still costs a provider call and a ledger row.
    const document = await createMarketingDocument(fixture.ctx, { name: 'Almost empty' })
    await saveDocument(fixture.ctx, document.id, { blocks: [BLOCKS[0]] })

    const result = await suggestLayout(fixture.ctx, document.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_enough_content')
  })

  it('refuses a role that may not edit documents', async () => {
    const document = await aDocument()
    const readonly = { ...fixture.ctx, role: 'readonly' as const }

    const result = await suggestLayout(readonly, document.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('permission')
  })
})

describe('whose document it is decides who may rearrange it', () => {
  it('lets a marketer reorder their own creative', async () => {
    /**
     * The defect this found. `suggestLayout` asked for `proposals:manage`,
     * written out rather than looked up — and one designer serves proposals
     * and marketing creative, so a marketer was refused the right to reorder
     * the creative they had just written.
     *
     * Every document in this file is a marketing document, and every test
     * above passed anyway, because the fixture actor is an owner and owners
     * have everything. A permission check only ever asked of somebody who
     * holds every permission is not a check (Phase 121).
     */
    const document = await aDocument('Spring flyer')
    const marketer = await addUserWithRole(fixture, 'marketing')

    const suggested = await suggestLayout(marketer, document.id)
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    const applied = await applyLayoutSuggestion(marketer, suggested.suggestion.id)
    expect(applied.ok).toBe(true)
  })

  it('refuses to apply a pending suggestion to a reader', async () => {
    /**
     * `getSuggestion` reads by tenant and asks nothing about role, so the
     * permission has to be checked again on the way in. Proposing and applying
     * are two requests, and what the first one's actor was allowed to do says
     * nothing about the second's.
     */
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    const readonly = await addUserWithRole(fixture, 'readonly')
    const applied = await applyLayoutSuggestion(readonly, suggested.suggestion.id)

    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.message).toContain('does not include editing')

    // And the document did not move.
    const [row] = await db
      .select({ origin: designDocuments.provenanceOrigin })
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(row.origin).toBe('authored')
  })
})

describe('applying it records that a machine laid it out', () => {
  it('moves the blocks and sets the document’s provenance together', async () => {
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    const applied = await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)
    expect(applied.ok).toBe(true)

    const [row] = await db
      .select({
        blocks: designDocuments.blocks,
        origin: designDocuments.provenanceOrigin,
        requestId: designDocuments.aiRequestId,
      })
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    expect(row.origin).toBe('ai-assisted')
    // The CHECK requires a machine origin to point at the ledger row that
    // produced it, so this cannot be null.
    expect(row.requestId).toBe(suggested.requestId)
    expect(parseBlocks(row.blocks)).toHaveLength(4)
  })

  it('marks the suggestion accepted only once the document has moved', async () => {
    // `suggestions.ts`'s own rule, honoured rather than restated: a suggestion
    // is never marked accepted for an action that did not happen.
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    // Asserted, not just narrowed: a bare `if (!ok) return` is a type guard
    // that doubles as a way for the test to pass without testing anything,
    // which is how the gateway being switched off hid for a whole run.
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)

    const suggestion = await getSuggestion(fixture.ctx, suggested.suggestion.id)
    expect(suggestion?.status).toBe('accepted')
  })

  it('never loses a block, whatever the model returns', async () => {
    /**
     * The property the schema is shaped around. The model returns an *ordering
     * over ids it was given*, not block content — so ids it invents are dropped
     * and blocks it omits are appended in their original order.
     *
     * The worst a bad suggestion can do is rearrange. A model cannot delete
     * somebody's proposal section by leaving it out of a list, which is the
     * failure that would matter most and the one that needs no trust to
     * prevent.
     */
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    // Asserted, not just narrowed: a bare `if (!ok) return` is a type guard
    // that doubles as a way for the test to pass without testing anything,
    // which is how the gateway being switched off hid for a whole run.
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)

    const [row] = await db
      .select({ blocks: designDocuments.blocks })
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    const ids = parseBlocks(row.blocks).map((block) => (block as { id: string }).id).sort()
    expect(ids).toEqual(['cover', 'price', 'scope', 'terms'])
  })

  it('actually moves them, so the check has been seen to disagree', async () => {
    /**
     * Phase 121: a reorder that returned the input unchanged would satisfy
     * every assertion above. The document is saved in a deliberately poor
     * order — price, cover, terms, scope — and the applied result has to
     * differ from it.
     *
     * The order asserted is what the heuristic can justify from block *types*
     * alone: the cover, then the headings in the order the author wrote them,
     * then the pricing table. Note that "Terms" lands before "Scope of work"
     * — the heuristic sees two headings and has no opinion about which is
     * which, and inventing one from the heading text would be a guess dressed
     * as a rule.
     */
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)

    const [row] = await db
      .select({ blocks: designDocuments.blocks })
      .from(designDocuments)
      .where(eq(designDocuments.id, document.id))

    const ids = parseBlocks(row.blocks).map((block) => (block as { id: string }).id)
    expect(ids).toEqual(['cover', 'terms', 'scope', 'price'])
    expect(suggested.data.rationale).toContain('meets the work before the number')
  })

  it('refuses a suggestion with no ledger row behind it', async () => {
    /**
     * Phase 165's constraint reaching one level up. A suggestion with no
     * `request_id` cannot be applied, because the document's CHECK requires a
     * machine origin to point at one — so rather than let the write fail with a
     * constraint violation, this refuses with a sentence saying why.
     *
     * The alternative would be a document disclosed as hand-made.
     */
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    // Asserted, not just narrowed: a bare `if (!ok) return` is a type guard
    // that doubles as a way for the test to pass without testing anything,
    // which is how the gateway being switched off hid for a whole run.
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    // Strip the ledger link, as a provider failure mid-flight would.
    const { aiSuggestions } = await import('@/db/schema')
    await db
      .update(aiSuggestions)
      .set({ requestId: null })
      .where(eq(aiSuggestions.id, suggested.suggestion.id))

    const applied = await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)

    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.message).toContain('could not be disclosed honestly')
  })
})

describe('what the client is told, corrected', () => {
  it('discloses a machine-laid-out document with no AI assets in it at all', async () => {
    /**
     * The gap this phase opened with, closed. Before Phase 166,
     * `disclosureForDocument` read only the assets a document's blocks
     * referenced — so this document, whose layout came entirely from an accepted
     * suggestion and which embeds no assets whatsoever, disclosed nothing.
     */
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    // Asserted, not just narrowed: a bare `if (!ok) return` is a type guard
    // that doubles as a way for the test to pass without testing anything,
    // which is how the gateway being switched off hid for a whole run.
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return

    expect(await disclosureForDocument(fixture.companyId, document.id)).toBeNull()

    await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)

    expect(await disclosureForDocument(fixture.companyId, document.id)).toContain(
      'AI assistance',
    )
  })

  it('still discloses nothing for a document a person laid out', async () => {
    // The other side, so the check has been seen to disagree as well as agree.
    const document = await aDocument('Hand-made')

    expect(await disclosureForDocument(fixture.companyId, document.id)).toBeNull()
  })
})

describe('a copy of a machine-laid-out document is machine-laid-out', () => {
  it('carries the provenance across, which is where derivedProvenance earned itself', async () => {
    /**
     * Phase 165's propagation rule, and the production caller ADR 0165 said it
     * did not have. A person pressed duplicate, so what *they* did is
     * `authored` — and the copy contains the same layout, so `authored` would be
     * true about the act and false about the artifact.
     *
     * The compiler found this: dropping the column's default made it refuse the
     * duplicate insert until it said where the layout came from.
     */
    const document = await aDocument()
    const suggested = await suggestLayout(fixture.ctx, document.id)
    // Asserted, not just narrowed: a bare `if (!ok) return` is a type guard
    // that doubles as a way for the test to pass without testing anything,
    // which is how the gateway being switched off hid for a whole run.
    expect(suggested.ok).toBe(true)
    if (!suggested.ok) return
    await applyLayoutSuggestion(fixture.ctx, suggested.suggestion.id)

    const copy = await duplicateDocument(fixture.ctx, document.id, 'A copy')

    const [row] = await db
      .select({
        origin: designDocuments.provenanceOrigin,
        requestId: designDocuments.aiRequestId,
      })
      .from(designDocuments)
      .where(eq(designDocuments.id, copy.id))

    expect(row.origin).toBe('ai-assisted')
    // The request id has to come across too, or the CHECK would refuse the copy.
    expect(row.requestId).toBe(suggested.requestId)

    expect(await disclosureForDocument(fixture.companyId, copy.id)).toContain('AI assistance')
  })

  it('does not invent provenance when copying a hand-made document', async () => {
    const document = await aDocument('Hand-made')
    const copy = await duplicateDocument(fixture.ctx, document.id, 'A copy')

    const [row] = await db
      .select({
        origin: designDocuments.provenanceOrigin,
        requestId: designDocuments.aiRequestId,
      })
      .from(designDocuments)
      .where(eq(designDocuments.id, copy.id))

    expect(row.origin).toBe('authored')
    expect(row.requestId).toBeNull()
  })
})
