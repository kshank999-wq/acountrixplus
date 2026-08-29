'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCents } from '@/lib/money'
import {
  createClauseAction,
  createServiceItemAction,
  deleteAssetAction,
  reviseClauseAction,
  saveBrandKitAction,
  saveProfileAction,
  uploadAssetAction,
} from '@/app/actions/studio'

type Profile = Record<string, string>
type Kit = {
  id: string
  name: string
  isDefault: boolean
  primaryColor: string
  accentColor: string
  textColor: string
  mutedColor: string
  surfaceColor: string
  headingFont: string
  bodyFont: string
  baseSizePt: number
  logoAssetId: string | null
}

const TABS = [
  { key: 'profile', label: 'Profile' },
  { key: 'brand', label: 'Brand' },
  { key: 'catalog', label: 'Services' },
  { key: 'clauses', label: 'Legal clauses' },
] as const

type Tab = (typeof TABS)[number]['key']

/** The Design Center (spec §15) — one place for identity, brand, and boilerplate. */
export function StudioWorkspace({
  canManage,
  profile,
  kits,
  assets,
  services,
  clauses,
  revenueAccounts,
}: {
  canManage: boolean
  profile: Profile | null
  kits: Kit[]
  assets: Array<{ id: string; filename: string; kind: string; sizeBytes: number }>
  services: Array<{
    id: string
    name: string
    code: string | null
    unit: string
    unitPriceCents: number
    description: string | null
  }>
  clauses: Array<{
    id: string
    title: string
    category: string
    body: string
    versionNumber: number
    approved: boolean
  }>
  revenueAccounts: Array<{ id: string; number: string; name: string }>
}) {
  const [tab, setTab] = useState<Tab>('profile')
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setToast({
      text: result.ok ? (result.message ?? 'Saved.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    setTimeout(() => setToast(null), 6000)
  }

  return (
    <div className="space-y-4">
      <nav className="flex gap-1 overflow-x-auto">
        {TABS.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`chip whitespace-nowrap px-3 py-1.5 ${
              tab === item.key ? 'bg-brand text-brand-ink' : 'bg-raised text-muted hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {!canManage && (
        <p className="card p-3 text-xs text-muted">
          You can view the Design Center but not change it. Ask an owner or admin for access.
        </p>
      )}

      {tab === 'profile' && (
        <ProfileTab profile={profile} canManage={canManage} onResult={notify} />
      )}
      {tab === 'brand' && (
        <BrandTab kits={kits} assets={assets} canManage={canManage} onResult={notify} />
      )}
      {tab === 'catalog' && (
        <CatalogTab
          services={services}
          revenueAccounts={revenueAccounts}
          canManage={canManage}
          onResult={notify}
        />
      )}
      {tab === 'clauses' && (
        <ClausesTab clauses={clauses} canManage={canManage} onResult={notify} />
      )}

      {toast && (
        <div
          role="status"
          className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg ${
            toast.ok
              ? 'border-positive/40 bg-surface text-positive'
              : 'border-negative/40 bg-surface text-negative'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

type Notify = (result: { ok: boolean; message?: string; error?: string }) => void

const PROFILE_FIELDS: Array<{ key: string; label: string; wide?: boolean; multiline?: boolean }> = [
  { key: 'legalName', label: 'Legal name' },
  { key: 'dba', label: 'Trading as' },
  { key: 'tagline', label: 'Tagline', wide: true },
  { key: 'addressLine1', label: 'Address', wide: true },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'State or region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'taxId', label: 'Tax ID' },
  { key: 'paymentInstructions', label: 'Payment instructions', wide: true, multiline: true },
  { key: 'documentFooter', label: 'Document footer', wide: true, multiline: true },
]

function ProfileTab({
  profile,
  canManage,
  onResult,
}: {
  profile: Profile | null
  canManage: boolean
  onResult: Notify
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [values, setValues] = useState<Profile>(profile ?? {})

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Company profile</h2>
      <p className="mt-0.5 text-xs text-muted">
        These values fill merge fields like <code>{'{{company.name}}'}</code> on every proposal.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {PROFILE_FIELDS.map((field) => (
          <label
            key={field.key}
            className={`text-xs text-muted ${field.wide ? 'sm:col-span-2' : ''}`}
          >
            <span className="mb-1 block">{field.label}</span>
            {field.multiline ? (
              <textarea
                value={values[field.key] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                disabled={!canManage}
                rows={3}
                className="field text-sm"
              />
            ) : (
              <input
                value={values[field.key] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                disabled={!canManage}
                className="field py-1.5 text-sm"
              />
            )}
          </label>
        ))}
      </div>

      {canManage && (
        <button
          onClick={() =>
            startTransition(async () => {
              const result = await saveProfileAction(values)
              onResult(result)
              if (result.ok) router.refresh()
            })
          }
          disabled={pending}
          className="btn btn-primary mt-4 text-xs"
        >
          {pending ? 'Saving…' : 'Save profile'}
        </button>
      )}
    </section>
  )
}

const COLOR_FIELDS = [
  { key: 'primaryColor', label: 'Primary' },
  { key: 'accentColor', label: 'Accent' },
  { key: 'textColor', label: 'Text' },
  { key: 'mutedColor', label: 'Muted' },
  { key: 'surfaceColor', label: 'Background' },
] as const

function BrandTab({
  kits,
  assets,
  canManage,
  onResult,
}: {
  kits: Kit[]
  assets: Array<{ id: string; filename: string; kind: string; sizeBytes: number }>
  canManage: boolean
  onResult: Notify
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const existing = kits[0] ?? null

  const [kit, setKit] = useState({
    name: existing?.name ?? 'Default',
    primaryColor: existing?.primaryColor ?? '#0d6e60',
    accentColor: existing?.accentColor ?? '#0f766e',
    textColor: existing?.textColor ?? '#0f172a',
    mutedColor: existing?.mutedColor ?? '#64748b',
    surfaceColor: existing?.surfaceColor ?? '#ffffff',
    headingFont: existing?.headingFont ?? 'Georgia, serif',
    bodyFont: existing?.bodyFont ?? 'system-ui, sans-serif',
    baseSizePt: existing?.baseSizePt ?? 11,
    logoAssetId: existing?.logoAssetId ?? null,
  })

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="text-sm font-semibold">Brand kit</h2>
        <p className="mt-0.5 text-xs text-muted">
          Applied to every proposal and, in Phase 5, to marketing collateral.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-5">
          {COLOR_FIELDS.map((field) => (
            <label key={field.key} className="text-xs text-muted">
              <span className="mb-1 block">{field.label}</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={kit[field.key]}
                  onChange={(event) =>
                    setKit((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  disabled={!canManage}
                  className="h-8 w-9 shrink-0 cursor-pointer rounded border border-line bg-surface"
                  aria-label={`${field.label} colour`}
                />
                <input
                  value={kit[field.key]}
                  onChange={(event) =>
                    setKit((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  disabled={!canManage}
                  className="field py-1 font-mono text-xs"
                />
              </div>
            </label>
          ))}
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-muted">
            <span className="mb-1 block">Heading font</span>
            <select
              value={kit.headingFont}
              onChange={(event) =>
                setKit((current) => ({ ...current, headingFont: event.target.value }))
              }
              disabled={!canManage}
              className="field py-1.5 text-sm"
            >
              <option value="Georgia, serif">Georgia</option>
              <option value="'Times New Roman', serif">Times</option>
              <option value="system-ui, sans-serif">System sans</option>
              <option value="'Helvetica Neue', Arial, sans-serif">Helvetica</option>
            </select>
          </label>

          <label className="text-xs text-muted">
            <span className="mb-1 block">Body font</span>
            <select
              value={kit.bodyFont}
              onChange={(event) =>
                setKit((current) => ({ ...current, bodyFont: event.target.value }))
              }
              disabled={!canManage}
              className="field py-1.5 text-sm"
            >
              <option value="system-ui, sans-serif">System sans</option>
              <option value="Georgia, serif">Georgia</option>
              <option value="'Helvetica Neue', Arial, sans-serif">Helvetica</option>
            </select>
          </label>

          <label className="text-xs text-muted">
            <span className="mb-1 block">Base size (pt)</span>
            <input
              type="number"
              min={8}
              max={18}
              value={kit.baseSizePt}
              onChange={(event) =>
                setKit((current) => ({ ...current, baseSizePt: Number(event.target.value) || 11 }))
              }
              disabled={!canManage}
              className="field py-1.5 text-sm"
            />
          </label>
        </div>

        <label className="mt-3 block text-xs text-muted">
          <span className="mb-1 block">Logo</span>
          <select
            value={kit.logoAssetId ?? ''}
            onChange={(event) =>
              setKit((current) => ({ ...current, logoAssetId: event.target.value || null }))
            }
            disabled={!canManage}
            className="field py-1.5 text-sm"
          >
            <option value="">No logo</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.filename}
              </option>
            ))}
          </select>
        </label>

        {/* Live preview using the values above. */}
        <div
          className="mt-4 rounded-lg p-4"
          style={{ background: kit.primaryColor, color: '#fff' }}
        >
          <p style={{ fontFamily: kit.headingFont, fontSize: '1.5rem', margin: 0 }}>
            Your proposal title
          </p>
          <p style={{ fontFamily: kit.bodyFont, fontSize: '0.85rem', opacity: 0.9, margin: 0 }}>
            Prepared for a client
          </p>
        </div>

        {canManage && (
          <button
            onClick={() =>
              startTransition(async () => {
                const result = await saveBrandKitAction(existing?.id ?? null, kit)
                onResult(result)
                if (result.ok) router.refresh()
              })
            }
            disabled={pending}
            className="btn btn-primary mt-4 text-xs"
          >
            {pending ? 'Saving…' : 'Save brand kit'}
          </button>
        )}
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Logo and image library</h2>
        <p className="mt-0.5 text-xs text-muted">
          PNG, JPEG, WebP, or GIF up to 5 MB. SVG is not accepted — it can carry script, and
          these files are served on public proposal pages.
        </p>

        {canManage && (
          <form
            action={async (formData) => {
              const result = await uploadAssetAction(formData)
              onResult(result)
              if (result.ok) router.refresh()
            }}
            className="mt-3 flex flex-wrap items-end gap-2"
          >
            <label className="text-xs text-muted">
              <span className="mb-1 block">File</span>
              <input
                type="file"
                name="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                required
                className="field py-1.5 text-xs"
              />
            </label>
            <label className="text-xs text-muted">
              <span className="mb-1 block">Kind</span>
              <select name="kind" className="field py-1.5 text-sm">
                <option value="logo">Logo</option>
                <option value="image">Image</option>
              </select>
            </label>
            <button className="btn btn-primary text-xs">Upload</button>
          </form>
        )}

        {assets.length > 0 && (
          <ul className="mt-3 grid gap-2 sm:grid-cols-3">
            {assets.map((asset) => (
              <li key={asset.id} className="rounded-lg border border-line p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/assets/${asset.id}`}
                  alt=""
                  className="h-16 w-full rounded bg-raised object-contain"
                />
                <p className="mt-1 truncate text-xs">{asset.filename}</p>
                <p className="text-xs text-faint">{Math.round(asset.sizeBytes / 1024)} KB</p>
                {canManage && (
                  <button
                    onClick={() =>
                      startTransition(async () => {
                        const result = await deleteAssetAction(asset.id)
                        onResult(result)
                        if (result.ok) router.refresh()
                      })
                    }
                    className="btn mt-1 w-full px-2 py-0.5 text-xs"
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function CatalogTab({
  services,
  revenueAccounts,
  canManage,
  onResult,
}: {
  services: Array<{
    id: string
    name: string
    code: string | null
    unit: string
    unitPriceCents: number
    description: string | null
  }>
  revenueAccounts: Array<{ id: string; number: string; name: string }>
  canManage: boolean
  onResult: Notify
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({
    name: '',
    code: '',
    unit: 'each',
    unitPrice: '',
    description: '',
    chartAccountId: '',
  })

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Services and products</h2>
        <p className="text-xs text-muted">
          Reusable line items. Linking a revenue account means a won proposal becomes an invoice
          without choosing one again.
        </p>
      </header>

      {canManage && (
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-4">
          <label className="flex-1 text-xs text-muted">
            <span className="mb-1 block">Name</span>
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="field py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Unit</span>
            <input
              value={form.unit}
              onChange={(event) => setForm({ ...form, unit: event.target.value })}
              className="field w-24 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Rate</span>
            <input
              value={form.unitPrice}
              onChange={(event) => setForm({ ...form, unitPrice: event.target.value })}
              inputMode="decimal"
              placeholder="0.00"
              className="field w-28 py-1.5 text-right text-sm"
            />
          </label>
          <label className="text-xs text-muted">
            <span className="mb-1 block">Revenue account</span>
            <select
              value={form.chartAccountId}
              onChange={(event) => setForm({ ...form, chartAccountId: event.target.value })}
              className="field py-1.5 text-sm"
            >
              <option value="">None</option>
              {revenueAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.number} · {account.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              startTransition(async () => {
                const result = await createServiceItemAction(form)
                onResult(result)
                if (result.ok) {
                  setForm({ ...form, name: '', unitPrice: '' })
                  router.refresh()
                }
              })
            }
            disabled={!form.name || pending}
            className="btn btn-primary text-xs"
          >
            Add
          </button>
        </div>
      )}

      {services.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">Nothing in the catalog yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {services.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">{item.name}</p>
                {item.description && (
                  <p className="truncate text-xs text-faint">{item.description}</p>
                )}
              </div>
              <span className="tnum shrink-0 text-sm">
                {formatCents(item.unitPriceCents)} / {item.unit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ClausesTab({
  clauses,
  canManage,
  onResult,
}: {
  clauses: Array<{
    id: string
    title: string
    category: string
    body: string
    versionNumber: number
    approved: boolean
  }>
  canManage: boolean
  onResult: Notify
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState({ title: '', category: 'terms', body: '', approve: true })
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Legal and terms library</h2>
        <p className="text-xs text-muted">
          Revising a clause creates a new version. Proposals already sent keep the wording they
          were sent with.
        </p>
      </header>

      {canManage && (
        <div className="space-y-2 border-b border-line p-4">
          <div className="flex flex-wrap gap-2">
            <input
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Clause title"
              className="field flex-1 py-1.5 text-sm"
            />
            <select
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
              className="field w-40 py-1.5 text-sm"
            >
              <option value="terms">Terms</option>
              <option value="payment">Payment</option>
              <option value="warranty">Warranty</option>
              <option value="disclaimer">Disclaimer</option>
              <option value="exclusions">Exclusions</option>
            </select>
          </div>
          <textarea
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
            rows={3}
            placeholder="The wording clients will see."
            className="field text-sm"
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={form.approve}
                onChange={(event) => setForm({ ...form, approve: event.target.checked })}
              />
              Mark as company-approved
            </label>
            <button
              onClick={() =>
                startTransition(async () => {
                  const result = await createClauseAction(form)
                  onResult(result)
                  if (result.ok) {
                    setForm({ ...form, title: '', body: '' })
                    router.refresh()
                  }
                })
              }
              disabled={!form.title || !form.body || pending}
              className="btn btn-primary ml-auto text-xs"
            >
              Add clause
            </button>
          </div>
        </div>
      )}

      {clauses.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No clauses yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {clauses.map((clause) => (
            <li key={clause.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{clause.title}</p>
                <div className="flex items-center gap-1.5">
                  <span className="chip bg-raised text-muted">{clause.category}</span>
                  <span className="chip bg-raised text-faint">v{clause.versionNumber}</span>
                  {clause.approved && (
                    <span className="chip bg-positive/15 text-positive">approved</span>
                  )}
                </div>
              </div>

              {editing?.id === clause.id ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={editing.body}
                    onChange={(event) => setEditing({ ...editing, body: event.target.value })}
                    rows={4}
                    className="field text-sm"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        startTransition(async () => {
                          const result = await reviseClauseAction(clause.id, editing.body, true)
                          onResult(result)
                          if (result.ok) {
                            setEditing(null)
                            router.refresh()
                          }
                        })
                      }
                      disabled={pending}
                      className="btn btn-primary px-3 py-1 text-xs"
                    >
                      Save as new version
                    </button>
                    <button onClick={() => setEditing(null)} className="btn px-3 py-1 text-xs">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="mt-1 whitespace-pre-line text-xs text-muted">{clause.body}</p>
                  {canManage && (
                    <button
                      onClick={() => setEditing({ id: clause.id, body: clause.body })}
                      className="btn mt-2 px-2 py-1 text-xs"
                    >
                      Revise
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
