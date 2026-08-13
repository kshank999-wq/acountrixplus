'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker and keeps the outbox draining.
 *
 * Rendered once from the mobile layout. It has no UI — the queue's state is
 * shown by `OutboxBadge`, which reads the same store.
 *
 * ## Why there are four triggers
 *
 * Draining on `online` alone is not enough, and each of the others covers a
 * case that actually happens:
 *
 *  - **`online`** — the obvious one, and the least reliable. Browsers report it
 *    when the interface comes up, which is before the network works.
 *  - **`visibilitychange`** — a phone that was in a pocket during the whole
 *    outage never fired `online`, because the tab was frozen. Coming back to it
 *    is when the person expects their work to have gone.
 *  - **A slow interval** — covers a captive portal or a connection that lied.
 *    Sixty seconds, because a queue that is behind by a minute is fine and one
 *    that polls hard on a phone battery is not.
 *  - **The service worker's Background Sync message** — the only one that works
 *    when the app was closed during the outage.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    let cancelled = false

    async function register() {
      if (!('serviceWorker' in navigator)) return
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      } catch {
        // A registration failure is not fatal: the app works online without
        // it, and saying so in a console the user will never open helps
        // nobody.
      }
    }

    async function drain() {
      if (cancelled || !navigator.onLine) return
      const { drainOutbox } = await import('./outbox-client')
      const installed = window.matchMedia('(display-mode: standalone)').matches
      await drainOutbox({ installed }).catch(() => {})
      window.dispatchEvent(new CustomEvent('accountrix:outbox-changed'))
    }

    void register()
    void drain()

    const onOnline = () => void drain()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void drain()
    }
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'drain-outbox') void drain()
    }

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    const timer = window.setInterval(() => void drain(), 60_000)

    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
      window.clearInterval(timer)
    }
  }, [])

  return null
}
