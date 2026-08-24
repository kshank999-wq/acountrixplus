'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import { securityPolicies } from '@/db/schema'
import { requireActor, currentSession } from '@/lib/current-user'
import { requirePermission } from '@/modules/tenancy/context'
import { recordAudit } from '@/modules/audit'
import {
  beginEnrollment,
  changePassword,
  confirmEnrollment,
  disableMfa,
  regenerateRecoveryCodes,
} from '@/modules/auth/mfa'
import { revokeAllOtherDevices, revokeDevice } from '@/modules/mobile/devices'
import { exportCompanyData, DATASETS, type DatasetName } from '@/modules/tenancy/export'
import { SESSION_COOKIE } from '@/modules/auth/session'
import { resolveSession } from '@/modules/auth/session'
import { messageFor } from '@/modules/errors'

/**
 * Server actions for the security workspace (spec §14, §19).
 *
 * Two things here differ from the rest of the actions in this codebase, and
 * both are deliberate.
 *
 * **Some of these run for a user who is not fully allowed in.** Enrolling a
 * second factor has to work while the company's require-MFA policy is
 * blocking everything else, or the policy is a lockout rather than a
 * requirement. Those call `requireActor({ allowUnenrolled: true })`.
 *
 * **Secrets are returned to the caller exactly once.** The TOTP secret and the
 * recovery codes come back in the action result and are never readable again.
 * That is the correct behaviour and it means the UI, not the server, is
 * responsible for making sure the person wrote them down.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const SECURITY_PATH = '/settings/security'

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const message = await fn()
    revalidatePath(SECURITY_PATH)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Something went wrong.') }
  }
}

// --- Two-factor authentication --------------------------------------------

export type EnrollResult =
  | { ok: true; secret: string; otpauthUri: string }
  | { ok: false; error: string }

export async function beginMfaEnrollmentAction(): Promise<EnrollResult> {
  try {
    const actor = await requireActor({ allowUnenrolled: true })
    const session = await currentSession()

    const started = await beginEnrollment(actor.userId, {
      issuer: session?.companyName ?? 'Accountrix Plus',
    })

    return { ok: true, ...started }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not start setup.'),
    }
  }
}

export type ConfirmMfaResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: string }

export async function confirmMfaEnrollmentAction(code: unknown): Promise<ConfirmMfaResult> {
  const actor = await requireActor({ allowUnenrolled: true })
  const parsed = z.string().trim().safeParse(code)

  if (!parsed.success) return { ok: false, error: 'Enter the six-digit code.' }

  const result = await confirmEnrollment(actor.userId, parsed.data)
  if (!result.ok) return result

  await recordAudit(actor, {
    action: 'mfa.enable',
    entityType: 'user',
    entityId: actor.userId,
    after: { method: 'totp' },
  })

  revalidatePath(SECURITY_PATH)
  return { ok: true, recoveryCodes: result.recoveryCodes }
}

export async function disableMfaAction(currentPassword: unknown): Promise<ActionResult> {
  const actor = await requireActor()
  const parsed = z.string().min(1, 'Enter your password.').safeParse(currentPassword)

  if (!parsed.success) return { ok: false, error: 'Enter your password.' }

  const result = await disableMfa(actor.userId, parsed.data)
  if (!result.ok) return { ok: false, error: result.error }

  await recordAudit(actor, {
    action: 'mfa.disable',
    entityType: 'user',
    entityId: actor.userId,
    before: { method: 'totp' },
  })

  revalidatePath(SECURITY_PATH)
  return { ok: true, message: 'Two-factor authentication is off.' }
}

export type RecoveryCodesResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: string }

export async function regenerateRecoveryCodesAction(): Promise<RecoveryCodesResult> {
  try {
    const actor = await requireActor()
    const codes = await regenerateRecoveryCodes(actor.userId)

    await recordAudit(actor, {
      action: 'mfa.recovery_codes_regenerated',
      entityType: 'user',
      entityId: actor.userId,
      after: { count: codes.length },
    })

    revalidatePath(SECURITY_PATH)
    return { ok: true, recoveryCodes: codes }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not issue new codes.'),
    }
  }
}

// --- Password and sessions -------------------------------------------------

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z.string().min(8, 'A password must be at least 8 characters.'),
})

export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  const actor = await requireActor()
  const parsed = passwordSchema.safeParse(input)

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please check the form.' }
  }

  const session = await currentSession()
  const result = await changePassword(actor, {
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
    currentSessionId: session?.sessionId,
  })

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(SECURITY_PATH)
  return {
    ok: true,
    message:
      result.sessionsEnded > 0
        ? `Password changed, and ${result.sessionsEnded} other session${result.sessionsEnded === 1 ? '' : 's'} signed out.`
        : 'Password changed.',
  }
}

export async function revokeDeviceAction(deviceId: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    await revokeDevice(actor, z.string().uuid().parse(deviceId))
    return 'That device is signed out.'
  })
}

export async function revokeOtherDevicesAction(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()

    const cookieStore = await cookies()
    const session = await resolveSession(cookieStore.get(SESSION_COOKIE)?.value)

    const result = await revokeAllOtherDevices(actor, session?.deviceId)
    return result.sessionsEnded === 0
      ? 'Nowhere else was signed in.'
      : `Signed out of ${result.sessionsEnded} other session${result.sessionsEnded === 1 ? '' : 's'}.`
  })
}

// --- Company policy --------------------------------------------------------

const policySchema = z.object({
  requireMfa: z.boolean(),
  maxFailedAttempts: z.number().int().min(3).max(100),
  lockoutMinutes: z.number().int().min(1).max(1440),
  sessionTtlDays: z.number().int().min(1).max(365),
})

export async function updateSecurityPolicyAction(input: unknown): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireActor()
    // Company settings, so the owner's permission — not the accountant's.
    requirePermission(actor, 'company:manage')

    const parsed = policySchema.parse(input)

    const [existing] = await db
      .select()
      .from(securityPolicies)
      .where(eq(securityPolicies.companyId, actor.companyId))
      .limit(1)

    if (existing) {
      await db
        .update(securityPolicies)
        .set({ ...parsed, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(securityPolicies.id, existing.id))
    } else {
      await db
        .insert(securityPolicies)
        .values({ companyId: actor.companyId, ...parsed, updatedBy: actor.userId })
    }

    await recordAudit(actor, {
      action: 'security_policy.update',
      entityType: 'company',
      entityId: actor.companyId,
      before: existing
        ? {
            requireMfa: existing.requireMfa,
            maxFailedAttempts: existing.maxFailedAttempts,
            lockoutMinutes: existing.lockoutMinutes,
            sessionTtlDays: existing.sessionTtlDays,
          }
        : null,
      after: parsed,
    })

    return parsed.requireMfa
      ? 'Saved. Members without two-factor authentication will be asked to set it up before they can go anywhere else.'
      : 'Saved.'
  })
}

// --- Export ----------------------------------------------------------------

export type ExportResult =
  | { ok: true; files: Array<{ name: string; content: string }>; rowCount: number }
  | { ok: false; error: string }

/**
 * Builds the export and hands it back for the browser to save.
 *
 * Returned through the action rather than written to disk and linked: there is
 * no object store yet (see the README), and a file on the server's disk with a
 * guessable URL would be a worse answer than no export at all.
 */
export async function exportCompanyDataAction(datasets: unknown): Promise<ExportResult> {
  try {
    const actor = await requireActor()

    const parsed = z
      .array(z.enum(DATASETS as [DatasetName, ...DatasetName[]]))
      .optional()
      .parse(datasets)

    const result = await exportCompanyData(actor, { datasets: parsed })

    return {
      ok: true,
      files: result.files.map((file) => ({ name: file.name, content: file.content })),
      rowCount: result.rowCount,
    }
  } catch (error) {
    return {
      ok: false,
      error: messageFor(error, 'Could not build the export.'),
    }
  }
}
