import Link from 'next/link'
import { previewInvitation } from '@/modules/notify/invitations'
import { InviteForm } from './invite-form'

export const dynamic = 'force-dynamic'

/**
 * Accept an invitation (spec §14, §19).
 *
 * What is on offer is shown before anybody types: which books, in what role,
 * and at which address. An invitation that only says "you have been invited"
 * asks somebody to create an account on faith, and gives them no way to notice
 * that the link is for the wrong company.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const result = token
    ? await previewInvitation(token)
    : ({ ok: false, reason: 'That invitation link is not valid.' } as const)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {result.ok ? result.preview.destination : 'Accountrix Plus'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {result.ok ? (
            result.preview.kind === 'company' ? (
              <>
                You have been invited to these books
                {result.preview.role && <> as {result.preview.role}</>}.
              </>
            ) : (
              <>You have been invited to work at this practice.</>
            )
          ) : (
            'Invitation'
          )}
        </p>
      </div>

      <div className="card p-6">
        {result.ok ? (
          <InviteForm
            token={token as string}
            email={result.preview.email}
            invitedName={result.preview.invitedName}
            hasAccount={result.preview.hasAccount}
          />
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-danger">{result.reason}</p>
            <p className="text-muted">
              Whoever invited you can send another one. Nothing was granted and nothing was lost.
            </p>
            <Link href="/login" className="btn btn-ghost w-full">
              Back to sign in
            </Link>
          </div>
        )}
      </div>

      {result.ok && (
        <p className="mt-6 text-center text-xs text-faint">
          Accepting creates your own account. Nobody shares a login here — spec §14, and the reason
          your name is the one in the audit log.
        </p>
      )}
    </main>
  )
}
