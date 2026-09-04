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
  saveProfile,
  updateBrandKit,
} from '@/modules/studio/service'
import { deleteAsset, uploadAsset } from '@/modules/studio/assets'
import {
  applyTemplate,
  createDocumentForProposal,
  saveAsTemplate,
  saveDocument,
} from '@/modules/design/documents'
import { messageFor, Refusal } from '@/modules/errors'

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

const profileSchema = z.object({
  legalName: z.string().trim().max(200).optional(),
  dba: z.string().trim().max(200).optional(),
  tagline: z.string().trim().max(300).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(40).optional(),
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

export async function applyTemplateAction(
  documentId: string,
  templateKey: string,
): Promise<ActionResult> {
  return run(DOCUMENT_PATHS, async () => {
    const actor = await requireActor()
    await applyTemplate(actor, documentId, templateKey)
    return 'Template applied. Your previous content was replaced.'
  })
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
