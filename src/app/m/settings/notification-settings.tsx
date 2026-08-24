'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  setNotificationPreferenceAction,
  subscribePushAction,
  unsubscribePushAction,
} from '@/app/actions/mobile'
import { messageFor } from '@/modules/errors'

type Topic = { topic: string; label: string; description: string; enabled: boolean }
type Recent = { id: string; title: string; outcome: string; createdAt: string }

/**
 * Notification settings.
 *
 * Two levels, and keeping them apart is the point:
 *
 *  1. **This device** — a browser permission and a push subscription. Granting
 *     it is a decision about *this phone*.
 *  2. **These topics** — what is worth interrupting you about. A decision about
 *     you, on every device.
 *
 * Collapsing them into one switch is the usual mistake: it means turning off a
 * category you dislike costs you every notification on that device, so people
 * turn the lot off instead and the feature dies.
 */
export function NotificationSettings({
  topics,
  vapidPublicKey,
  providerNote,
  recent,
}: {
  topics: Topic[]
  vapidPublicKey: string | null
  providerNote: string | null
  recent: Recent[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [subscribed, setSubscribed] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setPermission('unsupported')
      return
    }

    setPermission(Notification.permission)

    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setSubscribed(Boolean(subscription)))
      .catch(() => setSubscribed(false))
  }, [])

  async function enable() {
    setMessage(null)

    const granted = await Notification.requestPermission()
    setPermission(granted)

    if (granted !== 'granted') {
      setMessage({
        text: 'Your browser declined. You can change that in its site settings.',
        ok: false,
      })
      return
    }

    if (!vapidPublicKey) {
      // Honest rather than a fake success: without a server key there is
      // nothing to subscribe to, and pretending otherwise means a person waits
      // for notifications that can never arrive.
      setMessage({
        text: 'Permission granted, but the server has no push key configured yet.',
        ok: false,
      })
      return
    }

    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })

      const json = subscription.toJSON() as {
        endpoint?: string
        keys?: { p256dh?: string; auth?: string }
      }

      startTransition(async () => {
        const result = await subscribePushAction({
          endpoint: json.endpoint ?? '',
          p256dh: json.keys?.p256dh ?? '',
          auth: json.keys?.auth ?? '',
        })
        setMessage({ text: result.ok ? (result.message ?? 'On.') : result.error, ok: result.ok })
        if (result.ok) {
          setSubscribed(true)
          router.refresh()
        }
      })
    } catch (error) {
      setMessage({
        text: messageFor(error, 'Could not subscribe.'),
        ok: false,
      })
    }
  }

  async function disable() {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return

    const endpoint = subscription.endpoint
    await subscription.unsubscribe()

    startTransition(async () => {
      const result = await unsubscribePushAction(endpoint)
      setMessage({ text: result.ok ? (result.message ?? 'Off.') : result.error, ok: result.ok })
      setSubscribed(false)
      router.refresh()
    })
  }

  function toggleTopic(topic: string, enabled: boolean) {
    startTransition(async () => {
      const result = await setNotificationPreferenceAction(topic, enabled)
      if (!result.ok) setMessage({ text: result.error, ok: false })
      router.refresh()
    })
  }

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Notifications</h2>
      </header>

      <div className="border-b border-line p-4">
        {permission === 'unsupported' ? (
          <p className="text-xs text-muted">
            This browser does not support notifications. Everything else works normally.
          </p>
        ) : subscribed ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">Notifications are on for this device.</p>
            <button className="btn px-2 py-1 text-xs" disabled={pending} onClick={() => void disable()}>
              Turn off
            </button>
          </div>
        ) : (
          <div>
            <p className="text-sm">Notifications are off for this device.</p>
            <button
              className="btn btn-primary mt-2 min-h-[2.75rem] w-full text-sm"
              disabled={pending || permission === 'denied'}
              onClick={() => void enable()}
            >
              {permission === 'denied' ? 'Blocked in browser settings' : 'Turn on'}
            </button>
          </div>
        )}

        {providerNote && <p className="mt-2 text-xs text-muted">{providerNote}</p>}
      </div>

      <ul className="divide-y divide-line">
        {topics.map((topic) => (
          <li key={topic.topic} className="flex items-start gap-3 p-4">
            <input
              id={`topic-${topic.topic}`}
              type="checkbox"
              className="mt-1"
              checked={topic.enabled}
              disabled={pending}
              onChange={(event) => toggleTopic(topic.topic, event.target.checked)}
            />
            <label htmlFor={`topic-${topic.topic}`} className="min-w-0 flex-1 cursor-pointer">
              <span className="text-sm font-medium">{topic.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{topic.description}</span>
            </label>
          </li>
        ))}
      </ul>

      {recent.length > 0 && (
        <div className="border-t border-line p-4">
          <p className="mb-2 text-xs font-medium text-muted">Recently sent</p>
          <ul className="space-y-1">
            {recent.map((entry) => (
              <li key={entry.id} className="flex justify-between gap-3 text-xs">
                <span className="min-w-0 truncate">{entry.title}</span>
                <span className="shrink-0 text-faint">{entry.outcome.replace('_', ' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {message && (
        <p
          className={`border-t border-line px-4 py-2 text-xs ${
            message.ok ? 'text-positive' : 'text-negative'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  )
}

/**
 * The VAPID public key arrives base64url-encoded; `pushManager.subscribe`
 * wants raw bytes. Standard conversion, and the one piece of Web Push boiler-
 * plate there is no way around.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)

  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}
