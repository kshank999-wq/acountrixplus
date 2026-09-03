'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  beginMfaEnrollmentAction,
  changePasswordAction,
  confirmMfaEnrollmentAction,
  disableMfaAction,
  exportCompanyDataAction,
  regenerateRecoveryCodesAction,
  revokeDeviceAction,
  revokeOtherDevicesAction,
  updateSecurityPolicyAction,
} from '@/app/actions/security'
import { requestAddressChangeAction } from '@/app/actions/auth'
import { LOGIN_OUTCOME_LABELS } from '@/modules/auth/vocabulary'

type Mfa = { enrolled: boolean; confirmedAt: string | null; recoveryCodesRemaining: number }

type Device = {
  id: string
  label: string
  platform: string
  lastSeenAt: string
  isCurrent: boolean
  activeSessions: number
}

type HistoryRow = {
  id: string
  outcome: string
  ipPrefix: string | null
  userAgent: string | null
  createdAt: string
}

type Policy = {
  requireMfa: boolean
  maxFailedAttempts: number
  lockoutMinutes: number
  sessionTtlDays: number
}

type Failure = { email: string; outcome: string; attempts: number; lastAt: string }
type ExportRow = { id: string; datasets: string; rowCount: number; createdAt: string }

export function SecurityBoard({
  enrolmentRequired,
  mfa,
  devices,
  history,
  policy,
  failures,
  exports,
  canManagePolicy,
  canExport,
  signInEmail,
}: {
  enrolmentRequired: boolean
  mfa: Mfa
  devices: Device[]
  history: HistoryRow[]
  policy: Policy
  failures: Failure[]
  exports: ExportRow[]
  canManagePolicy: boolean
  canExport: boolean
  /** What this person signs in as today (Phase 98). */
  signInEmail: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)

  const [disablePassword, setDisablePassword] = useState('')
  const [showDisable, setShowDisable] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  const [draftPolicy, setDraftPolicy] = useState(policy)

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setMessage({
      text: result.ok ? (result.message ?? 'Done.') : (result.error ?? 'Something went wrong.'),
      ok: result.ok,
    })
    if (result.ok) router.refresh()
  }

  function startEnrolment() {
    startTransition(async () => {
      const result = await beginMfaEnrollmentAction()
      if (!result.ok) return notify(result)
      setEnrolling({ secret: result.secret, uri: result.otpauthUri })
      setMessage(null)
    })
  }

  function confirmEnrolment() {
    startTransition(async () => {
      const result = await confirmMfaEnrollmentAction(code)
      if (!result.ok) return notify(result)

      // Shown once and never again. The dialogue stays until acknowledged,
      // because a person who clicks past this has a working second factor and
      // no way back in when they lose their phone.
      setCodes(result.recoveryCodes)
      setEnrolling(null)
      setCode('')
      router.refresh()
    })
  }

  /**
   * Saves the export by building the file in the browser.
   *
   * The CSVs come back through the action rather than from a URL, because
   * there is no object store yet and a file on the server's disk with a
   * guessable path would be worse than none.
   */
  function runExport() {
    startTransition(async () => {
      const result = await exportCompanyDataAction(undefined)
      if (!result.ok) return notify(result)

      for (const file of result.files) {
        const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.name
        anchor.click()
        URL.revokeObjectURL(url)
      }

      notify({ ok: true, message: `${result.rowCount} rows across ${result.files.length} files.` })
    })
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6">
      <header>
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="mt-1 text-sm text-muted">
          Your sign-in, the places this account is signed in, and what your company requires.
        </p>
      </header>

      {/*
        Changing the address you sign in with (Phase 98). Nothing here writes
        anything: it starts a claim, and the letter to the new address is what
        finishes it.
      */}
      <AddressChange current={signInEmail} />

      {enrolmentRequired && (
        <p className="card border-warning/40 p-3 text-sm text-warning" role="alert">
          Your company requires two-factor authentication. Set it up below to carry on — this is
          the only page available until you do.
        </p>
      )}

      {message && (
        <p
          className={`card p-3 text-sm ${message.ok ? 'text-positive' : 'border-danger/40 text-negative'}`}
          role="status"
        >
          {message.text}
        </p>
      )}

      {/* Recovery codes, shown exactly once. */}
      {codes && (
        <section className="card border-brand/40 p-4">
          <h2 className="text-sm font-semibold">Save your recovery codes</h2>
          <p className="mt-1 text-sm text-muted">
            Each one works once, and they are the only way in if you lose your phone. They cannot
            be shown again — the server keeps only hashes of them.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3">
            {codes.map((entry) => (
              <li key={entry} className="tnum">
                {entry}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <button
              className="btn btn-primary"
              onClick={() => {
                void navigator.clipboard?.writeText(codes.join('\n'))
                setMessage({ text: 'Copied.', ok: true })
              }}
            >
              Copy
            </button>
            <button className="btn btn-ghost" onClick={() => setCodes(null)}>
              I have saved them
            </button>
          </div>
        </section>
      )}

      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Two-factor authentication</h2>
            <p className="mt-0.5 text-sm text-muted">
              {mfa.enrolled
                ? `On since ${new Date(mfa.confirmedAt!).toLocaleDateString()}. ${mfa.recoveryCodesRemaining} recovery code${mfa.recoveryCodesRemaining === 1 ? '' : 's'} left.`
                : 'Off. A stolen password is enough to sign in as you.'}
            </p>
          </div>

          {!mfa.enrolled && !enrolling && (
            <button className="btn btn-primary" onClick={startEnrolment} disabled={pending}>
              Set up
            </button>
          )}

          {mfa.enrolled && (
            <div className="flex gap-2">
              <button
                className="btn btn-ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await regenerateRecoveryCodesAction()
                    if (!result.ok) return notify(result)
                    setCodes(result.recoveryCodes)
                  })
                }
              >
                New recovery codes
              </button>
              <button className="btn btn-ghost" onClick={() => setShowDisable((v) => !v)}>
                Turn off
              </button>
            </div>
          )}
        </div>

        {enrolling && (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <p className="text-sm">
              Add this to your authenticator app, then enter the code it shows.
            </p>
            <div>
              <p className="text-xs text-muted">Secret, for typing by hand</p>
              <p className="mt-0.5 break-all font-mono text-sm">{enrolling.secret}</p>
            </div>
            <div>
              <p className="text-xs text-muted">Or open this link on the phone</p>
              <p className="mt-0.5 break-all font-mono text-xs text-faint">{enrolling.uri}</p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">
                <span className="mb-1 block">Code from the app</span>
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  placeholder="000000"
                  className="field tnum w-32 py-1.5 tracking-widest"
                />
              </label>
              <button className="btn btn-primary" onClick={confirmEnrolment} disabled={pending}>
                Turn on
              </button>
              <button className="btn btn-ghost" onClick={() => setEnrolling(null)}>
                Cancel
              </button>
            </div>
            <p className="text-xs text-faint">
              It is only switched on once a code has worked — so a mistyped secret cannot lock you
              out.
            </p>
          </div>
        )}

        {showDisable && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Your password</span>
              <input
                type="password"
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
                className="field py-1.5 text-sm"
              />
            </label>
            <button
              className="btn btn-ghost text-danger"
              disabled={pending || !disablePassword}
              onClick={() =>
                startTransition(async () => {
                  notify(await disableMfaAction(disablePassword))
                  setDisablePassword('')
                  setShowDisable(false)
                })
              }
            >
              Turn off two-factor
            </button>
            <p className="w-full text-xs text-faint">
              The password is asked for because an unattended browser is exactly what this
              protects against.
            </p>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Password</h2>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Current</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="field py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">New</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="field py-1.5 text-sm"
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={pending || !currentPassword || newPassword.length < 8}
            onClick={() =>
              startTransition(async () => {
                notify(await changePasswordAction({ currentPassword, newPassword }))
                setCurrentPassword('')
                setNewPassword('')
              })
            }
          >
            Change password
          </button>
        </div>
        <p className="mt-2 text-xs text-faint">
          Changing it signs out everywhere else. On its own a new password does nothing to somebody
          already holding a session.
        </p>
      </section>

      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Where you are signed in</h2>
            <p className="text-xs text-muted">Revoking a device signs it out immediately.</p>
          </div>
          <button
            className="btn btn-ghost text-xs"
            disabled={pending}
            onClick={() => startTransition(async () => notify(await revokeOtherDevicesAction()))}
          >
            Sign out everywhere else
          </button>
        </header>

        {devices.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No devices recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {device.label}
                    {device.isCurrent && (
                      <span className="ml-2 chip bg-brand/15 px-2 py-0.5 text-xs text-action">
                        this device
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {device.platform} · last seen {new Date(device.lastSeenAt).toLocaleString()} ·{' '}
                    {device.activeSessions} active session{device.activeSessions === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  className="btn btn-ghost text-xs"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => notify(await revokeDeviceAction(device.id)))
                  }
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Recent sign-in attempts</h2>
          <p className="text-xs text-muted">
            Yours, successful and not. A success you do not recognize is the row that matters.
          </p>
        </header>

        {history.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Outcome</th>
                <th className="px-4 py-2 font-medium">From</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-4 py-1.5 text-muted">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td
                    className={`px-4 py-1.5 ${row.outcome === 'success' ? '' : 'text-warning'}`}
                  >
                    {LOGIN_OUTCOME_LABELS[row.outcome] ?? row.outcome}
                  </td>
                  <td className="px-4 py-1.5 text-faint">{row.ipPrefix ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-line px-4 py-2 text-xs text-faint">
          Addresses are kept to the network only, not the exact host — enough to tell “the usual
          place” from “somewhere new”, without keeping a movement log.
        </p>
      </section>

      {canManagePolicy && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Company policy</h2>
          <p className="mt-0.5 text-sm text-muted">Applies to everybody in this company.</p>

          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draftPolicy.requireMfa}
              onChange={(event) =>
                setDraftPolicy({ ...draftPolicy, requireMfa: event.target.checked })
              }
              className="mt-1"
            />
            <span>
              Require two-factor authentication
              <span className="block text-xs text-muted">
                Members without it can reach this page and nothing else until they set it up.
                Opt-in MFA is adopted by the people who were never the risk.
              </span>
            </span>
          </label>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-muted">
              <span className="mb-1 block">Failed attempts before lockout</span>
              <input
                type="number"
                min={3}
                value={draftPolicy.maxFailedAttempts}
                onChange={(event) =>
                  setDraftPolicy({ ...draftPolicy, maxFailedAttempts: Number(event.target.value) })
                }
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Lockout minutes</span>
              <input
                type="number"
                min={1}
                value={draftPolicy.lockoutMinutes}
                onChange={(event) =>
                  setDraftPolicy({ ...draftPolicy, lockoutMinutes: Number(event.target.value) })
                }
                className="field w-full py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Session length (days)</span>
              <input
                type="number"
                min={1}
                value={draftPolicy.sessionTtlDays}
                onChange={(event) =>
                  setDraftPolicy({ ...draftPolicy, sessionTtlDays: Number(event.target.value) })
                }
                className="field w-full py-1.5 text-sm"
              />
            </label>
          </div>

          <button
            className="btn btn-primary mt-3"
            disabled={pending}
            onClick={() =>
              startTransition(async () => notify(await updateSecurityPolicyAction(draftPolicy)))
            }
          >
            Save policy
          </button>

          {failures.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Failed attempts against your members, last 7 days
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {failures.map((row) => (
                  <li key={`${row.email}-${row.outcome}`}>
                    <span className="font-medium">{row.email}</span> —{' '}
                    {LOGIN_OUTCOME_LABELS[row.outcome] ?? row.outcome} ×{row.attempts}, last{' '}
                    {new Date(row.lastAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {canExport && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Export your data</h2>
          <p className="mt-0.5 text-sm text-muted">
            The chart of accounts, the journal, bank transactions, customers, invoices, vendors,
            bills, and payments — as CSV another accounting package can read. Your books are yours.
          </p>
          <button className="btn btn-primary mt-3" onClick={runExport} disabled={pending}>
            {pending ? 'Building…' : 'Download everything'}
          </button>

          {exports.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-muted">
              {exports.map((row) => (
                <li key={row.id}>
                  {new Date(row.createdAt).toLocaleString()} — {row.rowCount} rows
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-faint">
            Every export is recorded. It is the broadest read anybody can perform, so who took one
            is worth knowing.
          </p>
        </section>
      )}
    </div>
  )
}


/**
 * The form that starts a claim on a new sign-in address (Phase 98).
 *
 * The reassurance under the field is the point of the whole design and is said
 * before anybody types: nothing changes until the new address is opened, and
 * the address being left is told either way.
 */
function AddressChange({ current }: { current: string }) {
  const [requested, setRequested] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <section className="card space-y-2 p-4">
      <h2 className="text-sm font-semibold">The address you sign in with</h2>
      <p className="text-sm text-muted">
        You sign in as <strong className="text-fg">{current}</strong>. Password resets go there
        too, so an address that stops reaching you is how an account gets lost.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-sm">
          <span className="text-xs text-muted">New address</span>
          <input
            className="input mt-1 w-72"
            type="email"
            value={requested}
            placeholder="you@example.test"
            onChange={(event) => setRequested(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary text-sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await requestAddressChangeAction({ requested })
              setNotice(
                result.ok
                  ? { ok: true, text: result.message }
                  : { ok: false, text: result.error },
              )
              if (result.ok) setRequested('')
            })
          }
        >
          Send a confirmation
        </button>
      </div>

      <p className="text-xs text-muted">
        Nothing changes until you open the link sent to the new address. {current} is told that
        this was asked for, and told again if it happens — because moving where recovery goes is
        the first thing somebody does when they take an account over.
      </p>

      {notice && (
        <p className={`text-sm ${notice.ok ? 'text-positive' : 'text-danger'}`} role="status">
          {notice.text}
        </p>
      )}
    </section>
  )
}
