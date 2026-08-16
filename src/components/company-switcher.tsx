'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { switchCompanyAction } from '@/app/actions/practice'

type Company = {
  id: string
  name: string
  role: string
  viaPracticeName: string | null
  isCurrent: boolean
}

/**
 * The company switcher.
 *
 * Only rendered when there is more than one company to switch between, which
 * for almost every user is never. An accountant with forty clients needs it on
 * every page; a shopkeeper with one company should not be shown a control that
 * implies they have somewhere else to be.
 */
export function CompanySwitcher({
  companies,
  currentName,
}: {
  companies: Company[]
  currentName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  if (companies.length < 2) return null

  const mine = companies.filter((company) => !company.viaPracticeName)
  const clients = companies.filter((company) => company.viaPracticeName)

  function go(companyId: string) {
    startTransition(async () => {
      const result = await switchCompanyAction(companyId)
      setOpen(false)
      if (result.ok) {
        // Straight to the inbox rather than staying put: the page you were on
        // in one company is rarely the page you want in the next, and a
        // deep link that happens to exist in both would silently change
        // whose figures you are looking at.
        router.push('/bookkeeping')
        router.refresh()
      }
    })
  }

  return (
    <div className="relative">
      <button
        className="btn text-xs"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        Switch company
      </button>

      {open && (
        <div
          className="absolute right-0 z-30 mt-1 max-h-96 w-72 overflow-y-auto rounded border border-line bg-surface p-1 shadow-lg"
          role="listbox"
        >
          {mine.length > 0 && <Group label="Your own" />}
          {mine.map((company) => (
            <Row key={company.id} company={company} pending={pending} onPick={go} />
          ))}

          {clients.length > 0 && <Group label="Clients" />}
          {clients.map((company) => (
            <Row key={company.id} company={company} pending={pending} onPick={go} />
          ))}

          <p className="px-2 py-2 text-xs text-faint">
            You are in <span className="font-medium">{currentName}</span>. Switching changes which
            books you are looking at — you are never in two at once.
          </p>
        </div>
      )}
    </div>
  )
}

function Group({ label }: { label: string }) {
  return (
    <p className="px-2 pb-1 pt-2 text-xs uppercase tracking-wide text-faint">{label}</p>
  )
}

function Row({
  company,
  pending,
  onPick,
}: {
  company: Company
  pending: boolean
  onPick: (id: string) => void
}) {
  return (
    <button
      role="option"
      aria-selected={company.isCurrent}
      disabled={pending || company.isCurrent}
      onClick={() => onPick(company.id)}
      className={`flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ${
        company.isCurrent ? 'bg-raised' : 'hover:bg-raised'
      }`}
    >
      <span className="truncate">
        {company.name}
        {company.viaPracticeName && (
          <span className="block text-xs text-faint">via {company.viaPracticeName}</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted">
        {company.isCurrent ? 'current' : company.role}
      </span>
    </button>
  )
}
