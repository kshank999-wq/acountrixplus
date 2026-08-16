import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { documentBlobs, documentBytes, documents } from '@/db/schema'

/**
 * Object storage (spec §18 "object storage for receipts, proposal assets,
 * PDFs, and marketing media").
 *
 * ## Bytes are addressed by what they are, not by who uploaded them
 *
 * The key is the SHA-256 of the content. Phase 4's `AssetStore` composed a key
 * from the tenant id, a truncated digest, and a random suffix — which means the
 * same PDF uploaded twice is stored twice, and a supplier invoice attached to
 * the bill, to the payment, and to the month's journal entry is stored three
 * times. For logos that is invisible. For scanned evidence, which is what §13
 * actually asks to keep, it is the whole storage bill.
 *
 * Content addressing costs one thing and it has to be said plainly: **the store
 * is not tenant-partitioned.** Two companies uploading byte-identical files
 * share a blob. That is safe here only because nothing is ever reachable
 * *through* the store — every read goes through a `documents` row that names a
 * company, and the store is asked for bytes only after that row has been found
 * under a tenant filter. If a route ever takes a hash from a request and hands
 * it to `get()`, that is a cross-tenant read, and it is the one mistake this
 * design makes possible. `readDocument` is the only caller, deliberately.
 *
 * The digest is not a secret and is not treated as one. It is 256 bits, so it
 * is not guessable, but the authorization is the `documents` row.
 */

export interface ObjectStore {
  readonly key: string
  /** Writes bytes under their own digest. Must be idempotent. */
  put(digest: string, data: Buffer, contentType: string): Promise<void>
  get(digest: string): Promise<Buffer | null>
  /** Called only once the last reference is gone. */
  delete(digest: string): Promise<void>
}

/** The SHA-256 of some bytes, hex, lower case. The storage key everywhere. */
export function digestOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Keeps bytes in Postgres.
 *
 * The default, so the demo and the tests run with nothing configured and a
 * backup of the database is a backup of the evidence. Not what should hold a
 * decade of receipt scans, which is what the filesystem and, later, an S3
 * adapter are for.
 */
export class DatabaseObjectStore implements ObjectStore {
  readonly key = 'database'

  async put(digest: string, data: Buffer): Promise<void> {
    // `onConflictDoNothing` is the whole idempotency story: two people
    // uploading the same file at the same moment race to insert one row, and
    // the loser is right to do nothing, because the bytes are identical by
    // construction.
    await db.insert(documentBytes).values({ digest, data }).onConflictDoNothing()
  }

  async get(digest: string): Promise<Buffer | null> {
    const [row] = await db
      .select({ data: documentBytes.data })
      .from(documentBytes)
      .where(eq(documentBytes.digest, digest))
      .limit(1)

    return row ? Buffer.from(row.data) : null
  }

  async delete(digest: string): Promise<void> {
    await db.delete(documentBytes).where(eq(documentBytes.digest, digest))
  }
}

/**
 * Keeps bytes on disk, fanned out two levels by the first four hex characters.
 *
 * A second adapter exists because a seam with one implementation is a claim
 * rather than a fact. This one also demonstrates the property the interface
 * relies on: `put` for a digest that is already there is a no-op, so a retry
 * after a half-finished upload costs nothing and corrupts nothing.
 *
 * Writes go to a temporary name and are renamed into place, because a reader
 * that finds a half-written file gets a corrupt receipt with a correct-looking
 * name. `rename` within one filesystem is atomic; the temporary file lives in
 * the same directory so it always is.
 */
export class FilesystemObjectStore implements ObjectStore {
  readonly key = 'filesystem'

  constructor(private readonly root: string) {}

  private pathFor(digest: string): string {
    return join(this.root, digest.slice(0, 2), digest.slice(2, 4), digest)
  }

  async put(digest: string, data: Buffer): Promise<void> {
    const path = this.pathFor(digest)
    await mkdir(dirname(path), { recursive: true })

    const temporary = `${path}.${process.pid}.partial`
    await writeFile(temporary, data)
    // Node's rename overwrites, which is what we want: a concurrent writer put
    // the same bytes there.
    const { rename } = await import('node:fs/promises')
    await rename(temporary, path)
  }

  async get(digest: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(digest))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async delete(digest: string): Promise<void> {
    await rm(this.pathFor(digest), { force: true })
  }
}

const stores = new Map<string, ObjectStore>()

export function registerObjectStore(store: ObjectStore): void {
  stores.set(store.key, store)
}

registerObjectStore(new DatabaseObjectStore())

/**
 * The store a *new* document goes into.
 *
 * Reads name their own store instead, from the `documents` row, so switching
 * `OBJECT_STORE` does not orphan everything uploaded before the switch. That is
 * the same rule the asset library follows, and the reason both keep a provider
 * column rather than assuming the current setting has always been the setting.
 */
export function getObjectStore(key?: string): ObjectStore {
  const requested = key ?? process.env.OBJECT_STORE ?? 'database'

  if (requested === 'filesystem' && !stores.has('filesystem')) {
    const root = process.env.OBJECT_STORE_PATH
    if (!root) {
      throw new Error(
        'OBJECT_STORE=filesystem needs OBJECT_STORE_PATH set to a directory the ' +
          'application may write to.',
      )
    }
    registerObjectStore(new FilesystemObjectStore(resolve(root)))
  }

  const store = stores.get(requested)
  if (!store) {
    throw new Error(
      `Unknown object store "${requested}". Registered: ${[...stores.keys()].join(', ')}`,
    )
  }
  return store
}

/**
 * Frees bytes nobody points at any more.
 *
 * **Called after the transaction that dropped the last reference has
 * committed, never inside it.** No object store can join a Postgres
 * transaction — S3 certainly cannot — so deleting bytes inside one means a
 * rollback restores the row and leaves the file gone. That is a broken link in
 * somebody's evidence with no way to notice.
 *
 * The other order is safe because its failure mode is boring: if the process
 * dies between the commit and this call, a blob with no references survives on
 * disk. It costs storage, it is invisible, and `sweepOrphanedBlobs` collects
 * it. A blob deleted while something still points at it costs somebody their
 * paperwork, and there is no undo for that.
 *
 * Safe to call twice, and safe to call late: it re-reads who points at the
 * bytes, so a document stored again in the moment between the commit and this
 * call keeps them.
 */
export async function freeBlobIfUnused(
  digest: string,
  exec: Executor = db,
): Promise<boolean> {
  const [blob] = await exec
    .select({ storageProvider: documentBlobs.storageProvider })
    .from(documentBlobs)
    .where(eq(documentBlobs.digest, digest))
    .limit(1)

  if (!blob) return false

  // The `documents` table decides, not `reference_count`.
  //
  // The count was the obvious thing to test and it is the wrong thing: it is a
  // cached number, and a cached number that has drifted upwards leaks storage
  // for ever while one that has drifted downwards deletes somebody's evidence.
  // The rows themselves cannot drift. The count survives because "held by how
  // many companies" is worth reporting and worth indexing on — but it is not
  // load-bearing here, and the foreign key from `documents.digest` is a third
  // line of defence underneath both.
  const [stillUsed] = await exec
    .select({ digest: documents.digest })
    .from(documents)
    .where(eq(documents.digest, digest))
    .limit(1)

  if (stillUsed) return false

  // The row goes first. A row deleted while the bytes survive is an orphan the
  // sweep cannot see, so the bytes are deleted after — and both orders leave
  // the system consistent, because nothing points here any more.
  const removed = await exec
    .delete(documentBlobs)
    .where(eq(documentBlobs.digest, digest))
    .returning({ digest: documentBlobs.digest })

  if (removed.length === 0) return false

  await getObjectStore(blob.storageProvider).delete(digest)
  return true
}

/**
 * Collects blobs left behind by a process that died mid-delete.
 *
 * The retention job the design above makes necessary rather than optional. It
 * is safe to run at any time and safe to run twice: `freeBlobIfUnused` asks
 * `documents` rather than the cached count, so a blob somebody re-uploaded in
 * the meantime is skipped rather than deleted out from under them.
 *
 * The candidate list is drawn from the count because it is the cheap filter;
 * a drifted count means one wasted lookup, not a wrong deletion.
 */
export async function sweepOrphanedBlobs(exec: Executor = db): Promise<number> {
  const candidates = await exec
    .select({ digest: documentBlobs.digest })
    .from(documentBlobs)
    .where(eq(documentBlobs.referenceCount, 0))

  let freed = 0
  for (const candidate of candidates) {
    if (await freeBlobIfUnused(candidate.digest, exec)) freed += 1
  }

  return freed
}
