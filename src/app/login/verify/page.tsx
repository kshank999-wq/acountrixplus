import Link from 'next/link'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { currentActor } from '@/lib/current-user'
import { CHALLENGE_COOKIE, challengeSubject } from '@/modules/auth/challenge'
import { VerifyForm } from './verify-form'

/**
 * Step two of signing in (spec §14).
 *
 * The page is reachable only with a challenge cookie, and the cookie grants
 * nothing but the right to be here. Somebody who navigates to this URL without
 * one is sent back to the start rather than shown a code box that could never
 * work.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const destination = next && /^\/[^/\\]/.test(next) ? next : '/bookkeeping'

  if (await currentActor()) redirect(destination)

  const cookieStore = await cookies()
  if (!challengeSubject(cookieStore.get(CHALLENGE_COOKIE)?.value)) redirect('/login')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted">
          Your password was accepted. Enter the six-digit code from your authenticator app.
        </p>
      </div>

      <div className="card p-6">
        <VerifyForm next={destination} />
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        Lost your phone? Enter one of your recovery codes above instead.
      </p>
      <p className="mt-2 text-center text-sm">
        <Link href="/login" className="font-medium text-action hover:underline">
          Start again
        </Link>
      </p>
    </main>
  )
}
