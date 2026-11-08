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
import { inviteToCompanyAction, withdrawInvitationAction } from '@/app/actions/notify'
import { updateMembershipAction } from '@/app/actions/access'

type Holder = {
  userId: string
  name: string
  email: string
  role: string
  viaPracticeName: string | null
  viaStaffing: 'whole_firm' | 'assigned_only' | null
  isSelf: boolean
  /**
   * Phase 202. `resolveSession` filters every request on this, with a comment
   * saying *"a lock that waits for a session to expire is not a lock"* — and
   * until this phase nothing could set it false, so §14's *revocation* was a
   * mechanism with no handle. `page.tsx` had also been dropping the field on
   * the way here since Phase 25.
   */
  isActive: boolean
  /** Granted on top of the role, and taken away from it (spec §14). */
  grant: string[]
  revoke: string[]
}

/** What one permission is, for this person, relative to their role. */
type Standing = 'default' | 'grant' | 'revoke'

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

type Invitation = {
  id: string
  email: string
  invitedName: string | null
  role: string
  expiresAt: string
}

const ROLES = ['readonly', 'bookkeeper', 'accountant', 'manager'] as const

/** What a person can be invited as. Wider than the ceiling offered to a firm. */
const MEMBER_ROLES = [
  'readonly',
  'sales',
  'marketing',
  'bookkeeper',
  'accountant',
  'manager',
  'owner',
] as const

/**
 * The client's side of practice mode.
 *
 * Two things it must make obvious: who can currently open the books, and how
 * to stop them. Everything else on this page is secondary to those.
 */
export function AccessBoard({
  holders,
  engagements,
  invitations,
  canManage,
  canManageUsers,
  permissions,
  roleDefaults,
}: {
  holders: Holder[]
  engagements: Engagement[]
  invitations: Invitation[]
  canManage: boolean
  /** `users:manage` — a person's standing, as opposed to the company's own
   *  arrangements. Only `owner` holds either today; the split is the seam. */
  canManageUsers: boolean
  permissions: string[]
  roleDefaults: Record<string, string[]>
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

  /*
    Whose permissions are open, and the three-way standing of each one while
    it is being edited. Held here rather than derived, because it is a
    selection somebody is part way through making — and `default` is a real
    answer rather than the absence of one, which is why this is a map of three
    values and not two sets.
  */
  const [editing, setEditing] = useState<string | null>(null)
  const [standings, setStandings] = useState<Record<string, Standing>>({})

  const edited = holders.find((holder) => holder.userId === editing) ?? null

  /** A membership this side may change. The service refuses the rest. */
  function editable(holder: Holder): boolean {
    return canManageUsers && !holder.isSelf && !holder.viaPracticeName
  }

  function openPermissions(holder: Holder) {
    if (editing === holder.userId) {
      setEditing(null)
      return
    }
    const next: Record<string, Standing> = {}
    for (const permission of holder.grant) next[permission] = 'grant'
    for (const permission of holder.revoke) next[permission] = 'revoke'
    setStandings(next)
    setEditing(holder.userId)
  }

  function saveOverrides() {
    if (!edited) return
    act(() =>
      updateMembershipAction({
        userId: edited.userId,
        grant: Object.entries(standings)
          .filter(([, standing]) => standing === 'grant')
          .map(([permission]) => permission),
        revoke: Object.entries(standings)
          .filter(([, standing]) => standing === 'revoke')
          .map(([permission]) => permission),
      }),
    )
    setEditing(null)
  }

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
              <th className="px-4 py-2" />
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
                <td className="px-4 py-1.5 text-muted">
                  {/*
                    A select rather than text since Phase 202. `memberships`
                    was insert-only, so the role somebody was invited as was
                    the role they had for ever: a bookkeeper who became the
                    accountant could not be made one, and this cell printed the
                    answer with no way to change it.
                  */}
                  {editable(holder) ? (
                    <select
                      value={holder.role}
                      disabled={pending}
                      onChange={(event) =>
                        act(() =>
                          updateMembershipAction({
                            userId: holder.userId,
                            role: event.target.value,
                          }),
                        )
                      }
                      className="field py-1 text-sm"
                    >
                      {MEMBER_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    holder.role
                  )}
                  {(holder.grant.length > 0 || holder.revoke.length > 0) && (
                    <span className="ml-2 chip bg-action/10 px-2 py-0.5 text-xs text-action">
                      {holder.grant.length > 0 && `+${holder.grant.length}`}
                      {holder.grant.length > 0 && holder.revoke.length > 0 && ' '}
                      {holder.revoke.length > 0 && `−${holder.revoke.length}`}
                    </span>
                  )}
                </td>
                <td className="px-4 py-1.5">
                  {holder.viaPracticeName ? (
                    <>
                      <span className="text-warning">via {holder.viaPracticeName}</span>
                      {/* "Everybody at Hartley & Co can read your ledger" and
                          "these two people can" are different facts, and a
                          list of names cannot tell them apart. */}
                      <span className="block text-xs text-faint">
                        {holder.viaStaffing === 'assigned_only'
                          ? 'assigned to you specifically'
                          : 'everybody at the firm'}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">works here</span>
                  )}
                  {!holder.isActive && (
                    <span className="block text-xs text-negative">access revoked</span>
                  )}
                </td>
                <td className="px-4 py-1.5 text-right">
                  {editable(holder) && (
                    <span className="inline-flex gap-1">
                      <button
                        className="btn btn-ghost text-xs"
                        onClick={() => openPermissions(holder)}
                      >
                        Permissions
                      </button>
                      <button
                        className="btn btn-ghost text-xs"
                        disabled={pending}
                        onClick={() =>
                          act(() =>
                            updateMembershipAction({
                              userId: holder.userId,
                              isActive: !holder.isActive,
                            }),
                          )
                        }
                      >
                        {holder.isActive ? 'Revoke' : 'Restore'}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/*
          The granular overrides §14 asks for (Phase 202).

          `permissionOverrides` was read into the actor, parsed, and *applied*
          by `effectivePermissions` — a grant adds a permission and a revoke
          deletes one — with nothing anywhere able to write one. This is the
          editor, and `default` is offered as a real third answer rather than
          as the absence of a choice: a permission left alone follows the role
          as the role changes, and one pinned to the role's current answer
          would quietly stop doing so.
        */}
        {edited && (
          <div className="border-t border-line px-4 py-3">
            <p className="text-sm font-medium">
              {edited.name} — on top of the {edited.role} role
            </p>
            <p className="mt-0.5 text-xs text-faint">
              Granting more than the role is the point rather than a mistake: it is how one
              colleague gets to enter supplier bills without also gaining the power to clear
              them. A revocation wins over a grant.
            </p>

            <div className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {permissions.map((permission) => {
                const fromRole = (roleDefaults[edited.role] ?? []).includes(permission)
                const standing = standings[permission] ?? 'default'

                return (
                  <div
                    key={permission}
                    className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-xs"
                  >
                    <span className={fromRole ? '' : 'text-faint'}>
                      {permission}
                      {fromRole && <span className="text-positive"> ·</span>}
                    </span>
                    <span className="inline-flex shrink-0 gap-0.5">
                      {(['default', 'grant', 'revoke'] as const).map((choice) => (
                        <button
                          key={choice}
                          onClick={() =>
                            setStandings((current) => {
                              const next = { ...current }
                              if (choice === 'default') delete next[permission]
                              else next[permission] = choice
                              return next
                            })
                          }
                          className={`rounded px-1.5 py-0.5 ${
                            standing === choice
                              ? 'bg-action text-white'
                              : 'bg-raised text-muted hover:text-ink'
                          }`}
                        >
                          {choice === 'default' ? '–' : choice === 'grant' ? '+' : '×'}
                        </button>
                      ))}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button className="btn btn-primary text-xs" disabled={pending} onClick={saveOverrides}>
                Save permissions
              </button>
              <button className="btn btn-ghost text-xs" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <span className="text-xs text-faint">
                A dot marks what the role already gives.
              </span>
            </div>
          </div>
        )}
        {viaPractice.length > 0 && (
          <p className="border-t border-line px-4 py-2 text-xs text-faint">
            {viaPractice.length} of these {viaPractice.length === 1 ? 'person is' : 'people are'} from
            an outside firm. End the engagement below to remove them all at once.
          </p>
        )}
      </Card>

      {canManage && (
        <InviteCard invitations={invitations} act={act} pending={pending} />
      )}

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

/**
 * Invite a colleague onto these books.
 *
 * Replaces the form that asked an owner to type somebody else's first password.
 * There is no password field here at all — that is the point of the phase, not
 * an omission, so the note under the button says so rather than leaving people
 * hunting for the field they remember.
 */
function InviteCard({
  invitations,
  act,
  pending,
}: {
  invitations: Invitation[]
  act: (fn: () => Promise<ActionResult>) => void
  pending: boolean
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>('bookkeeper')

  return (
    <Card
      title="Invite somebody to these books"
      subtitle="They get a link, choose their own password, and appear above once they accept."
    >
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Email</span>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="dana@example.com"
              className="field py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Name (optional)</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Dana Chen"
              className="field py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className="field py-1.5 text-sm"
            >
              {MEMBER_ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            disabled={pending || !email.includes('@')}
            onClick={() => {
              act(() => inviteToCompanyAction({ email, name, role }))
              setEmail('')
              setName('')
            }}
          >
            Send an invitation
          </button>
        </div>

        <p className="text-xs text-faint">
          You never see or set their password. Nothing is granted until they accept, so a mistyped
          address hands a stranger nothing.
        </p>

        {invitations.length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="mb-1 text-xs uppercase tracking-wide text-muted">Waiting to be accepted</p>
            <ul className="divide-y divide-line">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    {invitation.invitedName ? `${invitation.invitedName} · ` : ''}
                    {invitation.email}
                    <span className="block text-xs text-faint">
                      as {invitation.role} · link expires {invitation.expiresAt}
                    </span>
                  </span>
                  <button
                    className="btn btn-ghost text-xs text-danger"
                    disabled={pending}
                    onClick={() => act(() => withdrawInvitationAction(invitation.id))}
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
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
