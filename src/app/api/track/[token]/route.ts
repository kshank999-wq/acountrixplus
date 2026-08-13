import { NextResponse, type NextRequest } from 'next/server'
import { recordOpen, recordClick } from '@/modules/marketing/engagement'
import { truncateIp } from '@/modules/crm/intake'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Open and click tracking (spec §10).
 *
 * The third and fourth unauthenticated entry points. Both are reached from a
 * link inside a delivered email, so neither can rely on a session, and both
 * must behave identically for a valid and an invalid token — an attacker
 * probing tokens should learn nothing about which ones exist.
 *
 * With no `?u=` parameter this is the tracking pixel; with one it is a click
 * redirect. Combining them means one route, one token, one shape of URL in the
 * email, and one place where the destination is re-validated.
 */

/** A 1×1 transparent GIF. Smaller than a PNG and universally supported. */
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)

function pixelResponse() {
  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      'content-type': 'image/gif',
      // Never cached: a cached pixel would record one open and hide the rest,
      // and a shared proxy cache would attribute one person's open to another.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      'content-length': String(PIXEL.length),
    },
  })
}

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  const destination = request.nextUrl.searchParams.get('u')

  const meta = {
    ipPrefix: truncateIp(
      request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip'),
    ),
    userAgent: request.headers.get('user-agent'),
  }

  if (destination) {
    const result = await recordClick(token, destination, meta)

    // An unknown token or an unsafe destination lands on the home page rather
    // than following the URL — a tracking link must never become an open
    // redirect just because the token did not resolve.
    return NextResponse.redirect(
      result.ok ? result.destination : new URL('/', request.nextUrl.origin),
      { status: 302 },
    )
  }

  // Recording an open must never break the image. A reader whose mail client
  // fetched this should see nothing either way.
  try {
    await recordOpen(token, meta)
  } catch {
    // Swallowed on purpose: analytics must not cost a rendered email.
  }

  return pixelResponse()
}
