import { requireSession } from '@/lib/current-user'
import { completeAddressChange } from '@/modules/notify/email-change'

export const dynamic = 'force-dynamic'

/**
 * Where a claimed sign-in address is confirmed (Phase 98).
 *
 * Behind the session, unlike `/reset`. A reset has to work for somebody who
 * cannot sign in, which is its whole point; this is somebody who *is* signed in
 * and is moving where their letters go. Requiring the session means the link
 * alone is not enough — whoever opens it must also already be the account.
 *
 * The token is spent on load rather than behind a button. That is the right
 * trade for a link whose only effect is one the recipient asked for and can see
 * described in the letter they are holding, and the alternative — a page that
 * does nothing until clicked — leaves the claim live while somebody wanders
 * off, which is exactly the state Phase 98 tries not to leave lying around.
 */
export default async function ConfirmAddressPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const session = await requireSession()
  const { token } = await searchParams

  const result = token
    ? await completeAddressChange({ token, companyName: session.companyName })
    : ({ ok: false, error: 'That link is missing its token.' } as const)

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-xl font-semibold">
        {result.ok ? 'That address is yours now' : 'That did not work'}
      </h1>

      {result.ok ? (
        <>
          <p className="mt-2 text-sm">
            You now sign in as <strong>{result.email}</strong>.
          </p>
          <p className="mt-2 text-sm text-muted">
            {result.previous} can no longer be used to sign in or to reset the password, and has
            been told so.
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">{result.error}</p>
      )}

      <p className="mt-6 text-sm">
        <a className="underline" href="/settings/security">
          Back to security settings
        </a>
      </p>
    </main>
  )
}
