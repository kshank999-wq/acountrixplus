import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { devices, sessions } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import type { ActorContext } from '@/modules/tenancy/context'
import { Refusal } from '@/modules/errors'

/**
 * Signed-in devices (spec §19 least privilege, §22 attributable changes).
 *
 * A phone is a credential you can leave in a taxi. Before this, signing that
 * credential out meant expiring every session the person had, from whichever
 * one they still had access to — which is exactly backwards, because the
 * device they want to keep is usually the one they are holding.
 *
 * So a session gains a device, a device is revocable on its own, and revoking
 * one deletes only its sessions.
 */

export type DevicePlatform = 'ios' | 'android' | 'web' | 'unknown'

/**
 * Guesses a platform and a readable name from a user agent.
 *
 * Deliberately coarse. This is a label so a person can tell "iPhone" from
 * "Chrome on Windows" in a list of four; anything finer would be
 * fingerprinting, and it would still be wrong half the time.
 */
export function describeUserAgent(userAgent: string | null | undefined): {
  label: string
  platform: DevicePlatform
} {
  const agent = userAgent ?? ''

  if (/iPhone|iPod/i.test(agent)) return { label: 'iPhone', platform: 'ios' }
  if (/iPad/i.test(agent)) return { label: 'iPad', platform: 'ios' }
  if (/Android/i.test(agent)) {
    return { label: /Mobile/i.test(agent) ? 'Android phone' : 'Android tablet', platform: 'android' }
  }

  const browser = /Edg\//i.test(agent)
    ? 'Edge'
    : /Chrome\//i.test(agent)
      ? 'Chrome'
      : /Safari\//i.test(agent)
        ? 'Safari'
        : /Firefox\//i.test(agent)
          ? 'Firefox'
          : 'Browser'

  const system = /Macintosh/i.test(agent)
    ? 'Mac'
    : /Windows/i.test(agent)
      ? 'Windows'
      : /Linux/i.test(agent)
        ? 'Linux'
        : null

  return { label: system ? `${browser} on ${system}` : browser, platform: 'web' }
}

/**
 * Records the device a new session belongs to.
 *
 * Called from sign-in. Every existing session predates devices and has none,
 * which is why `sessions.deviceId` is nullable and nothing here is required
 * for a session to work.
 */
export async function registerDevice(
  input: {
    userId: string
    companyId: string | null
    userAgent?: string | null
    label?: string
  },
  exec: Executor = db,
) {
  const described = describeUserAgent(input.userAgent)

  const [device] = await exec
    .insert(devices)
    .values({
      userId: input.userId,
      companyId: input.companyId,
      label: input.label?.trim() || described.label,
      platform: described.platform,
      // Truncated: enough to recognize a device, not enough to fingerprint one.
      userAgent: input.userAgent?.slice(0, 200) ?? null,
    })
    .returning()

  return device
}

/** Bumps last-seen, and records that the app is running installed. */
export async function touchDevice(
  deviceId: string,
  opts: { isInstalled?: boolean } = {},
): Promise<void> {
  await db
    .update(devices)
    .set({
      lastSeenAt: new Date(),
      ...(opts.isInstalled !== undefined ? { isInstalled: opts.isInstalled } : {}),
    })
    .where(eq(devices.id, deviceId))
}

export type DeviceRow = {
  id: string
  label: string
  platform: DevicePlatform
  isInstalled: boolean
  lastSeenAt: Date
  createdAt: Date
  /** True for the device making this request. */
  isCurrent: boolean
  activeSessions: number
}

/**
 * Devices for the acting user, newest activity first.
 *
 * Scoped to the user rather than the company on purpose: a device belongs to a
 * person, and an owner should not be able to enumerate their bookkeeper's
 * phones from the company settings page.
 */
export async function listDevices(
  ctx: ActorContext,
  currentDeviceId?: string | null,
): Promise<DeviceRow[]> {
  const rows = await db
    .select({
      id: devices.id,
      label: devices.label,
      platform: devices.platform,
      isInstalled: devices.isInstalled,
      lastSeenAt: devices.lastSeenAt,
      createdAt: devices.createdAt,
    })
    .from(devices)
    .where(and(eq(devices.userId, ctx.userId), isNull(devices.revokedAt)))
    .orderBy(desc(devices.lastSeenAt))

  const live = await db
    .select({ deviceId: sessions.deviceId })
    .from(sessions)
    .where(eq(sessions.userId, ctx.userId))

  const counts = new Map<string, number>()
  for (const row of live) {
    if (!row.deviceId) continue
    counts.set(row.deviceId, (counts.get(row.deviceId) ?? 0) + 1)
  }

  return rows.map((row) => ({
    ...row,
    platform: row.platform as DevicePlatform,
    isCurrent: row.id === currentDeviceId,
    activeSessions: counts.get(row.id) ?? 0,
  }))
}

/**
 * Revokes a device and signs out every session on it.
 *
 * The row is marked rather than deleted, so "which device was that operation
 * from" stays answerable after the phone is gone — the same reasoning as the
 * audit log itself.
 *
 * Revoking the device you are currently using is allowed. It is an odd thing
 * to do, but refusing would mean a person with one device and a stolen
 * password could not lock it out at all.
 */
export async function revokeDevice(ctx: ActorContext, deviceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [device] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)))
      .limit(1)

    // Scoped to the acting user: revoking somebody else's device is not a
    // feature, it is a way to lock a colleague out.
    if (!device) throw new Error('Device not found')
    if (device.revokedAt) return

    await tx
      .update(devices)
      .set({ revokedAt: new Date(), revokedBy: ctx.userId })
      .where(eq(devices.id, deviceId))

    // The sessions themselves go, so the next request from that phone resolves
    // to nothing rather than to a valid actor.
    await tx.delete(sessions).where(eq(sessions.deviceId, deviceId))

    await recordAudit(
      ctx,
      {
        action: 'device.revoke',
        entityType: 'device',
        entityId: deviceId,
        before: { label: device.label, platform: device.platform },
        after: { revoked: true },
      },
      tx,
    )
  })
}

/** Renames a device, so "iPhone" can become "Work phone". */
export async function renameDevice(
  ctx: ActorContext,
  deviceId: string,
  label: string,
): Promise<void> {
  const trimmed = label.trim().slice(0, 60)
  if (!trimmed) throw new Refusal('A device needs a name.')

  const result = await db
    .update(devices)
    .set({ label: trimmed })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, ctx.userId)))
    .returning({ id: devices.id })

  if (result.length === 0) throw new Error('Device not found')
}

/**
 * Signs out everywhere except here (spec §14: "revocation").
 *
 * The single button somebody actually wants after a scare: they do not know
 * *which* device is the problem, only that something is wrong. Offering only
 * per-device revocation asks them to identify the attacker's device from a
 * list, which they cannot do.
 *
 * The current device is kept so the person is not signed out mid-panic and
 * left unable to change their password.
 */
export async function revokeAllOtherDevices(
  ctx: ActorContext,
  currentDeviceId: string | null | undefined,
): Promise<{ devicesRevoked: number; sessionsEnded: number }> {
  return db.transaction(async (tx) => {
    const others = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          eq(devices.userId, ctx.userId),
          isNull(devices.revokedAt),
          currentDeviceId ? ne(devices.id, currentDeviceId) : undefined,
        ),
      )

    const now = new Date()
    for (const device of others) {
      await tx
        .update(devices)
        .set({ revokedAt: now, revokedBy: ctx.userId })
        .where(eq(devices.id, device.id))
    }

    // Sessions are deleted by user rather than by device, deliberately. A
    // session whose device is null — every session created before Phase 8 —
    // would survive a device-by-device sweep, which is exactly the session an
    // attacker would rather keep.
    //
    // `IS DISTINCT FROM`, not `<>`. In SQL, `NULL <> 'some-uuid'` evaluates to
    // NULL rather than true, so a plain inequality silently keeps every
    // session that has no device — the precise rows this sweep exists to
    // remove. A test asserts it, because the bug leaves no trace.
    const ended = await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, ctx.userId),
          currentDeviceId
            ? sql`${sessions.deviceId} IS DISTINCT FROM ${currentDeviceId}`
            : undefined,
        ),
      )
      .returning({ id: sessions.id })

    await recordAudit(
      ctx,
      {
        action: 'device.revoke_all',
        entityType: 'user',
        entityId: ctx.userId,
        after: { devicesRevoked: others.length, sessionsEnded: ended.length },
      },
      tx,
    )

    return { devicesRevoked: others.length, sessionsEnded: ended.length }
  })
}
