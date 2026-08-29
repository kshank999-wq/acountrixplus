import Link from 'next/link'
import { Logo } from '@/components/logo'
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/current-user'
import { LoginForm } from './login-form'

/**
 * Sign in.
 *
 * `?next=` is honoured so the mobile app can send an unauthenticated visitor
 * here and get them back — a phone that opened a notification link should land
 * where the notification pointed, not on the desktop inbox.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  // Only same-origin paths, never a full URL: `?next=https://evil.example` on
  // a login page is the classic open-redirect phishing setup.
  const destination = next && /^\/[^/\\]/.test(next) ? next : '/bookkeeping'

  if (await currentActor()) redirect(destination)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <Logo markClassName="h-9 w-9" wordClassName="text-xl" />
        <p className="mt-3 text-sm text-muted">Sign in to your books.</p>
      </div>

      <div className="card p-6">
        <LoginForm next={destination} />
      </div>

      <p className="mt-4 text-center text-sm">
        <Link href="/forgot" className="text-muted hover:underline">
          Forgot your password?
        </Link>
      </p>

      <p className="mt-2 text-center text-sm text-muted">
        New here?{' '}
        <Link href="/register" className="font-medium text-action hover:underline">
          Set up a company
        </Link>
      </p>
    </main>
  )
}
