import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTransactionalProvider,
  PostmarkProvider,
  ResendProvider,
  transactionalProviderKeys,
} from '@/modules/notify/providers'
import { retryableStatus } from '@/modules/notify/providers/http'
import {
  getTransactionalProvider,
  resetTransactionalProvider,
  type TransactionalMessage,
} from '@/modules/notify/transactional'

/**
 * Mail that actually leaves the building (Phase 38).
 *
 * The interface has carried `retryable` since Phase 19 and nothing has ever
 * produced a meaningful value, because the only adapter was the mock and the
 * mock always succeeds. These tests are mostly about that field.
 */

const MESSAGE: TransactionalMessage = {
  to: 'sam@example.test',
  toName: 'Sam Hartley',
  fromName: 'Accountrix Plus',
  fromEmail: 'no-reply@accountrixplus.test',
  subject: 'Reset your password',
  html: '<p>Reset</p>',
  text: 'Reset',
  kind: 'password_reset',
}

/**
 * A `fetch` that answers with the given status and body.
 *
 * Parameters are declared even though they are unused, so the mock's call
 * tuple is typed and a test can read back what was sent.
 */
function answering(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

/** The request body of the first call, parsed. */
function sentBody(mock: ReturnType<typeof answering>): Record<string, unknown> {
  const init = mock.mock.calls[0]?.[1]
  if (!init?.body) throw new Error('fetch was not called with a body')
  return JSON.parse(String(init.body))
}

/** The request headers of the first call. */
function sentHeaders(mock: ReturnType<typeof answering>): Record<string, string> {
  const init = mock.mock.calls[0]?.[1]
  if (!init?.headers) throw new Error('fetch was not called with headers')
  return init.headers as Record<string, string>
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.unstubAllEnvs()
  resetTransactionalProvider()
})

describe('retryableStatus', () => {
  it('retries what the provider could not take just now', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(retryableStatus(status), `${status}`).toBe(true)
    }
  })

  it('does not retry what the provider understood and refused', () => {
    // A bad key, a malformed address, an unverified sending domain. None of
    // these get better by asking again, and retrying them forever is how a
    // queue fills up with mail that will never send.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(retryableStatus(status), `${status}`).toBe(false)
    }
  })
})

describe('ResendProvider', () => {
  it('returns the provider id on success', async () => {
    globalThis.fetch = answering(200, { id: 're_abc123' })
    const result = await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)
    expect(result).toEqual({ ok: true, providerMessageId: 're_abc123' })
  })

  it('sends the address with a quoted display name', async () => {
    const fetchMock = answering(200, { id: 're_abc123' })
    globalThis.fetch = fetchMock
    await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)

    const body = sentBody(fetchMock)
    expect(body.to).toEqual(['"Sam Hartley" <sam@example.test>'])
    expect(body.from).toBe('"Accountrix Plus" <no-reply@accountrixplus.test>')
  })

  it('tags what the message is, never who it is for', async () => {
    const fetchMock = answering(200, { id: 're_abc123' })
    globalThis.fetch = fetchMock
    await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)

    const body = sentBody(fetchMock)
    expect(body.tags).toEqual([{ name: 'kind', value: 'password_reset' }])
    expect(JSON.stringify(body.tags)).not.toContain('sam@example.test')
  })

  it('treats a rate limit as retryable', async () => {
    globalThis.fetch = answering(429, { message: 'Too many requests' })
    const result = await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect((result as { error: string }).error).toContain('Too many requests')
  })

  it('treats a rejected key as permanent', async () => {
    globalThis.fetch = answering(401, { message: 'API key is invalid' })
    const result = await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
  })

  it('treats an unreachable provider as retryable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const result = await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect((result as { error: string }).error).toContain('Could not reach')
  })

  it('refuses to invent an id when none came back', async () => {
    globalThis.fetch = answering(200, {})
    const result = await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
  })

  it('stays diagnosable when the body is not JSON', async () => {
    globalThis.fetch = answering(502, '<html>Bad gateway</html>')
    const result = await new ResendProvider({ apiKey: 'k' }).send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect((result as { error: string }).error).toContain('Bad gateway')
  })
})

describe('PostmarkProvider', () => {
  it('returns the provider id on success', async () => {
    globalThis.fetch = answering(200, { ErrorCode: 0, MessageID: 'pm-1' })
    const result = await new PostmarkProvider({ token: 't' }).send(MESSAGE)
    expect(result).toEqual({ ok: true, providerMessageId: 'pm-1' })
  })

  /**
   * The case that justifies a second adapter existing at all: Postmark can say
   * 200 and mean no. With one implementation this branch would never have been
   * written, and a rejected message would have been recorded as sent.
   */
  it('reads a rejection out of a 200', async () => {
    globalThis.fetch = answering(200, { ErrorCode: 406, Message: 'Inactive recipient' })
    const result = await new PostmarkProvider({ token: 't' }).send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect((result as { error: string }).error).toContain('Inactive recipient')
  })

  it('retries only its rate-limit code', async () => {
    globalThis.fetch = answering(200, { ErrorCode: 429, Message: 'Rate limited' })
    expect(await new PostmarkProvider({ token: 't' }).send(MESSAGE)).toMatchObject({
      ok: false,
      retryable: true,
    })

    globalThis.fetch = answering(200, { ErrorCode: 300, Message: 'Invalid email request' })
    expect(await new PostmarkProvider({ token: 't' }).send(MESSAGE)).toMatchObject({
      ok: false,
      retryable: false,
    })
  })

  it('sends transactional mail down the transactional stream', async () => {
    const fetchMock = answering(200, { ErrorCode: 0, MessageID: 'pm-1' })
    globalThis.fetch = fetchMock
    await new PostmarkProvider({ token: 't' }).send(MESSAGE)

    expect(sentBody(fetchMock).MessageStream).toBe('outbound')
    expect(sentHeaders(fetchMock)['x-postmark-server-token']).toBe('t')
  })
})

describe('choosing a provider', () => {
  beforeEach(() => resetTransactionalProvider())

  it('defaults to the mock, so nothing sends without being asked', () => {
    vi.stubEnv('TRANSACTIONAL_EMAIL_PROVIDER', '')
    expect(getTransactionalProvider().key).toBe('mock')
  })

  it('builds the named adapter', () => {
    vi.stubEnv('TRANSACTIONAL_EMAIL_PROVIDER', 'resend')
    vi.stubEnv('RESEND_API_KEY', 're_test')
    expect(getTransactionalProvider().key).toBe('resend')
  })

  /**
   * The failure this is here to prevent: a deployment that believes it
   * configured a real sender, silently keeping every password reset in memory.
   */
  it('refuses an unknown name rather than falling back to the mock', () => {
    vi.stubEnv('TRANSACTIONAL_EMAIL_PROVIDER', 'sendgrid')
    expect(() => getTransactionalProvider()).toThrow(/Unknown transactional email provider/)
  })

  it('refuses a known name whose credentials are missing', () => {
    vi.stubEnv('TRANSACTIONAL_EMAIL_PROVIDER', 'postmark')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', '')
    expect(() => getTransactionalProvider()).toThrow(/POSTMARK_SERVER_TOKEN is not set/)
  })

  it('only constructs the adapter that was asked for', () => {
    // Postmark selected, no Resend key anywhere. Eagerly constructing every
    // adapter would fail this deployment for a provider it does not use.
    vi.stubEnv('TRANSACTIONAL_EMAIL_PROVIDER', 'postmark')
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'pm_test')
    vi.stubEnv('RESEND_API_KEY', '')
    expect(getTransactionalProvider().key).toBe('postmark')
  })

  it('lists what it accepts', () => {
    expect(transactionalProviderKeys().sort()).toEqual(['postmark', 'resend'])
    expect(() => buildTransactionalProvider('nope')).toThrow(/Available: mock, /)
  })
})
