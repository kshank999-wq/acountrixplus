/**
 * What a restore has to bring back (Phase 148, spec §19).
 *
 * ## The gap this closes
 *
 * Spec §19 asks for four things: *"Backups, point-in-time recovery strategy,
 * retention policy, and tested restore procedure."* The retention policy is
 * built — `RETENTION_POLICIES` has been a registry since Phase 97. The other
 * three did not exist in any form: `docs/DEPLOY.md` covered deploying, secrets,
 * domains and the worker, and contained no occurrence of the words *backup*,
 * *restore* or *recovery*.
 *
 * ## Why a registry rather than a paragraph
 *
 * Because a database backup is **not** a backup of this system, and the reason
 * is spread across three files that each say half of it.
 *
 * `secret-box.ts` makes the argument from the other side, and makes it well:
 *
 * > A database dump — a leaked backup, a SQL injection, a misconfigured replica
 * > — yields ciphertext, and the key was never in it.
 *
 * That is exactly right, and it is exactly why restoring the database alone
 * gives you a company whose MFA-enrolled users can never log in again. The
 * property that makes the dump safe to lose is the property that makes it
 * insufficient to keep. Nothing anywhere said so.
 *
 * ## The one that can be measured rather than declared
 *
 * `document_blobs.storage_provider` records, per row, which adapter holds the bytes — and
 * its own comment says *"Read from here, never from the setting."* So the
 * question "is there anything outside the database" is a fact **in** the
 * database rather than something an operator has to remember about how the
 * system was configured two years ago:
 *
 * ```sql
 * select distinct storage_provider from document_blobs;
 * ```
 *
 * `database` means the bytes are in `document_bytes` and a dump has them.
 * `filesystem` means they are under `OBJECT_STORE_PATH` and a dump does not.
 * A company that switched adapters has both, and both have to come back.
 *
 * ## Regenerable is the distinction that matters
 *
 * Every secret here is "lost" in the same way and they are not the same
 * problem. `SESSION_SECRET` can be rolled: everybody signs in again and
 * nothing is gone. `ENCRYPTION_KEY` cannot: the ciphertext in the database
 * stops being data and becomes bytes. Sorting them by that is the difference
 * between a checklist somebody follows and a checklist somebody skims.
 */

import { RegistryError } from '@/modules/errors/registry'

/** Where a thing lives, which decides what kind of backup reaches it. */
export type RecoveryHome = 'database' | 'object-store' | 'environment'

export type RecoveryTarget = {
  key: string
  livesIn: RecoveryHome
  /**
   * Can this be replaced if it is lost, leaving the data intact?
   *
   * `true` costs somebody an inconvenience — signing in again, re-pointing a
   * webhook. `false` means rows in the restored database are permanently
   * unreadable or permanently useless, and no amount of later work recovers
   * them.
   */
  regenerable: boolean
  /** What stops working, concretely, if this is missing after a restore. */
  lostIfMissing: string
  because: string
}

export const RECOVERY_TARGETS: readonly RecoveryTarget[] = [
  {
    key: 'database',
    livesIn: 'database',
    regenerable: false,
    lostIfMissing: 'Everything. The ledger, the documents’ metadata, every company and every user.',
    because:
      'The obvious one, and it is here so the list is complete rather than a list of surprises. ' +
      'Supabase keeps point-in-time recovery on paid plans and daily snapshots otherwise, which ' +
      'is a setting somebody has to have turned on before the day they need it — the reason the ' +
      'procedure in DEPLOY.md starts by checking it rather than by describing it.',
  },
  {
    key: 'object-store:filesystem',
    livesIn: 'object-store',
    regenerable: false,
    lostIfMissing:
      'Every receipt, proposal PDF and marketing asset whose `document_blobs.storage_provider` says ' +
      '`filesystem`. The rows survive and describe bytes that are not there.',
    because:
      'The bytes live under OBJECT_STORE_PATH and no database backup reaches them. Whether this ' +
      'applies is not a matter of opinion: `document_blobs.storage_provider` records it per row, ' +
      'so a company that never left the database adapter does not need this and a company that ' +
      'switched needs it for part of its history. That is the query the procedure runs first.',
  },
  {
    key: 'ENCRYPTION_KEY',
    livesIn: 'environment',
    regenerable: false,
    lostIfMissing:
      'Every MFA enrolment. The TOTP secrets are AES-GCM ciphertext and a different key does not ' +
      'decrypt them — it fails authentication rather than producing a wrong secret, so the rows ' +
      'are unrecoverable and every enrolled user is locked out of their own books.',
    because:
      'The sharpest entry, and the one this registry exists for. `secret-box.ts` argues that a ' +
      'leaked dump is safe precisely because the key was never in it — which is true, and means ' +
      'a *kept* dump is insufficient for the same reason. One file held both halves of that and ' +
      'neither half mentioned a restore.',
  },
  {
    key: 'VAPID_PRIVATE_KEY',
    livesIn: 'environment',
    regenerable: false,
    lostIfMissing:
      'Every row in `push_subscriptions`. A browser subscribes against one application server ' +
      'key and a push to it signed by any other is rejected, so the subscriptions survive the ' +
      'restore and silently never deliver again.',
    because:
      'Regenerable as a key pair and not as a capability, which is the distinction the flag is ' +
      'for: a new pair can be issued in a minute and every existing subscription is dead the ' +
      'moment it is. Recovering it is cheaper than asking every user on every device to enable ' +
      'notifications again, and nothing would have told anybody that was the choice.',
  },
  {
    key: 'SESSION_SECRET',
    livesIn: 'environment',
    regenerable: true,
    lostIfMissing: 'Every signed-in session. People sign in again and nothing is gone.',
    because:
      'Kept on the list precisely because it is the one that does not matter, and a list whose ' +
      'entries are all emergencies gets read as one undifferentiated emergency. Rolling this is ' +
      'the normal response to suspecting it leaked, which is the test of whether a secret is ' +
      'regenerable: can you change it on purpose on a Tuesday.',
  },
  {
    key: 'CRON_SECRET',
    livesIn: 'environment',
    regenerable: true,
    lostIfMissing:
      'Nothing stored. The scheduled tick refuses until the new value is set at both ends.',
    because:
      'A shared secret between the scheduler and the application rather than a key over data, so ' +
      'losing it costs a configuration change at whoever calls the endpoint. It is on the list ' +
      'because an operator restoring at three in the morning should not have to work out which ' +
      'of these are in this class and which take data with them.',
  },
]

/** The target a key names. Throws on one nobody declared. */
export function recoveryTargetFor(key: string): RecoveryTarget {
  const target = RECOVERY_TARGETS.find((row) => row.key === key)
  if (!target) {
    throw new RegistryError({
      registry: 'RECOVERY_TARGETS',
      key,
      message:
        `No recovery target is declared for "${key}". Anything a restore has to bring back has ` +
        'to say what stops working without it, or the procedure is a list somebody assembled ' +
        'from memory on the worst day of the year.',
    })
  }
  return target
}

export type RestoreVerdict =
  | { complete: true }
  | { complete: false; missing: readonly string[]; why: string }

/**
 * Whether what was recovered covers what this installation actually uses.
 *
 * Pure. `storesInUse` is **measured** — the distinct `store` values in
 * `document_blobs` — rather than declared, on ADR 0141's rule: the half that
 * could excuse a site is the half that has to be checkable. An operator who
 * believes the object store was never used should be told by the database, not
 * by their recollection.
 *
 * Regenerable targets are not required. That is the whole reason the flag
 * exists: a restore that is complete except for `SESSION_SECRET` is complete,
 * and saying otherwise trains people to ignore the answer.
 */
export function restoreStands(input: {
  /** Distinct `document_blobs.storage_provider` values, measured from the restored data. */
  storesInUse: readonly string[]
  /** What the operator has actually got back. */
  recovered: readonly string[]
}): RestoreVerdict {
  const required = RECOVERY_TARGETS.filter((target) => !target.regenerable)
    .filter((target) => {
      if (target.livesIn !== 'object-store') return true
      const adapter = target.key.slice('object-store:'.length)
      return input.storesInUse.includes(adapter)
    })
    .map((target) => target.key)

  const missing = required.filter((key) => !input.recovered.includes(key))
  if (missing.length === 0) return { complete: true }

  return {
    complete: false,
    missing,
    why: missing
      .map((key) => `${key}: ${recoveryTargetFor(key).lostIfMissing}`)
      .join(' '),
  }
}
