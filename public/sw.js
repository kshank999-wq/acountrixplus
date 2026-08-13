/**
 * The service worker (spec §18 PWA).
 *
 * ## The one rule
 *
 * **Nothing that changes data is ever cached, and nothing cached is ever
 * assumed fresh.** A bookkeeping app that serves a stale balance is worse than
 * one that says it is offline, because a stale number looks like a real
 * number. Every strategy below follows from that.
 *
 * ## What is cached, and why
 *
 *  - The **app shell** (`/offline.html`, icons, manifest) is precached, so the
 *    app opens on a plane instead of showing the browser's dinosaur. It is a
 *    plain HTML file rather than a page in the app, because a framework page
 *    needs a JavaScript chunk that an offline device has never downloaded.
 *  - **Static build assets** (`/_next/static/...`) are cache-first. They are
 *    content-hashed, so a cached one can never be the wrong version.
 *  - **Everything else** is network-first with a cached fallback, and the
 *    fallback is only used when the network genuinely fails.
 *  - **`/api/**` is never cached.** Not network-first — never. A GET to the
 *    sync endpoint returns one user's live state, and a cache that served it
 *    to the next person on a shared device would be a data leak rather than a
 *    stale page.
 *
 * ## Why this is hand-written
 *
 * A generated service worker is a large amount of code nobody on the team has
 * read, running with the ability to intercept every request the app makes.
 * This one is ninety lines and the caching decisions are visible.
 */

const VERSION = 'v2'
const SHELL_CACHE = `accountrix-shell-${VERSION}`
const RUNTIME_CACHE = `accountrix-runtime-${VERSION}`

/** Precached at install: enough to render *something* with no network. */
const SHELL = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, not `addAll`: one 404 in the list would otherwise fail
      // the whole install and leave the app with no service worker at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('accountrix-') && !key.endsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Only GET is ever considered. A POST is a decision somebody made; replaying
  // one from a cache would be a way to post a journal entry twice.
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Cross-origin requests are none of this worker's business.
  if (url.origin !== self.location.origin) return

  // Never cache the API. Not even the read half — it is per-user live state.
  if (url.pathname.startsWith('/api/')) return

  // Content-hashed build output: safe to serve from cache forever.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request))
    return
  }

  event.respondWith(networkFirst(request))
})

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE)
    cache.put(request, response.clone())
  }
  return response
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)

    // Only successful, complete responses are worth keeping. A 206 or an
    // opaque redirect in the cache causes stranger failures than a miss.
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(RUNTIME_CACHE)
      cache.put(request, response.clone())
    }

    return response
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached

    // A navigation with nothing cached gets the offline page rather than a
    // browser error, so the app can explain itself and show the outbox.
    if (request.mode === 'navigate') {
      const offline = await caches.match('/offline.html')
      if (offline) return offline
    }

    throw error
  }
}

/**
 * Push delivery.
 *
 * The payload is JSON produced by `modules/mobile/notifications.ts`. A push
 * that arrives without one still shows something — a browser that displays no
 * notification after granting permission looks broken, and on some platforms a
 * silent push costs the site its permission.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'Accountrix Plus', body: 'You have an update.' }

  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // Malformed payload: fall through to the default above.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Collapses repeats, so five nudges are one notification.
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      data: { url: payload.url ?? '/m' },
    }),
  )
})

/**
 * Tapping a notification.
 *
 * Focuses an open window rather than opening a second one — a person who
 * already has the app open and taps a notification wants the app they have,
 * not a duplicate.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url ?? '/m'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(target) && 'focus' in client) return client.focus()
      }
      if (clients.length > 0 && 'navigate' in clients[0]) {
        return clients[0].focus().then((focused) => focused.navigate(target))
      }
      return self.clients.openWindow(target)
    }),
  )
})

/**
 * Background Sync: drains the outbox once connectivity returns, even if the
 * app was closed in the meantime.
 *
 * The page owns the queue, so all this does is wake it up. Where Background
 * Sync is unsupported — Safari, notably — the page drains on its own `online`
 * event instead, which covers everything except "the user closed the tab
 * before reconnecting".
 */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'accountrix-outbox') return

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: 'drain-outbox' })
      }
    }),
  )
})
