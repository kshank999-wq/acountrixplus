'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  assignTaskAction,
  cancelTaskAction,
  completeTaskAction,
  createTaskAction,
  reopenTaskAction,
  type ActionResult,
} from '@/app/actions/engagement'

type Task = {
  id: string
  title: string
  detail: string | null
  dueOn: string | null
  priority: 'low' | 'normal' | 'high'
  assignedTo: string | null
  assigneeName: string | null
  organizationName: string | null
  status: 'open' | 'done' | 'cancelled'
  outcome: string | null
}

type Named = { id: string; name: string }

const PRIORITY_STYLES: Record<string, string> = {
  high: 'text-danger',
  normal: 'text-muted',
  low: 'text-faint',
}

/**
 * Follow-ups.
 *
 * Overdue work is separated from the rest rather than merely sorted to the top,
 * because "three of these are late" is a different fact from "these are your
 * next three", and a single list ordered by date says the second while people
 * read it as the first.
 */
export function WorkBoard({
  today,
  mine,
  everything,
  closed,
  summary,
  people,
  organizations,
  selfUserId,
  canManage,
}: {
  today: string
  mine: Task[]
  everything: Task[]
  closed: Task[]
  summary: {
    open: number
    overdue: number
    dueToday: number
    unassigned: number
    closed: number
  }
  people: Named[]
  organizations: Named[]
  selfUserId: string
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [showAll, setShowAll] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showClosed, setShowClosed] = useState(false)

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

  const shown = showAll ? everything : mine
  const overdue = shown.filter((task) => task.dueOn && task.dueOn < today)
  const rest = shown.filter((task) => !task.dueOn || task.dueOn >= today)

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Follow-ups</h2>
        <p className="text-sm text-muted">
          {summary.open} open across the company
          {summary.overdue > 0 && <span className="text-danger">, {summary.overdue} late</span>}
          {summary.dueToday > 0 && <>, {summary.dueToday} due today</>}
          {summary.unassigned > 0 && (
            <>
              , {summary.unassigned} with nobody&rsquo;s name on{' '}
              <span className="text-faint">— which means everybody&rsquo;s.</span>
            </>
          )}
          .
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            className={`chip px-3 py-1 text-xs ${
              showAll ? 'bg-raised text-muted' : 'bg-brand text-brand-ink'
            }`}
            onClick={() => setShowAll(false)}
          >
            Mine and unclaimed
          </button>
          <button
            className={`chip px-3 py-1 text-xs ${
              showAll ? 'bg-brand text-brand-ink' : 'bg-raised text-muted'
            }`}
            onClick={() => setShowAll(true)}
          >
            Everybody&rsquo;s
          </button>
          {canManage && (
            <button className="btn btn-ghost text-xs" onClick={() => setShowNew((was) => !was)}>
              {showNew ? 'Never mind' : 'Raise one'}
            </button>
          )}
          <button
            className="btn btn-ghost text-xs"
            onClick={() => setShowClosed((was) => !was)}
          >
            {showClosed ? 'Hide what was closed' : `Closed this week (${summary.closed})`}
          </button>
        </div>
      </header>

      {notice && (
        <div
          className={`card px-4 py-3 text-sm ${notice.ok ? 'text-success' : 'text-danger'}`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {showNew && canManage && (
        <NewTask
          organizations={organizations}
          people={people}
          selfUserId={selfUserId}
          act={act}
          pending={pending}
          onDone={() => setShowNew(false)}
        />
      )}

      {overdue.length > 0 && (
        <List
          title="Late"
          subtitle="Past their date. The list this page exists for."
          tasks={overdue}
          today={today}
          people={people}
          act={act}
          pending={pending}
          canManage={canManage}
        />
      )}

      <List
        title={overdue.length > 0 ? 'Everything else' : 'Open'}
        subtitle={
          showAll
            ? 'Every open follow-up in the company.'
            : 'Yours, and the ones nobody has claimed.'
        }
        tasks={rest}
        today={today}
        people={people}
        act={act}
        pending={pending}
        canManage={canManage}
      />

      {showClosed && (
        <ClosedList tasks={closed} act={act} pending={pending} canManage={canManage} />
      )}
    </div>
  )
}

/**
 * What was closed lately, and the way back.
 *
 * A Done button with no list of what it has done makes one mis-click permanent.
 * Cancelled work sits here beside completed work because both are finished, and
 * a dropped task keeps its reason — a follow-up that simply vanishes teaches
 * nobody anything.
 */
function ClosedList({
  tasks,
  act,
  pending,
  canManage,
}: {
  tasks: Task[]
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
  canManage: boolean
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">Closed this week</h3>
        <p className="text-xs text-muted">Done and dropped together. Both are finished.</p>
      </header>

      {tasks.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing closed this week.</p>
      ) : (
        <ul className="divide-y divide-line">
          {tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted line-through">{task.title}</p>
                <p className="text-xs text-faint">
                  <span className={task.status === 'cancelled' ? 'text-warning' : 'text-success'}>
                    {task.status === 'cancelled' ? 'dropped' : 'done'}
                  </span>
                  {task.organizationName && <> · {task.organizationName}</>}
                  {task.assigneeName && <> · {task.assigneeName}</>}
                </p>
                {task.outcome && <p className="mt-1 text-xs text-muted">{task.outcome}</p>}
              </div>

              {canManage && (
                <button
                  className="btn btn-ghost text-xs"
                  disabled={pending}
                  onClick={() => act(() => reopenTaskAction(task.id))}
                  title="Put it back on the list. The completion time goes with it."
                >
                  Reopen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function List({
  title,
  subtitle,
  tasks,
  today,
  people,
  act,
  pending,
  canManage,
}: {
  title: string
  subtitle: string
  tasks: Task[]
  today: string
  people: Named[]
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
  canManage: boolean
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted">{subtitle}</p>
      </header>

      {tasks.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-line">
          {tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {task.priority === 'high' && (
                    <span className="text-danger" title="High priority">
                      !{' '}
                    </span>
                  )}
                  {task.title}
                </p>
                <p className="text-xs text-muted">
                  {task.dueOn ? (
                    <span className={task.dueOn < today ? 'text-danger' : ''}>
                      due {task.dueOn}
                    </span>
                  ) : (
                    <span className="text-faint">no date</span>
                  )}
                  {task.organizationName && <> · {task.organizationName}</>}
                  {' · '}
                  {task.assigneeName ?? <span className="text-warning">unclaimed</span>}
                  <span className={`ml-2 ${PRIORITY_STYLES[task.priority]}`}>{task.priority}</span>
                </p>
                {task.detail && <p className="mt-1 text-xs text-faint">{task.detail}</p>}
              </div>

              {canManage && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    className="field py-1 text-xs"
                    value={task.assignedTo ?? ''}
                    disabled={pending}
                    onChange={(event) =>
                      act(() => assignTaskAction(task.id, event.target.value || null))
                    }
                  >
                    <option value="">Unclaimed</option>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-primary text-xs"
                    disabled={pending}
                    onClick={() => act(() => completeTaskAction(task.id))}
                  >
                    Done
                  </button>
                  <button
                    className="btn btn-ghost text-xs"
                    disabled={pending}
                    onClick={() => act(() => cancelTaskAction(task.id))}
                    title="Drop it. Kept, with the reason, rather than deleted."
                  >
                    Drop
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function NewTask({
  organizations,
  people,
  selfUserId,
  act,
  pending,
  onDone,
}: {
  organizations: Named[]
  people: Named[]
  selfUserId: string
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
  onDone: () => void
}) {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [priority, setPriority] = useState('normal')
  const [assignedTo, setAssignedTo] = useState(selfUserId)
  const [organizationId, setOrganizationId] = useState('')

  return (
    <section className="card space-y-3 p-4">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Call them back about the revised scope"
        className="field"
      />
      <textarea
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        rows={2}
        placeholder="Anything the person doing it needs to know…"
        className="field text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <label className="text-xs text-muted">
          <span className="mb-1 block">Due</span>
          <input
            type="date"
            value={dueOn}
            onChange={(event) => setDueOn(event.target.value)}
            className="field py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-muted">
          <span className="mb-1 block">Priority</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="field py-1.5 text-sm"
          >
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
          </select>
        </label>
        <label className="text-xs text-muted">
          <span className="mb-1 block">Who</span>
          <select
            value={assignedTo}
            onChange={(event) => setAssignedTo(event.target.value)}
            className="field py-1.5 text-sm"
          >
            <option value="">Nobody yet</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          <span className="mb-1 block">Client</span>
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="field py-1.5 text-sm"
          >
            <option value="">Not about one</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        className="btn btn-primary"
        disabled={pending || title.trim().length === 0}
        onClick={() => {
          act(() =>
            createTaskAction({
              title,
              detail: detail || undefined,
              dueOn: dueOn || undefined,
              priority,
              assignedTo: assignedTo || null,
              organizationId: organizationId || null,
            }),
          )
          setTitle('')
          setDetail('')
          setDueOn('')
          onDone()
        }}
      >
        Raise it
      </button>
      <p className="text-xs text-faint">
        A follow-up with nobody&rsquo;s name on it stays on the shared list rather than
        disappearing — &ldquo;somebody should call them back&rdquo; is a real state.
      </p>
    </section>
  )
}
