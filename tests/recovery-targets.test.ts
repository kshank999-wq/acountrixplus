import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { RegistryError } from '@/modules/errors/registry'
import {
  RECOVERY_TARGETS,
  recoveryTargetFor,
  restoreStands,
} from '@/modules/recovery/targets'
import { decryptSecret, encryptSecret } from '@/modules/auth/secret-box'

/**
 * What a restore has to bring back (Phase 148, spec §19).
 *
 * The registry is pure. Two things here are not, and deliberately: the claim
 * that a different key cannot read the ciphertext is **run** rather than
 * asserted, and the claim that `document_blobs.storage_provider` answers the object-store
 * question is checked against the schema.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

describe('the register of what a restore needs', () => {
  it('argues every entry, and says what breaks without it', () => {
    for (const target of RECOVERY_TARGETS) {
      expect(target.because.length, target.key).toBeGreaterThan(140)
      expect(target.lostIfMissing.length, target.key).toBeGreaterThan(40)
    }
  })

  it('sorts the secrets by whether losing one costs data or costs a Tuesday', () => {
    // The distinction the whole list turns on. A register where everything is
    // an emergency is read as one undifferentiated emergency.
    const irrecoverable = RECOVERY_TARGETS.filter((t) => !t.regenerable).map((t) => t.key)
    const rollable = RECOVERY_TARGETS.filter((t) => t.regenerable).map((t) => t.key)

    expect(irrecoverable).toEqual([
      'database',
      'object-store:filesystem',
      'ENCRYPTION_KEY',
      'VAPID_PRIVATE_KEY',
    ])
    expect(rollable).toEqual(['SESSION_SECRET', 'CRON_SECRET'])
  })

  it('refuses a target nobody declared', () => {
    expect(() => recoveryTargetFor('DATABASE_URL')).toThrow(RegistryError)
    try {
      recoveryTargetFor('DATABASE_URL')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('RECOVERY_TARGETS')
    }
  })

  it('names only environment variables this codebase actually reads', () => {
    // A checklist naming a variable nothing reads is a checklist that has
    // drifted from the deployment it describes — Phase 135's rule, applied to
    // the one document somebody reads under pressure.
    //
    // The whole tree, not a list of files. The first version of this named four
    // files by hand and failed on `SESSION_SECRET`, which is read somewhere
    // else entirely — a scan looking in a list somebody typed, which is the
    // fault this codebase has now found ten times and had no business
    // repeating in the test that checks for it.
    const read = new Set(
      sourceFiles('src')
        .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z_0-9]+)/g)])
        .map((match) => match[1]),
    )

    for (const target of RECOVERY_TARGETS.filter((t) => t.livesIn === 'environment')) {
      expect(read.has(target.key), target.key).toBe(true)
    }
  })
})

describe('the key that cannot be regenerated', () => {
  it('cannot read its own ciphertext under a different key', () => {
    // **The assertion the phase exists for**, and it is run rather than
    // declared (Phase 121: a check only ever seen to agree is not a check).
    //
    // `secret-box.ts` argues that a leaked dump is safe because the key was
    // never in it. This is the same fact from the restore side: a dump kept
    // without the key is ciphertext nobody can turn back into a TOTP secret.
    const stored = encryptSecret('JBSWY3DPEHPK3PXP')
    expect(decryptSecret(stored)).toBe('JBSWY3DPEHPK3PXP')

    const original = process.env.ENCRYPTION_KEY
    try {
      process.env.ENCRYPTION_KEY = 'a-different-key-entirely'
      // GCM authenticates, so this fails rather than returning plausible
      // garbage — which is why the row is unrecoverable rather than silently
      // wrong. Both outcomes lock the user out; only one of them is honest.
      expect(() => decryptSecret(stored)).toThrow()
    } finally {
      if (original === undefined) delete process.env.ENCRYPTION_KEY
      else process.env.ENCRYPTION_KEY = original
    }
  })

  it('is what the registry says it is', () => {
    const target = recoveryTargetFor('ENCRYPTION_KEY')
    expect(target.regenerable).toBe(false)
    expect(target.livesIn).toBe('environment')
  })
})

describe('what is outside the database is a fact in the database', () => {
  it('can be asked, so nobody has to remember how this was configured', async () => {
    // The query the procedure runs first, run here against the live schema
    // rather than quoted into a document — a column that gets renamed would
    // leave DEPLOY.md confidently wrong, which is how this test earned its
    // keep on the first run: the query said `store` and the column is
    // `storage_provider`.
    const rows = await db.execute(sql`select distinct storage_provider from document_blobs`)
    expect(rows).toBeDefined()
  })

  it('returns only adapters the code has', async () => {
    const result = await db.execute(sql`select distinct storage_provider from document_blobs`)
    const rows = (result as unknown as { rows?: { storage_provider: string }[] }).rows ?? []

    for (const row of rows) {
      expect(['database', 'filesystem']).toContain(row.storage_provider)
    }
  })

  it('keeps the adapter per row rather than reading the setting', () => {
    // The property that makes the question answerable at all. If this ever
    // becomes a lookup of OBJECT_STORE, the restore procedure stops being able
    // to tell what a company's *history* used.
    const schema = readFileSync('src/db/schema/evidence.ts', 'utf8')
    expect(schema).toMatch(/never from the setting/)
    expect(schema).toMatch(/storageProvider: text\('storage_provider'\)/)
  })
})

describe('whether a restore is finished', () => {
  it('does not ask for an object store this company never used', () => {
    // Measured, not declared (ADR 0141). A company that stayed on the database
    // adapter has nothing outside the dump, and telling it to go and find a
    // directory would be the false alarm that gets the whole list ignored.
    expect(
      restoreStands({
        storesInUse: ['database'],
        recovered: ['database', 'ENCRYPTION_KEY', 'VAPID_PRIVATE_KEY'],
      }),
    ).toEqual({ complete: true })
  })

  it('asks for it the moment one row says filesystem', () => {
    const verdict = restoreStands({
      storesInUse: ['database', 'filesystem'],
      recovered: ['database', 'ENCRYPTION_KEY', 'VAPID_PRIVATE_KEY'],
    })

    expect(verdict.complete).toBe(false)
    if (!verdict.complete) {
      expect(verdict.missing).toEqual(['object-store:filesystem'])
      expect(verdict.why).toMatch(/rows survive and describe bytes that are not there/)
    }
  })

  it('does not hold a restore open for a secret somebody can roll', () => {
    // `SESSION_SECRET` is absent from `recovered` here and the restore is still
    // complete. A checklist that cannot be finished is one nobody finishes.
    expect(
      restoreStands({
        storesInUse: [],
        recovered: ['database', 'ENCRYPTION_KEY', 'VAPID_PRIVATE_KEY'],
      }),
    ).toEqual({ complete: true })
  })

  it('names every missing thing at once, with what each one costs', () => {
    // A refusal somebody can act on (Phase 119), and all of it in one pass —
    // the lesson Phase 146 learned about previews applies to a restore for the
    // same reason: nobody wants to discover the second problem after fixing
    // the first.
    const verdict = restoreStands({
      storesInUse: ['filesystem'],
      recovered: ['database'],
    })

    expect(verdict.complete).toBe(false)
    if (!verdict.complete) {
      expect([...verdict.missing]).toEqual([
        'object-store:filesystem',
        'ENCRYPTION_KEY',
        'VAPID_PRIVATE_KEY',
      ])
      expect(verdict.why).toMatch(/MFA enrolment/)
      expect(verdict.why).toMatch(/push_subscriptions/)
    }
  })

  it('says nothing is missing when nothing is', () => {
    expect(
      restoreStands({
        storesInUse: ['database', 'filesystem'],
        recovered: [
          'database',
          'object-store:filesystem',
          'ENCRYPTION_KEY',
          'VAPID_PRIVATE_KEY',
          'SESSION_SECRET',
          'CRON_SECRET',
        ],
      }),
    ).toEqual({ complete: true })
  })
})

describe('the procedure that describes this', () => {
  it('exists, which it did not before this phase', () => {
    // Spec §19 asks for four things and three of them were absent from every
    // document in the repository. This is the line that keeps them present.
    const deploy = readFileSync('docs/DEPLOY.md', 'utf8')

    expect(deploy).toMatch(/## Backups and getting back/i)
    expect(deploy).toMatch(/point-in-time/i)
    expect(deploy).toMatch(/rehears/i)
  })

  it('names every irrecoverable target where somebody will see it', () => {
    const deploy = readFileSync('docs/DEPLOY.md', 'utf8')

    for (const target of RECOVERY_TARGETS.filter((t) => !t.regenerable)) {
      const name = target.key.startsWith('object-store:') ? 'OBJECT_STORE_PATH' : target.key
      expect(deploy.includes(name), target.key).toBe(true)
    }
  })
})
