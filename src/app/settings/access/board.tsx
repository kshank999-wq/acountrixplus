'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  endEngagementAction,
  offerEngagementAction,
  respondToEngagementAction,
  type ActionResult,
} from '@/app/actions/practice'
import { findPracticesAction } from '@/app/actions/practice-search'

type Holder = {
  userId: string
  name: string
  email: string
  role: string
  viaPracticeName: string | null
  isSelf: boolean
}

type Engagement = {
  id: string
  practiceId: string
  practiceName: string
  status: 'pending' | 'active' | 'declined' | 'ended'
  initiatedBy: 'practice' | 'client'
  grantedRole: string
  note: string | null
  requestedAt: string
  endedAt: string | null
}

const ROLES = ['readonly', 'bookkeeper', 'accountant', 'manager'] as const

/**
 * The client's side of practice mode.
 *
 * Two things it must make obvious: who can currently open the books, and how
 * to stop them. Everything else on this page is secondary to those.
 */
export function AccessBoard({
  holders,
  engagements,
  canManage,
}: {
  holders: Holder[]
  engagements: Engagement[]
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Array<{ id: string; name: string; contactEmail: string | null }>>([])
  const [grantedRole, setGrantedRole] = useState<string>('accountant')
  const [searched, setSearched] = useState(false)

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) router.refresh()
    })
  }

  // Only what this side may answer. A request the company made is the
  // practice's to accept, so showing a button here would offer something the
  // server will refuse.
  const awaitingUs = engagements.filter(
    (engagement) => engagement.status === 'pending' && engagement.initiatedBy === 'practice',
  )
  const awaitingThem = engagements.filter(
    (engagement) => engagement.status === 'pending' && engagement.initiatedBy === 'client',
  )
  const active = engagements.filter((engagement) => engagement.status === 'active')
  const past = engagements.filter(
    (engagement) => engagement.status === 'ended' || engagement.status === 'declined',
  )

  const viaPractice = holders.filter((holder) => holder.viaPracticeName)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Who has access</h2>
        <p className="text-sm text-muted">
          Everybody who can open these books, and how they got in.{' '}
          <span className="text-faint">
            Ending a firm’s access takes effect on their next click, not when their session expires.
          </span>
        </p>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {awaitingUs.length > 0 && (
        <Card
          title="Waiting on you"
          subtitle="A practice has asked for access. They have none until you say yes."
        >
          <ul className="divide-y divide-line">
            {awaitingUs.map((engagement) => (
              <li key={engagement.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{engagement.practiceName}</p>
                  <p className="text-xs text-muted">
                    asking for {engagement.grantedRole} · {engagement.requestedAt}
                    {engagement.note && ` · “${engagement.note}”`}
                  </p>
                </div>
                {canManage && (
                  <>
                    <button
                      className="btn btn-primary text-xs"
                      disabled={pending}
                      onClick={() =>
                        act(() => respondToEngagementAction(engagement.id, true, 'client'))
                      }
                    >
                      Let them in
                    </button>
                    <button
                      className="btn btn-ghost text-xs"
                      disabled={pending}
                      onClick={() =>
                        act(() => respondToEngagementAction(engagement.id, false, 'client'))
                      }
                    >
                      No
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="People" subtitle="Your own staff, and anybody from a practice you let in.">
        <table className="w-full text-sm">
          <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">How</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((holder) => (
              <tr key={holder.userId} className="border-t border-line">
                <td className="px-4 py-1.5">
                  {holder.name}
                  {holder.isSelf && <span className="text-faint"> · you</span>}
                  <span className="block text-xs text-faint">{holder.email}</span>
                </td>
                <td className="px-4 py-1.5 text-muted">{holder.role}</td>
                <td className="px-4 py-1.5">
                  {holder.viaPracticeName ? (
                    <span className="text-warning">via {holder.viaPracticeName}</span>
                  ) : (
                    <span className="text-muted">works here</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {viaPractice.length > 0 && (
          <p className="border-t border-line px-4 py-2 text-xs text-faint">
            {viaPractice.length} of these {viaPractice.length === 1 ? 'person is' : 'people are'} from
            an outside firm. End the engagement below to remove them all at once.
          </p>
        )}
      </Card>

      {active.length > 0 && (
        <Card title="Practices with access" subtitle="You can end any of these without asking them.">
          <ul className="divide-y divide-line">
            {active.map((engagement) => (
              <li key={engagement.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{engagement.practiceName}</p>
                  <p className="text-xs text-muted">
                    as {engagement.grantedRole} · since {engagement.requestedAt} ·{' '}
                    {engagement.initiatedBy === 'client' ? 'you invited them' : 'they asked, you agreed'}
                  </p>
                </div>
                {canManage && (
                  <button
                    className="btn btn-ghost text-xs text-danger"
                    disabled={pending}
                    onClick={() => act(() => endEngagementAction(engagement.id, 'client'))}
                  >
                    End it
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {awaitingThem.length > 0 && (
        <Card title="Waiting on them" subtitle="You have offered; they have not answered.">
          <ul className="divide-y divide-line">
            {awaitingThem.map((engagement) => (
              <li key={engagement.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="flex-1">{engagement.practiceName}</span>
                <span className="text-xs text-muted">offered {engagement.requestedAt}</span>
                {canManage && (
                  <button
                    className="btn btn-ghost text-xs"
                    disabled={pending}
                    onClick={() => act(() => endEngagementAction(engagement.id, 'client'))}
                  >
                    Withdraw
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canManage && (
        <Card
          title="Invite an accountant"
          subtitle="They get nothing until they accept, and you can end it at any time."
        >
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted">
                <span className="mb-1 block">Practice name</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Hartley"
                  className="field py-1.5 text-sm"
                />
              </label>
              <label className="text-xs text-muted">
                <span className="mb-1 block">They may act as</span>
                <select
                  value={grantedRole}
                  onChange={(event) => setGrantedRole(event.target.value)}
                  className="field py-1.5 text-sm"
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-ghost"
                disabled={pending || query.trim().length < 2}
                onClick={() =>
                  startTransition(async () => {
                    const result = await findPracticesAction(query)
                    setFound(result)
                    setSearched(true)
                  })
                }
              >
                Find them
              </button>
            </div>

            {searched && found.length === 0 && (
              <p className="text-sm text-muted">No practice by that name.</p>
            )}

            <ul className="space-y-1">
              {found.map((practice) => (
                <li key={practice.id} className="flex items-center gap-3 text-sm">
                  <span className="flex-1">
                    {practice.name}
                    {practice.contactEmail && (
                      <span className="block text-xs text-faint">{practice.contactEmail}</span>
                    )}
                  </span>
                  <button
                    className="btn btn-primary text-xs"
                    disabled={pending}
                    onClick={() =>
                      act(() =>
                        offerEngagementAction({ practiceId: practice.id, grantedRole }),
                      )
                    }
                  >
                    Offer access
                  </button>
                </li>
              ))}
            </ul>

            <p className="text-xs text-faint">
              A role you pick here is a ceiling. Somebody senior at the firm still arrives as
              whatever you chose, never more.
            </p>
          </div>
        </Card>
      )}

      {past.length > 0 && (
        <Card title="Past" subtitle="Kept, because who had your books and when is worth being able to answer.">
          <table className="w-full text-sm">
            <tbody>
              {past.map((engagement) => (
                <tr key={engagement.id} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-1.5">{engagement.practiceName}</td>
                  <td className="px-4 py-1.5 text-muted">{engagement.status}</td>
                  <td className="px-4 py-1.5 text-right text-xs text-faint">
                    {engagement.endedAt ?? engagement.requestedAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}
