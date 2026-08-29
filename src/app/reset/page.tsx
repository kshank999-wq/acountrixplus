import Link from 'next/link'
import { checkResetToken } from '@/modules/notify/password-reset'
import { ResetForm } from './reset-form'

export const dynamic = 'force-dynamic'

const REASONS: Record<string, string> = {
  expired: 'That link has expired. Links last an hour — ask for a fresh one.',
  used: 'That link has already been used. If it was not you, ask for another one now.',
  revoked: 'That link was replaced by a newer one. Use the most recent email.',
  not_found: 'That link is not valid. Check you copied the whole thing, or ask for a new one.',
}

/**
 * Choose a new password (spec §19).
 *
 * The token is checked here, before anything is rendered, so a dead link says
 * so immediately instead of after somebody has chosen and typed a password
 * twice. Checking does not spend it — see `lookupToken` versus `redeemToken`.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const checked = token ? await checkResetToken(token) : { ok: false as const, reason: 'not_found' }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted">Accountrix Plus</p>
      </div>

      <div className="card p-6">
        {checked.ok ? (
          <ResetForm token={token as string} email={checked.email} />
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-danger">{REASONS[checked.reason] ?? REASONS.not_found}</p>
            <Link href="/forgot" className="btn btn-primary w-full">
              Send me a new link
            </Link>
          </div>
        )}
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className="font-medium text-action hover:underline">
          Back to sign in
        </Link>
      </p>
    </main>
  )
}
