import { randomUUID, createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { assetBlobs, assets } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'

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

  const [asset] = await db
    .insert(assets)
    .values({
      companyId: ctx.companyId,
      kind: input.kind ?? 'image',
      filename: input.filename.slice(0, 200),
      contentType: input.contentType,
      sizeBytes: input.data.byteLength,
      width: input.width ?? null,
      height: input.height ?? null,
      storageProvider: store.key,
      storageKey,
      uploadedBy: ctx.userId,
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
export async function readAsset(companyId: string, assetId: string) {
  const [asset] = await db
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

  if (!asset) throw new Error('Asset not found')

  await getAssetStore(asset.storageProvider).delete(asset.storageKey)
  await db.delete(assets).where(and(eq(assets.id, assetId), eq(assets.companyId, ctx.companyId)))

  await recordAudit(ctx, {
    action: 'asset.delete',
    entityType: 'asset',
    entityId: assetId,
    before: { filename: asset.filename },
  })
}
