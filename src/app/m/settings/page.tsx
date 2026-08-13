import { requireActor, currentSession } from '@/lib/current-user'
import { listDevices } from '@/modules/mobile/devices'
import { preferences, recentNotifications } from '@/modules/mobile/notifications'
import { pushProviderStatus, vapidPublicKey } from '@/modules/mobile/push-provider'
import { DeviceList } from './device-list'
import { NotificationSettings } from './notification-settings'

export const dynamic = 'force-dynamic'

/**
 * Mobile settings: the devices signed in, and what this app is allowed to
 * interrupt you about.
 *
 * Both are on the phone rather than only in the desktop app, because both are
 * things a person reaches for on a phone — "sign out the one I lost" is a
 * thing you do the moment you notice, from whatever is in your hand.
 */
export default async function MobileSettingsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  const [devices, topics, history] = await Promise.all([
    listDevices(actor, session?.deviceId),
    preferences(actor),
    recentNotifications(actor, 10),
  ])

  const providers = pushProviderStatus()
  const configured = Boolean(vapidPublicKey())

  return (
    <div className="space-y-4">
      <NotificationSettings
        topics={topics}
        vapidPublicKey={vapidPublicKey()}
        // Said plainly rather than hidden: on the built-in provider the
        // switches work and nothing reaches a phone, and a person who tests it
        // deserves to know that before concluding notifications are broken.
        providerNote={
          configured
            ? null
            : `Push delivery is running on the built-in "${providers.find((p) => p.configured)?.key ?? 'mock'}" adapter, which records notifications and sends none. Set VAPID keys on the server to deliver them.`
        }
        recent={history.map((row) => ({
          id: row.id,
          title: row.title,
          outcome: row.outcome,
          createdAt: row.createdAt?.toISOString() ?? '',
        }))}
      />

      <DeviceList
        devices={devices.map((device) => ({
          id: device.id,
          label: device.label,
          platform: device.platform,
          isInstalled: device.isInstalled,
          isCurrent: device.isCurrent,
          lastSeenAt: device.lastSeenAt?.toISOString() ?? '',
        }))}
      />
    </div>
  )
}
