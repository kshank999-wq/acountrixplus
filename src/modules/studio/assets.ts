import { randomUUID, createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { imageSize } from '@/modules/pdf/images'
import { assetBlobs, assets } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

/**
 * Asset storage (spec §15 logo library, §18 object storage).
 *
 * Bytes go through an `AssetStore` adapter rather than being written directly,
 * the same shape as the bank-provider abstraction: swapping to S3 means
 * writing one adapter and changing an environment variable, not migrating the
 * `assets` table.
 *
 * The default adapter keeps bytes in Postgres. That is a deliberate trade —
 * brand assets are small and few, and a database-backed store needs no
 * credentials, so the demo and the tests run with nothing configured. It is
 * not what should hold receipt scans at volume.
 */

export interface AssetStore {
  readonly key: string
  put(storageKey: string, data: Buffer, contentType: string): Promise<void>
  get(storageKey: string): Promise<Buffer | null>
  delete(storageKey: string): Promise<void>
}

/** Stores bytes in Postgres. Suitable for logos and brand imagery. */
export class DatabaseAssetStore implements AssetStore {
  readonly key = 'database'

  async put(storageKey: string, data: Buffer): Promise<void> {
    await db.insert(assetBlobs).values({ storageKey, data }).onConflictDoNothing()
  }

  async get(storageKey: string): Promise<Buffer | null> {
    const [row] = await db
      .select()
      .from(assetBlobs)
      .where(eq(assetBlobs.storageKey, storageKey))
      .limit(1)

    return row ? Buffer.from(row.data) : null
  }

  async delete(storageKey: string): Promise<void> {
    await db.delete(assetBlobs).where(eq(assetBlobs.storageKey, storageKey))
  }
}

const stores = new Map<string, AssetStore>()

export function registerAssetStore(store: AssetStore): void {
  stores.set(store.key, store)
}

registerAssetStore(new DatabaseAssetStore())

export function getAssetStore(key?: string): AssetStore {
  const resolved = key ?? process.env.ASSET_STORE ?? 'database'
  const store = stores.get(resolved)

  if (!store) {
    throw new Error(
      `Unknown asset store "${resolved}". Registered: ${[...stores.keys()].join(', ')}`,
    )
  }
  return store
}

/**
 * What may be uploaded.
 *
 * SVG is deliberately absent: it can carry script, and these files are served
 * back to browsers on public proposal pages. Accepting it would turn the logo
 * library into a stored-XSS vector.
 */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export const MAX_ASSET_BYTES = 5 * 1024 * 1024

export type UploadInput = {
  filename: string
  contentType: string
  data: Buffer
  kind?: 'logo' | 'image' | 'document'
  width?: number
  height?: number
}

export async function uploadAsset(ctx: ActorContext, input: UploadInput) {
  requirePermission(ctx, 'company:manage')

  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.contentType)) {
    throw new Refusal(
      `Unsupported file type ${input.contentType}. Use PNG, JPEG, WebP, or GIF.`,
    )
  }
  if (input.data.byteLength > MAX_ASSET_BYTES) {
    throw new Refusal('That file is larger than 5 MB.')
  }
  if (input.data.byteLength === 0) {
    throw new Refusal('That file is empty.')
  }

  // The content hash keeps the key stable for identical bytes, and the tenant
  // prefix means one company's key can never collide with another's.
  const digest = createHash('sha256').update(input.data).digest('hex').slice(0, 32)
  const storageKey = `${ctx.companyId}/${digest}-${randomUUID().slice(0, 8)}`

  const store = getAssetStore()
  await store.put(storageKey, input.data, input.contentType)

  /*
    The pixel dimensions, measured rather than taken from the caller
    (Phase 186).

    These two columns have existed since Phase 4 with the comment *"Pixel
    dimensions when known, so layout can reserve space"*, and until now no
    caller passed them and nothing read them — Phase 49's rule twice in one
    row. `input.width` is still honoured where a caller genuinely knows better,
    but the file itself is the authority, because a caller that is wrong about
    this crops somebody's photograph in the wrong place.

    Read from headers only, so it costs nothing on a 5 MB upload. It answers for
    WebP and GIF as well, which the PDF cannot embed: a size is a fact about the
    file, and the web page can crop a WebP even though a printer cannot have it.
  */
  const measured = imageSize(input.data, input.contentType)

  const [asset] = await db
    .insert(assets)
    .values({
      companyId: ctx.companyId,
      kind: input.kind ?? 'image',
      filename: input.filename.slice(0, 200),
      contentType: input.contentType,
      sizeBytes: input.data.byteLength,
      width: measured?.width ?? input.width ?? null,
      height: measured?.height ?? input.height ?? null,
      storageProvider: store.key,
      storageKey,
      uploadedBy: ctx.userId,
      /*
        Said explicitly, because Phase 165's migration dropped the column's
        default on purpose. A caller that forgot would otherwise get 'uploaded'
        silently — which is the false declaration the column exists to prevent,
        reintroduced as a convenience. A person chose this file from their disk,
        so this is a measured fact rather than a default.
      */
      provenanceOrigin: 'uploaded',
      aiRequestId: null,
      derivedFromId: null,
    })
    .returning()

  await recordAudit(ctx, {
    action: 'asset.upload',
    entityType: 'asset',
    entityId: asset.id,
    after: { filename: asset.filename, sizeBytes: asset.sizeBytes, kind: asset.kind },
  })

  return asset
}

export async function listAssets(ctx: ActorContext, kind?: 'logo' | 'image' | 'document') {
  requirePermission(ctx, 'crm:view')

  return db
    .select()
    .from(assets)
    .where(scoped(ctx, assets, kind ? eq(assets.kind, kind) : undefined))
    .orderBy(desc(assets.createdAt))
}

/**
 * Reads an asset's bytes for a tenant-scoped caller.
 *
 * Takes the acting company rather than trusting the id alone, so one tenant
 * cannot fetch another's logo by guessing a uuid.
 */
/**
 * The pixel size of every asset a company has, for a crop (Phase 186).
 *
 * One read rather than one per block: a flyer with six pictures is six rows
 * and the table is small. Rows with no measurement are left out, so the caller
 * sees "unknown" rather than a zero it might divide by — which is how a crop
 * would become a division by zero in a renderer.
 */
export async function assetSizes(
  companyId: string,
  assetIds: string[],
  exec: Executor = db,
): Promise<Record<string, { width: number; height: number }>> {
  if (assetIds.length === 0) return {}

  const rows = await exec
    .select({ id: assets.id, width: assets.width, height: assets.height })
    .from(assets)
    .where(and(eq(assets.companyId, companyId), inArray(assets.id, assetIds)))

  const sizes: Record<string, { width: number; height: number }> = {}
  for (const row of rows) {
    if (row.width && row.height) sizes[row.id] = { width: row.width, height: row.height }
  }

  return sizes
}

/**
 * Measures the assets uploaded before Phase 186 started measuring them.
 *
 * Not a migration, because SQL cannot read a PNG header. Not a lazy fill on
 * read either: a read that writes is a surprise, and the one that would do it
 * is on the client-facing proposal page.
 *
 * So it is an operation somebody runs, and the renderers degrade honestly
 * until they do — an unmeasured asset shows the whole picture rather than a
 * crop guessed from the wrong ratio.
 */
export async function measureStoredAssets(
  ctx: ActorContext,
  limit = 500,
): Promise<{ measured: number; unreadable: number }> {
  requirePermission(ctx, 'company:manage')

  const pending = await db
    .select({ id: assets.id })
    .from(assets)
    .where(scoped(ctx, assets, isNull(assets.width)))
    .limit(limit)

  let measured = 0
  let unreadable = 0

  for (const row of pending) {
    const found = await readAsset(ctx.companyId, row.id)
    const size = found ? imageSize(found.data, found.asset.contentType) : null

    if (!size) {
      unreadable += 1
      continue
    }

    await db
      .update(assets)
      .set({ width: size.width, height: size.height })
      .where(and(eq(assets.companyId, ctx.companyId), eq(assets.id, row.id)))

    measured += 1
  }

  return { measured, unreadable }
}

export async function readAsset(companyId: string, assetId: string, exec: Executor = db) {
  /*
    `exec` since Phase 185: the PDF embeds pictures, and a proposal's PDF is
    rendered inside the transaction that writes its version — so the logo on the
    paper is the logo at the moment it was sent, read through the same executor
    as the figures beside it.
  */
  const [asset] = await exec
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)))
    .limit(1)

  if (!asset) return null

  const data = await getAssetStore(asset.storageProvider).get(asset.storageKey)
  if (!data) return null

  return { asset, data }
}

/**
 * Reads an asset for a public page.
 *
 * Public proposal pages need to show the company's logo, so this exists — but
 * it still requires the caller to name the owning company, which the public
 * route derives from the proposal token rather than from user input.
 */
export async function readPublicAsset(companyId: string, assetId: string) {
  return readAsset(companyId, assetId)
}

export async function deleteAsset(ctx: ActorContext, assetId: string) {
  requirePermission(ctx, 'company:manage')

  const [asset] = await db
    .select()
    .from(assets)
    .where(scoped(ctx, assets, eq(assets.id, assetId)))
    .limit(1)

  if (!asset) throw missing('asset')

  await getAssetStore(asset.storageProvider).delete(asset.storageKey)
  await db.delete(assets).where(and(eq(assets.id, assetId), eq(assets.companyId, ctx.companyId)))

  await recordAudit(ctx, {
    action: 'asset.delete',
    entityType: 'asset',
    entityId: assetId,
    before: { filename: asset.filename },
  })
}
