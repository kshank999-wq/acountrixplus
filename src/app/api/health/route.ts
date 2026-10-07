import { NextResponse } from 'next/server'
import { assessDeployment } from '@/modules/deploy/readiness'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * What this deployment is missing (Phase 175).
 *
 * Behind `CRON_SECRET`, like the worker route, and for a sharper reason: the
 * response is a list of which secrets are unset. That is a map of what to
 * attack, so it is not public even though it contains no values.
 *
 * It exists because the environment that matters is the deployed one.
 * `npm run deploy:check` reads the shell it runs in, which is not the shell
 * Vercel runs — so the only way to know what production is actually missing is
 * to ask production.
 */
function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false

  const header = request.headers.get('authorization')
  if (!header) return false

  const offered = header.startsWith('Bearer ') ? header.slice(7) : header

  if (offered.length !== secret.length) return false
  return offered === secret
}

export async function GET(request: Request) {
  /*
    With `CRON_SECRET` unset this returns 401 — which is also one of the things
    it would have reported. Terse on purpose, matching the worker route: an
    unauthorised caller learns nothing about whether the secret is unset or
    merely wrong.
  */
  if (!authorised(request)) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  const readiness = assessDeployment(process.env)

  return NextResponse.json(
    {
      fitForRealData: readiness.fitForRealData,
      broken: readiness.broken.map((result) => ({ key: result.key, detail: result.detail })),
      silent: readiness.silent.map((result) => ({ key: result.key, detail: result.detail })),
      checks: readiness.results.map((result) => ({
        key: result.key,
        severity: result.severity,
        ok: result.ok,
        detail: result.detail,
      })),
    },
    // 200 even when unfit: the request succeeded and the answer is the body. A
    // 503 here would make a platform health probe restart the deployment over a
    // missing mail provider.
    { status: 200 },
  )
}
