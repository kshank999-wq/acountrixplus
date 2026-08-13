import { unsubscribeContext } from '@/modules/marketing/engagement'
import { UnsubscribePanel } from './unsubscribe-panel'

export const dynamic = 'force-dynamic'

/**
 * The public unsubscribe page (spec §10, §19).
 *
 * Unauthenticated, reached from a link in an email. It shows a confirm button
 * rather than unsubscribing on load: mail clients and security scanners
 * pre-fetch links, and a GET that changed state would opt people out who never
 * clicked anything. The change itself is a POST.
 *
 * An unknown or expired token still renders the same page — telling a visitor
 * "that token does not exist" would confirm which tokens do.
 */
export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const context = await unsubscribeContext(token)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="card p-6">
        <UnsubscribePanel
          token={token}
          email={context?.email ?? null}
          firstName={context?.firstName ?? null}
        />
      </div>

      <p className="mt-6 text-center text-xs text-muted">
        Unsubscribing stops marketing email. Messages about work already under
        way — invoices, proposals, and replies — still reach you.
      </p>
    </main>
  )
}
