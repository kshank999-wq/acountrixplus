'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  assignToEngagementAction,
  setEngagementStaffingAction,
  staffingForAction,
  unassignFromEngagementAction,
  type ActionResult,
  type StaffingView,
} from '@/app/actions/practice'

const ROLES = [
  'owner',
  'manager',
  'accountant',
  'bookkeeper',
  'sales',
  'marketing',
  'readonly',
] as const

/**
 * Who at the firm is on one client's books.
 *
 * Loaded when somebody opens a client rather than with the list, the same
 * reasoning as Phase 22's client timeline: a firm with forty clients would
 * otherwise run forty staffing queries to render forty collapsed rows.
 */
export function Staffing({
  engagementId,
  staffing,
}: {
  engagementId: string
  staffing: 'whole_firm' | 'assigned_only'
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<StaffingView | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function load() {
    startTransition(async () => {
      setView(await staffingForAction(engagementId))
    })
  }

  function act(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const result = await fn()
      setNotice(
        result.ok
          ? { ok: true, text: result.message ?? 'Done.' }
          : { ok: false, text: result.error },
      )
      if (result.ok) {
        setView(await staffingForAction(engagementId))
        router.refresh()
      }
    })
  }

  const assignedOnly = (view?.staffing ?? staffing) === 'assigned_only'

  return (
    <div className="mt-2">
      <button
        className="text-xs text-action hover:underline"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next && view === null) load()
        }}
      >
        {open ? 'Hide who is on it' : 'Who is on it'}
      </button>
      <span className={`ml-2 text-xs ${assignedOnly ? 'text-success' : 'text-faint'}`}>
        {assignedOnly ? 'assigned people only' : 'the whole firm'}
      </span>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-raised/40 p-3">
          {notice && (
            <p className={`text-xs ${notice.ok ? 'text-success' : 'text-danger'}`} role="status">
              {notice.text}
            </p>
          )}

          {view === null ? (
            <p className="text-xs text-muted">
              {pending ? 'Loading…' : 'Only a practice owner can see or change this.'}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted">
                {view.staffing === 'whole_firm'
                  ? `Everybody at the firm can open ${view.companyName}'s books, as ${view.grantedRole} or narrower.`
                  : `Only the people named below can open ${view.companyName}'s books.`}
              </p>

              <ul className="divide-y divide-line">
                {view.staff.map((member) => (
                  <li key={member.userId} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="text-sm">{member.name}</span>
                      <span className="block text-xs text-faint">
                        {member.email} · firm {member.practiceRole}
                        {member.note && ` · ${member.note}`}
                      </span>
                    </span>

                    <span className="text-xs">
                      {member.effectiveRole ? (
                        <span className="text-success">{member.effectiveRole}</span>
                      ) : (
                        <span className="text-faint">no access</span>
                      )}
                    </span>

                    <select
                      className="field w-32 py-1 text-xs"
                      value={member.assignedRole ?? ''}
                      disabled={pending}
                      onChange={(event) =>
                        act(() =>
                          assignToEngagementAction({
                            engagementId,
                            userId: member.userId,
                            role: event.target.value || null,
                          }),
                        )
                      }
                    >
                      <option value="">Their usual role</option>
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          as {role}
                        </option>
                      ))}
                    </select>

                    {member.isAssigned ? (
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() =>
                            unassignFromEngagementAction({
                              engagementId,
                              userId: member.userId,
                            }),
                          )
                        }
                      >
                        Take off
                      </button>
                    ) : (
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() =>
                            assignToEngagementAction({
                              engagementId,
                              userId: member.userId,
                            }),
                          )
                        }
                      >
                        Put on
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              <div className="border-t border-line pt-3">
                <button
                  className="btn text-xs"
                  disabled={pending}
                  onClick={() =>
                    act(() =>
                      setEngagementStaffingAction({
                        engagementId,
                        staffing: view.staffing === 'whole_firm' ? 'assigned_only' : 'whole_firm',
                      }),
                    )
                  }
                >
                  {view.staffing === 'whole_firm'
                    ? 'Restrict to the assigned'
                    : 'Open to the whole firm'}
                </button>

                {/* The number before the button, not after it. A permissions
                    change nobody could see coming is one somebody reverses in
                    a panic. */}
                <span className="ml-2 text-xs text-muted">
                  {view.staffing === 'whole_firm'
                    ? view.wouldRevoke > 0
                      ? `${view.wouldRevoke} ${view.wouldRevoke === 1 ? 'person' : 'people'} would lose access.`
                      : 'Nobody would lose access.'
                    : view.wouldGrant > 0
                      ? `${view.wouldGrant} more ${view.wouldGrant === 1 ? 'person' : 'people'} would gain access.`
                      : 'Nobody else would gain access.'}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
