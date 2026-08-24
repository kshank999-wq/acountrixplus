'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor, currentSession } from '@/lib/current-user'
import { renameDevice, revokeDevice } from '@/modules/mobile/devices'
import {
  setPreference,
  subscribe,
  unsubscribe,
  type NotificationTopic,
} from '@/modules/mobile/notifications'
import { notificationTopicEnum } from '@/db/schema'
import { messageFor } from '@/modules/errors'

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

// --- Devices ---------------------------------------------------------------

export async function revokeDeviceAction(deviceId: string): Promise<ActionResult> {
  return run('/m/settings', async () => {
    const actor = await requireActor()
    await revokeDevice(actor, deviceId)
    return 'Signed that device out.'
  })
}

export async function renameDeviceAction(
  deviceId: string,
  label: string,
): Promise<ActionResult> {
  return run('/m/settings', async () => {
    const actor = await requireActor()
    await renameDevice(actor, deviceId, label)
    return 'Renamed.'
  })
}

// --- Notifications ---------------------------------------------------------

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
})

export async function subscribePushAction(
  input: z.input<typeof subscriptionSchema>,
): Promise<ActionResult> {
  return run('/m/settings', async () => {
    const actor = await requireActor()
    const session = await currentSession()
    const parsed = subscriptionSchema.parse(input)

    await subscribe(actor, { ...parsed, deviceId: session?.deviceId })
    return 'Notifications are on for this device.'
  })
}

export async function unsubscribePushAction(endpoint: string): Promise<ActionResult> {
  return run('/m/settings', async () => {
    const actor = await requireActor()
    await unsubscribe(actor, endpoint)
    return 'Notifications are off for this device.'
  })
}

export async function setNotificationPreferenceAction(
  topic: string,
  enabled: boolean,
): Promise<ActionResult> {
  return run('/m/settings', async () => {
    const actor = await requireActor()
    const parsed = z.enum(notificationTopicEnum.enumValues).parse(topic) as NotificationTopic
    await setPreference(actor, parsed, enabled)
    return enabled ? 'Switched on.' : 'Switched off.'
  })
}
