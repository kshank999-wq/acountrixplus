import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/current-user'
import { LoginForm } from './login-form'

export default async function LoginPage() {
  if (await currentActor()) redirect('/bookkeeping')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Accountrix Plus</h1>
        <p className="mt-1 text-sm text-muted">Sign in to your books.</p>
      </div>

      <div className="card p-6">
        <LoginForm />
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <Link href="/register" className="font-medium text-brand hover:underline">
          Set up a company
        </Link>
      </p>
    </main>
  )
}
