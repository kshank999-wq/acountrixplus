import { NextResponse, type NextRequest } from 'next/server'
import { unsubscribeByToken } from '@/modules/marketing/engagement'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * One-click unsubscribe (spec §10, §19).
 *
 * POST, not GET, because a link that changes state on fetch gets triggered by
 * every mail client that pre-fetches and every scanner that follows links.
 *
 * This is also the target of the `List-Unsubscribe` header, and RFC 8058
 * specifies exactly this: a POST the mail client makes on the reader's behalf
 * when they press its own unsubscribe button.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  const result = await unsubscribeByToken(token)

  if (!result.ok) {
    // Deliberately vague, and deliberately not a 404 with detail: an unknown
    // token must be indistinguishable from a valid one already used.
    return NextResponse.json({ ok: false }, { status: 404 })
  }

  return NextResponse.json({
    ok: true,
    alreadyUnsubscribed: result.alreadyUnsubscribed,
  })
}
