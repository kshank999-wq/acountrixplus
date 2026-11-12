'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { parseAmountToCents } from '@/lib/money'
import {
  createBrandKit,
  createClause,
  createServiceItem,
  reviseClause,
  setClauseActive,
  setServiceItemActive,
  saveProfile,
  updateBrandKit,
} from '@/modules/studio/service'
import { deleteAsset, uploadAsset } from '@/modules/studio/assets'
import {
  addTeamMember,
  reorderTeamMembers,
  restoreTeamMember,
  retireTeamMember,
  updateTeamMember,
} from '@/modules/studio/team'
import {
  assetsForSubject,
  linkAsset,
  unlinkAsset,
} from '@/modules/studio/asset-links'
import type { AssetSubjectKind } from '@/modules/studio/asset-subjects'
import {
  applyTemplate,
  createDocumentForProposal,
  saveAsTemplate,
  saveDocument,
} from '@/modules/design/documents'
import { messageFor, Refusal } from '@/modules/errors'
import { parseBlocks, type Block } from '@/modules/design/blocks'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(
  path: string | string[],
  fn: () => Promise<string | void>,
): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const entry of Array.isArray(path) ? path : [path]) revalidatePath(entry)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Something went wrong.'),
    }
  }
}

// --- Company profile -------------------------------------------------------

/**
 * The boundary, and for 210 phases the narrowest part of the path (Phase 210).
 *
 * A zod object **strips** what it does not declare rather than refusing it, so
 * every key this schema omits is a box on the Design Center form that accepts
 * typing, reports success and saves nothing. Three were omitted:
 * `description`, which Phase 200 added a field for and §11 asks the marketing
 * assistant to adapt to; and `addressLine2` and `country`, which
 * `letterhead.ts` prints on every invoice, quote and statement a client sees.
 *
 * The order here follows `PROFILE_FIELDS`, and the test asserting the two agree
 * is the only reason that is more than tidiness.
 */
const profileSchema = z.object({
  legalName: z.string().trim().max(200).optional(),
  dba: z.string().trim().max(200).optional(),
  tagline: z.string().trim().max(300).optional(),
  description: z.string().trim().max(4000).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(40).optional(),
  country: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(60).optional(),
  email: z.string().trim().max(320).optional(),
  website: z.string().trim().max(300).optional(),
  taxId: z.string().trim().max(60).optional(),
  paymentInstructions: z.string().trim().max(2000).optional(),
  documentFooter: z.string().trim().max(1000).optional(),
})

export async function saveProfileAction(
  input: z.input<typeof profileSchema>,
): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    await saveProfile(actor, profileSchema.parse(input))
    return 'Company profile saved.'
  })
}

// --- Brand kit -------------------------------------------------------------

const brandSchema = z.object({
  name: z.string().trim().min(1).max(120),
  primaryColor: z.string().trim(),
  accentColor: z.string().trim(),
  textColor: z.string().trim(),
  mutedColor: z.string().trim(),
  surfaceColor: z.string().trim(),
  headingFont: z.string().trim().max(200),
  bodyFont: z.string().trim().max(200),
  baseSizePt: z.number().int().min(8).max(18),
  logoAssetId: z.string().uuid().nullable().optional(),
})

export async function saveBrandKitAction(
  kitId: string | null,
  input: z.input<typeof brandSchema>,
): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    const parsed = brandSchema.parse(input)

    if (kitId) {
      await updateBrandKit(actor, kitId, parsed)
      return 'Brand kit updated.'
    }

    await createBrandKit(actor, { ...parsed, isDefault: true })
    return 'Brand kit created.'
  })
}

// --- Assets ----------------------------------------------------------------

/**
 * Uploads a logo or image.
 *
 * Takes FormData rather than a base64 string so the bytes never round-trip
 * through a JSON payload, which would inflate them by a third.
 */
export async function uploadAssetAction(formData: FormData): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()

    const file = formData.get('file')
    if (!(file instanceof File)) throw new Refusal('Choose a file to upload.')

    const kind = formData.get('kind')
    const buffer = Buffer.from(await file.arrayBuffer())

    const asset = await uploadAsset(actor, {
      filename: file.name,
      contentType: file.type,
      data: buffer,
      kind: kind === 'logo' ? 'logo' : 'image',
    })

    return `Uploaded ${asset.filename}.`
  })
}

export async function deleteAssetAction(assetId: string): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    await deleteAsset(actor, assetId)
    return 'Asset deleted.'
  })
}

// --- Service catalog -------------------------------------------------------

export async function createServiceItemAction(input: {
  name: string
  code?: string
  unit?: string
  unitPrice: string
  description?: string
  chartAccountId?: string
}): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    await createServiceItem(actor, {
      name: input.name,
      code: input.code || null,
      unit: input.unit || 'each',
      unitPriceCents: input.unitPrice.trim() ? parseAmountToCents(input.unitPrice) : 0,
      description: input.description || null,
      chartAccountId: input.chartAccountId || null,
    })
    return 'Service added to the catalog.'
  })
}

// --- Clause library --------------------------------------------------------

export async function createClauseAction(input: {
  title: string
  category: string
  body: string
  approve: boolean
}): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    await createClause(actor, input)
    return input.approve ? 'Clause added and approved.' : 'Clause added as a draft.'
  })
}

export async function reviseClauseAction(
  clauseId: string,
  body: string,
  approve: boolean,
): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    const version = await reviseClause(actor, clauseId, { body, approve })
    return `Saved as version ${version.versionNumber}. Documents already sent keep their wording.`
  })
}

/**
 * Takes a clause out of the library, or puts it back (Phase 205).
 *
 * Deliberately not `reviseClauseAction`: a revision gives new language to the
 * same clause, and a retirement stops the clause being offered without
 * changing a word. The message says what did *not* happen, because that is
 * the part somebody needs to trust before pressing it.
 */
/**
 * Takes a catalogue item out of the pickers, or puts it back (Phase 206).
 *
 * `deactivateServiceItemAction` had no counterpart: the service set the flag
 * false only, so this is the first time a retired item can be brought back.
 * The message names what retiring does *not* do, because an item with stock
 * on it keeps its lots, its value and its line in the reconciliation —
 * stopping something being sold is a different act from writing off what is
 * left of it.
 */
export async function setServiceItemActiveAction(
  itemId: string,
  isActive: boolean,
): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    const item = await setServiceItemActive(actor, { itemId, isActive })

    return isActive
      ? `${item.name} is back in the catalogue and will be offered again.`
      : `${item.name} is retired. It will not be offered on a new line, and any stock it still ` +
          'holds stays on the books exactly as it was.'
  })
}

export async function setClauseActiveAction(
  clauseId: string,
  isActive: boolean,
): Promise<ActionResult> {
  return run('/studio', async () => {
    const actor = await requireActor()
    const clause = await setClauseActive(actor, { clauseId, isActive })

    return isActive
      ? `${clause.title} is back in the library and will be offered again.`
      : `${clause.title} is retired. It will not be offered on a new document, and every ` +
          'document that already carries it is unchanged.'
  })
}

// --- Documents -------------------------------------------------------------

/**
 * One designer serves proposals and marketing creative, so a save has to
 * refresh whichever list the author came from — the action cannot tell.
 */
const DOCUMENT_PATHS = ['/crm/proposals', '/marketing/creative']

export async function saveDocumentAction(
  documentId: string,
  blocks: unknown,
  settings?: {
    name?: string
    brandKitId?: string | null
    pageSize?: 'letter' | 'a4' | 'legal'
    headerText?: string | null
    footerText?: string | null
  },
): Promise<ActionResult> {
  return run(DOCUMENT_PATHS, async () => {
    const actor = await requireActor()
    await saveDocument(actor, documentId, { blocks, settings })
    return 'Saved.'
  })
}

/**
 * Applies a template, and **returns the blocks it wrote** (Phase 192).
 *
 * Returning them is the fix for a defect measured in a browser: the designer
 * holds its blocks in `useState(initialBlocks)`, and `router.refresh()`
 * re-renders the server component without reseeding client state. So the
 * template landed on the server, the editor went on showing the old document,
 * and the author's next save put the old document back — proven against the
 * database, with the applied template gone.
 *
 * The client could not have fixed this alone. Re-reading the prop would
 * clobber unsaved edits on every refresh; remounting would lose the
 * selection. The only thing that knows the document was replaced *and* by
 * what is the action that replaced it, so it says so.
 */
export async function applyTemplateAction(
  documentId: string,
  templateKey: string,
): Promise<ActionResult & { blocks?: Block[] }> {
  try {
    const actor = await requireActor()
    const updated = await applyTemplate(actor, documentId, templateKey)
    for (const entry of DOCUMENT_PATHS) revalidatePath(entry)

    return {
      ok: true,
      message: 'Template applied. Your previous content was replaced.',
      blocks: parseBlocks(updated.blocks),
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

export async function createProposalDocumentAction(
  proposalId: string,
  templateKey: string,
): Promise<ActionResult & { documentId?: string }> {
  try {
    const actor = await requireActor()
    const document = await createDocumentForProposal(actor, proposalId, templateKey)
    revalidatePath('/crm/proposals')
    return { ok: true, documentId: document.id }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not create the document.'),
    }
  }
}

export async function saveAsTemplateAction(
  documentId: string,
  key: string,
  name: string,
): Promise<ActionResult> {
  return run(DOCUMENT_PATHS, async () => {
    const actor = await requireActor()
    await saveAsTemplate(actor, documentId, { key, name })
    return `Saved "${name}" to your template library.`
  })
}

// --- What we sent this client (Phase 180, §8) ------------------------------

/**
 * Reads back the collateral on one record.
 *
 * Its own result type rather than `ActionResult`, because the panel needs the
 * rows and `run`'s shape carries only a message — and squeezing a list into a
 * message string is how a screen ends up parsing prose.
 */
export type SentAssetsResult =
  | { ok: true; assets: Array<{ linkId: string; assetId: string; filename: string; note: string | null }> }
  | { ok: false; error: string }

export async function sentAssetsAction(organizationId: string): Promise<SentAssetsResult> {
  try {
    const actor = await requireActor()
    const rows = await assetsForSubject(actor, { kind: 'organization', id: organizationId })

    return {
      ok: true,
      assets: rows.map((row) => ({
        linkId: row.linkId,
        assetId: row.assetId,
        filename: row.filename,
        note: row.note,
      })),
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not read what was sent.') }
  }
}

const associateSchema = z.object({
  assetId: z.string().uuid(),
  /*
    The five §8 kinds, spelled out rather than taken as a string. The register
    throws a `RegistryError` for an undeclared kind, which is an operator-facing
    defect sentence — and a value arriving from a form is a person's input, so
    it gets a person's refusal instead.
  */
  kind: z.enum(['campaign', 'contact', 'organization', 'opportunity', 'customer']),
  subjectId: z.string().uuid(),
  note: z.string().trim().max(400).optional(),
})

export async function associateAssetAction(input: {
  assetId: string
  kind: string
  subjectId: string
  note?: string
}): Promise<ActionResult> {
  return run(['/crm/organizations', '/studio'], async () => {
    const parsed = associateSchema.safeParse(input)
    if (!parsed.success) {
      throw new Refusal('That is not a record an asset can be associated with.')
    }

    const actor = await requireActor()
    await linkAsset(actor, {
      assetId: parsed.data.assetId,
      subject: { kind: parsed.data.kind as AssetSubjectKind, id: parsed.data.subjectId },
      note: parsed.data.note,
    })

    return 'Associated.'
  })
}

export async function disassociateAssetAction(linkId: string): Promise<ActionResult> {
  return run(['/crm/organizations', '/studio'], async () => {
    const actor = await requireActor()
    await unlinkAsset(actor, linkId)
    return 'Removed.'
  })
}

// --- The people on the proposal (Phase 183, §15) ---------------------------

const teamMemberSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).optional(),
  bio: z.string().trim().max(4000).optional(),
  qualifications: z.string().trim().max(300).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(60).optional(),
  headshotAssetId: z.string().uuid().nullable().optional(),
})

/*
  `/studio` and the two designer paths. A bio edited in the Design Center
  changes what a `team` block renders, and the designer's picker reads the
  directory — so revalidating only `/studio` would leave an author looking at a
  stale list of their own colleagues.
*/
const TEAM_PATHS = ['/studio', ...DOCUMENT_PATHS]

export async function addTeamMemberAction(input: unknown): Promise<ActionResult> {
  return run(TEAM_PATHS, async () => {
    const parsed = teamMemberSchema.safeParse(input)
    if (!parsed.success) {
      throw new Refusal('A team member needs a name, and the other fields have length limits.')
    }

    const actor = await requireActor()
    await addTeamMember(actor, parsed.data)
    return `${parsed.data.name} added to the team directory.`
  })
}

export async function updateTeamMemberAction(
  memberId: string,
  input: unknown,
): Promise<ActionResult> {
  return run(TEAM_PATHS, async () => {
    const parsed = teamMemberSchema.partial().safeParse(input)
    if (!parsed.success) {
      throw new Refusal('Those details are longer than the directory holds.')
    }

    const actor = await requireActor()
    await updateTeamMember(actor, memberId, parsed.data)
    return 'Saved.'
  })
}

/**
 * Retire, not delete.
 *
 * The only removal offered. A proposal sent last year named the people who were
 * going to do the work and the block holds their ids, so deleting the row would
 * change what a client was shown — which is the argument the clause library
 * already makes about revising wording.
 */
export async function retireTeamMemberAction(memberId: string): Promise<ActionResult> {
  return run(TEAM_PATHS, async () => {
    const actor = await requireActor()
    await retireTeamMember(actor, memberId)
    return 'Retired. Proposals that named them still do.'
  })
}

export async function restoreTeamMemberAction(memberId: string): Promise<ActionResult> {
  return run(TEAM_PATHS, async () => {
    const actor = await requireActor()
    await restoreTeamMember(actor, memberId)
    return 'Back in the directory.'
  })
}

export async function reorderTeamMembersAction(orderedIds: string[]): Promise<ActionResult> {
  return run(TEAM_PATHS, async () => {
    const actor = await requireActor()
    await reorderTeamMembers(actor, orderedIds)
    return 'Order saved.'
  })
}
