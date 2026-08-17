'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Staffing } from './staffing'
import {
  endEngagementAction,
  enterClientAction,
  removePracticeMemberAction,
  inviteStaffAction,
  respondToEngagementAction,
  type ActionResult,
} from '@/app/actions/practice'

type Practice = {
  practiceId: string
  practiceName: string
  practiceRole: 'owner' | 'staff'
}

type QueueItem = {
  companyId: string
  companyName: string
  role: string
  awaitingReview: number
  oldestAwaiting: string | null
}

type Engagement = {
  id: string
  companyName: string
  status: 'pending' | 'active' | 'declined' | 'ended'
  initiatedBy: 'practice' | 'client'
  grantedRole: string
  staffing: 'whole_firm' | 'assigned_only'
  note: string | null
  requestedAt: string
}

type Member = {
  userId: string
  name: string
  email: string
  practiceRole: 'owner' | 'staff'
  isActive: boolean
}

/**
 * The firm's own workspace: who they act for, what is waiting, and who works
 * there.
 *
 * Leads with the work queue rather than the client list, because "which of my
 * forty clients needs me today" is the only question this page is for.
 */
export function PracticeBoard({
  practice,
  practices,
  queue,
  engagements,
  members,
  isOwner,
  selfUserId,
}: {
  practice: Practice
  practices: Practice[]
  queue: QueueItem[]
  engagements: Engagement[]
  members: Member[]
  isOwner: boolean
  selfUserId: string
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showStaff, setShowStaff] = useState(false)

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

  // Only the ones this side may answer. An engagement the practice asked for
  // is the client's to accept, and showing it here with a button would be
  // offering something the server will refuse.
  const awaitingUs = engagements.filter(
    (engagement) => engagement.status === 'pending' && engagement.initiatedBy === 'client',
  )
  const live = engagements.filter((engagement) => engagement.status === 'active')

  const awaitingThem = engagements.filter(
    (engagement) => engagement.status === 'pending' && engagement.initiatedBy === 'practice',
  )
  const past = engagements.filter(
    (engagement) => engagement.status === 'declined' || engagement.status === 'ended',
  )

  const backlog = queue.reduce((sum, item) => sum + item.awaitingReview, 0)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">{practice.practiceName}</h2>
        <p className="text-sm text-muted">
          {queue.length} {queue.length === 1 ? 'client' : 'clients'}, {backlog} transactions waiting
          across all of them.{' '}
          <span className="text-faint">
            Every one of them decided separately to let you in, and can end it without asking you.
          </span>
        </p>
        {practices.length > 1 && (
          <div className="mt-2 flex gap-1">
            {practices.map((entry) => (
              <a
                key={entry.practiceId}
                href={`/practice?p=${entry.practiceId}`}
                className={`chip px-3 py-1 text-xs ${
                  entry.practiceId === practice.practiceId
                    ? 'bg-brand text-brand-ink'
                    : 'bg-raised text-muted'
                }`}
              >
                {entry.practiceName}
              </a>
            ))}
          </div>
        )}
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
          subtitle="These companies have offered you access. Nothing is granted until you accept."
        >
          <ul className="divide-y divide-line">
            {awaitingUs.map((engagement) => (
              <li key={engagement.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{engagement.companyName}</p>
                  <p className="text-xs text-muted">
                    as {engagement.grantedRole} · offered {engagement.requestedAt}
                    {engagement.note && ` · “${engagement.note}”`}
                  </p>
                </div>
                <button
                  className="btn btn-primary text-xs"
                  disabled={pending}
                  onClick={() =>
                    act(() => respondToEngagementAction(engagement.id, true, 'practice'))
                  }
                >
                  Accept
                </button>
                <button
                  className="btn btn-ghost text-xs"
                  disabled={pending}
                  onClick={() =>
                    act(() => respondToEngagementAction(engagement.id, false, 'practice'))
                  }
                >
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Clients"
        subtitle="What is waiting in each set of books. Counts only — you are not in anybody’s ledger until you open it."
      >
        {queue.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            No clients yet. A company grants you access from their own settings, or you can ask —
            either way they decide.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Your role</th>
                <th className="px-4 py-2 text-right font-medium">Waiting</th>
                <th className="px-4 py-2 font-medium">Oldest</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr key={item.companyId} className="border-t border-line">
                  <td className="px-4 py-1.5 font-medium">{item.companyName}</td>
                  <td className="px-4 py-1.5 text-muted">{item.role}</td>
                  <td
                    className={`tnum px-4 py-1.5 text-right ${
                      item.awaitingReview > 0 ? 'font-medium' : 'text-muted'
                    }`}
                  >
                    {item.awaitingReview === 0 ? '—' : item.awaitingReview}
                  </td>
                  <td className="px-4 py-1.5 text-muted">{item.oldestAwaiting ?? '—'}</td>
                  <td className="px-4 py-1.5 text-right">
                    <form action={enterClientAction.bind(null, item.companyId)}>
                      <button className="btn btn-ghost text-xs">Open their books</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {live.length > 0 && isOwner && (
        <Card
          title="Who is on which client"
          subtitle="A firm does not put everybody on everything. Each client is staffed by the whole firm or by named people, and the client's cap still applies either way."
        >
          <ul className="divide-y divide-line">
            {live.map((engagement) => (
              <li key={engagement.id} className="px-4 py-3">
                <p className="text-sm font-medium">{engagement.companyName}</p>
                <p className="text-xs text-faint">capped at {engagement.grantedRole}</p>
                <Staffing engagementId={engagement.id} staffing={engagement.staffing} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {awaitingThem.length > 0 && (
        <Card title="Waiting on them" subtitle="You have asked; they have not answered.">
          <ul className="divide-y divide-line">
            {awaitingThem.map((engagement) => (
              <li key={engagement.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="flex-1">{engagement.companyName}</span>
                <span className="text-xs text-muted">asked {engagement.requestedAt}</span>
                {isOwner && (
                  <button
                    className="btn btn-ghost text-xs"
                    disabled={pending}
                    onClick={() => act(() => endEngagementAction(engagement.id, 'practice'))}
                  >
                    Withdraw
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Who works here"
        subtitle="Somebody here reaches every client staffed by the whole firm, and only the clients they are put on for the rest — capped either way at what each client agreed to."
      >
        <table className="w-full text-sm">
          <tbody>
            {members
              .filter((member) => member.isActive)
              .map((member) => (
                <tr key={member.userId} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-1.5">
                    {member.name}
                    <span className="block text-xs text-faint">{member.email}</span>
                  </td>
                  <td className="px-4 py-1.5 text-muted">{member.practiceRole}</td>
                  <td className="px-4 py-1.5 text-right">
                    {isOwner && member.userId !== selfUserId && (
                      <button
                        className="btn btn-ghost text-xs text-danger"
                        disabled={pending}
                        onClick={() =>
                          act(() =>
                            removePracticeMemberAction({
                              practiceId: practice.practiceId,
                              userId: member.userId,
                            }),
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>

        {isOwner && (
          <div className="border-t border-line px-4 py-3">
            <button className="btn btn-ghost text-xs" onClick={() => setShowStaff((was) => !was)}>
              {showStaff ? 'Never mind' : 'Add somebody'}
            </button>
            {showStaff && <StaffForm practiceId={practice.practiceId} act={act} pending={pending} />}
          </div>
        )}
      </Card>

      {past.length > 0 && (
        <Card title="Past" subtitle="Kept, because who had the books and when is a question people ask.">
          <table className="w-full text-sm">
            <tbody>
              {past.map((engagement) => (
                <tr key={engagement.id} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-1.5">{engagement.companyName}</td>
                  <td className="px-4 py-1.5 text-muted">{engagement.status}</td>
                  <td className="px-4 py-1.5 text-right text-xs text-faint">
                    {engagement.requestedAt}
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

function StaffForm({
  practiceId,
  act,
  pending,
}: {
  practiceId: string
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="Optional — they can correct it.">
          <input value={name} onChange={(e) => setName(e.target.value)} className="field" />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} className="field" />
        </Field>
      </div>
      <button
        className="btn btn-primary"
        disabled={pending || !email.includes('@')}
        onClick={() => act(() => inviteStaffAction({ practiceId, name, email }))}
      >
        Send an invitation
      </button>
      <p className="text-xs text-faint">
        They get a link and choose their own password — you never see it and never set it. Nothing
        is granted until they accept.
      </p>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-faint">{hint}</span>}
    </label>
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
