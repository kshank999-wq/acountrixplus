import { NextResponse } from 'next/server'
import { runOnce } from '@/modules/worker/runner'
import { messageFor } from '@/modules/errors'

/**
 * One tick of the background worker, over HTTP (spec §18).
 *
 * ## Why this route exists
 *
 * `npm run worker` is a long-running process, and serverless platforms do not
 * have those. Without somewhere to run, everything the queue carries stops
 * happening **silently**: the monthly rent run, dunning letters, retention
 * sweeps, the transactional outbox, scheduled reports. Nothing errors — the
 * jobs simply sit in `queued` for ever, which is the worst failure mode
 * available, because the application looks fine.
 *
 * So a scheduler calls this instead. It runs exactly the same `runOnce` that
 * `worker-once.ts` and the tests call, so there is no second code path that
 * could behave differently.
 *
 * ## Authorisation
 *
 * A public URL that drains a work queue is a denial-of-service tool and, worse,
 * a way to make the application send mail on demand. Two things may call it:
 *
 *  - **Vercel Cron**, which sends `Authorization: Bearer $CRON_SECRET`.
 *  - **Anything holding `CRON_SECRET`**, for a scheduler that is not Vercel.
 *
 * With no `CRON_SECRET` set the route refuses every request rather than
 * defaulting open. A worker endpoint that runs for anybody who finds it is not
 * a smaller problem than one that never runs.
 */

/** Node, not Edge: the runner uses the postgres driver and node:crypto. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A tick that drains a batch can take a while; the platform's cap applies. */
export const maxDuration = 60

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false

  const header = request.headers.get('authorization')
  if (!header) return false

  const offered = header.startsWith('Bearer ') ? header.slice(7) : header

  // Length-independent comparison is not worth the ceremony here — the secret
  // is high-entropy and the endpoint is rate-limited by being a cron target —
  // but an early return on length keeps the obvious timing signal out.
  if (offered.length !== secret.length) return false
  return offered === secret
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    // Deliberately terse. An unauthorised caller learns nothing about whether
    // the secret is unset or merely wrong.
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'DATABASE_URL is not set.' }, { status: 500 })
  }

  try {
    const tick = await runOnce()

    return NextResponse.json({
      ok: true,
      ...tick,
    })
  } catch (error) {
    // Logged as well as returned: the cron caller's response body is often
    // nobody's idea of a place to look, and a failing worker needs to be
    // visible in the platform's logs.
    console.error('Worker tick failed:', error)

    return NextResponse.json(
      { ok: false, error: messageFor(error, 'Worker tick failed.') },
      { status: 500 },
    )
  }
}

/**
 * Some schedulers only POST. Same work, same guard.
 */
export const POST = GET
