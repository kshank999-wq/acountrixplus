import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/current-user'
import { industryOptions } from '@/modules/coa/industry'
import { RegisterForm } from './register-form'

export default async function RegisterPage() {
  if (await currentActor()) redirect('/bookkeeping')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your company</h1>
        <p className="mt-1 text-sm text-muted">
          Choosing an industry installs a matching chart of accounts. You can change any of it
          later.
        </p>
      </div>

      <div className="card p-6">
        <RegisterForm industries={industryOptions()} />
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-action hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  )
}
