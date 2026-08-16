import Link from 'next/link'
import { ForgotForm } from './forgot-form'

export const dynamic = 'force-dynamic'

/**
 * "I forgot my password" (spec §19).
 *
 * Reachable without a session, which is the whole point, and therefore reachable
 * by anybody on the internet — so it neither confirms nor denies that an address
 * exists. See `src/modules/notify/password-reset.ts`.
 */
export default function ForgotPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
        <p className="mt-1 text-sm text-muted">
          Type the address you sign in with and we will send you a link.
        </p>
      </div>

      <div className="card p-6">
        <ForgotForm />
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        Remembered it?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  )
}
