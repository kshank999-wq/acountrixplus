/**
 * Push delivery, behind an adapter (spec §12 credentials stay server-side,
 * §18 provider abstraction).
 *
 * The fifth use of the same shape as `BankProvider`, `AssetStore`,
 * `EmailProvider`, and `AiProvider`: an interface, a mock that needs no
 * credentials, a real adapter loaded through a dynamic import, and a registry
 * keyed by an environment variable.
 *
 * The pattern keeps earning its place for the same reason each time — the
 * tests, the seed, and the demo all run with nothing configured, and the code
 * that decides *what* to notify somebody about never learns how delivery
 * works.
 */

export type PushMessage = {
  title: string
  body: string
  /** Where tapping the notification lands. Same-origin path. */
  url?: string
  /** Groups notifications so five "review your books" become one. */
  tag?: string
}

export type PushTarget = {
  endpoint: string
  p256dh: string
  auth: string
}

export type PushResult =
  | { ok: true }
  /**
   * `gone` means the subscription no longer exists at the push service — the
   * browser was cleared, the app uninstalled. Distinguished from a failure
   * because the right response is to stop trying rather than to retry.
   */
  | { ok: false; gone: boolean; error: string }

export interface PushProvider {
  readonly key: string
  /** False when credentials are missing; the registry falls back to the mock. */
  isConfigured(): boolean
  send(target: PushTarget, message: PushMessage): Promise<PushResult>
}

/**
 * The built-in adapter. Records what it would have sent and delivers nothing.
 *
 * This is what the tests and the demo run on. It is honest about being a mock
 * — the notification log records `mock` as the provider, so nobody mistakes a
 * green tick here for a notification that reached a phone.
 */
export class MockPushProvider implements PushProvider {
  readonly key = 'mock'
  /** Exposed so tests can assert on what would have gone out. */
  readonly sent: Array<{ endpoint: string; message: PushMessage }> = []

  isConfigured(): boolean {
    return true
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    // A recognizable sentinel, so a test can exercise the gone-subscription
    // path without inventing a fake push service.
    if (target.endpoint.includes('/gone/')) {
      return { ok: false, gone: true, error: 'Subscription no longer exists.' }
    }
    if (target.endpoint.includes('/fail/')) {
      return { ok: false, gone: false, error: 'Push service unavailable.' }
    }

    this.sent.push({ endpoint: target.endpoint, message })
    return { ok: true }
  }

  reset() {
    this.sent.length = 0
  }
}

/**
 * Web Push, through the `web-push` library.
 *
 * The library is loaded inside `send` so a deployment without it — which is
 * every deployment until somebody chooses to install it — never tries to
 * resolve the module at import time. Same trick as the Anthropic adapter, for
 * the same reason.
 *
 * VAPID keys are read from the environment and never leave the server. They
 * are the credential that lets *this* server push to a subscription, so a key
 * in a browser bundle would let anyone push to every subscriber.
 */
export class WebPushProvider implements PushProvider {
  readonly key = 'webpush'

  isConfigured(): boolean {
    return Boolean(
      process.env.VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY &&
        process.env.VAPID_SUBJECT,
    )
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    if (!this.isConfigured()) {
      return { ok: false, gone: false, error: 'VAPID keys are not configured.' }
    }

    try {
      const webpush = await import('web-push').then((module) => module.default ?? module)

      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT!,
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!,
      )

      await webpush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        JSON.stringify(message),
        { TTL: 60 * 60 * 12 },
      )

      return { ok: true }
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      return {
        ok: false,
        // 404 and 410 both mean the subscription is dead.
        gone: status === 404 || status === 410,
        // Truncated: a provider error can carry a request body, and this
        // string goes into the notification log.
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      }
    }
  }
}

const providers = new Map<string, PushProvider>()

export function registerPushProvider(provider: PushProvider): void {
  providers.set(provider.key, provider)
}

registerPushProvider(new MockPushProvider())
registerPushProvider(new WebPushProvider())

/**
 * The provider in use.
 *
 * Falls back to the mock when the selected adapter reports itself
 * unconfigured, so a deployment that switched to `webpush` and has not set the
 * keys yet gets a warning and a working app rather than an exception on every
 * notification.
 */
export function getPushProvider(key?: string): PushProvider {
  const requested = key ?? process.env.PUSH_PROVIDER ?? 'mock'
  const provider = providers.get(requested)

  if (!provider) {
    throw new Error(
      `Unknown push provider "${requested}". Registered: ${[...providers.keys()].join(', ')}`,
    )
  }

  return provider.isConfigured() ? provider : providers.get('mock')!
}

/** What the admin page shows about each adapter. */
export function pushProviderStatus() {
  return [...providers.values()].map((provider) => ({
    key: provider.key,
    configured: provider.isConfigured(),
  }))
}

/**
 * The public VAPID key, which the browser needs to subscribe.
 *
 * Public in the cryptographic sense and safe to send to a client — it is the
 * *private* key that signs, and that one never leaves the server.
 */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null
}
