'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createSegmentAction,
  previewSegmentAction,
  updateSegmentAction,
  type SegmentPreview,
} from '@/app/actions/marketing'
import {
  SEGMENT_FIELDS,
  SEGMENT_OPERATORS,
  type SegmentDefinition,
  type SegmentField,
  type SegmentOperator,
  type SegmentRule,
} from '@/modules/marketing/segments'

type SegmentRow = {
  id: string
  name: string
  description: string | null
  summary: string
  definition: SegmentDefinition
}

const FIELD_LABELS: Record<SegmentField, string> = {
  lifecycleStage: 'Lifecycle stage',
  industry: 'Industry',
  region: 'Region',
  sizeBand: 'Size band',
  source: 'Source',
  isStrategicAccount: 'Strategic account',
  tags: 'Tags',
  opportunityHistory: 'Deal history',
  emailConsent: 'Email consent',
}

const OPERATOR_LABELS: Record<SegmentOperator, string> = {
  is: 'is',
  is_not: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  contains: 'contains',
  is_true: 'is yes',
  is_false: 'is no',
  is_set: 'has a value',
  is_not_set: 'is empty',
}

/** Operators that take no value, so the input is hidden rather than ignored. */
const VALUELESS: SegmentOperator[] = ['is_true', 'is_false', 'is_set', 'is_not_set']

const EMPTY: SegmentDefinition = { matchType: 'all', rules: [], lostOpportunityNurture: false }

/**
 * The segment builder (spec §10).
 *
 * The preview panel is the reason this is a client component: a marketer
 * should see the audience change as they add a rule, and — more importantly —
 * see how much of it they may actually email. Consent is never a footnote
 * here.
 */
export function SegmentWorkspace({
  segments,
  canManage,
}: {
  segments: SegmentRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [definition, setDefinition] = useState<SegmentDefinition>(EMPTY)
  const [preview, setPreview] = useState<SegmentPreview | null>(null)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  // Recount whenever the rules change. Debounced so typing a value does not
  // fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(async () => {
      const result = await previewSegmentAction(normalizeDefinition(definition))
      setPreview(result.ok ? result.preview : null)
    }, 350)

    return () => clearTimeout(timer)
  }, [definition])

  function reset() {
    setEditingId(null)
    setName('')
    setDescription('')
    setDefinition(EMPTY)
  }

  function load(segment: SegmentRow) {
    setEditingId(segment.id)
    setName(segment.name)
    setDescription(segment.description ?? '')
    setDefinition(segment.definition)
  }

  function updateRule(index: number, patch: Partial<SegmentRule>) {
    setDefinition({
      ...definition,
      rules: definition.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    })
  }

  function save() {
    startTransition(async () => {
      const input = { name, description, definition: normalizeDefinition(definition) }
      const result = editingId
        ? await updateSegmentAction(editingId, input)
        : await createSegmentAction(input)

      setMessage({ text: result.ok ? (result.message ?? 'Saved.') : result.error, ok: result.ok })
      if (result.ok) {
        reset()
        router.refresh()
      }
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        {canManage && (
          <section className="card p-4">
            <h2 className="text-sm font-semibold">
              {editingId ? 'Edit segment' : 'Build a segment'}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              A segment describes who you are interested in. Who you may email is decided
              separately, at send time.
            </p>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-muted">Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Dormant construction clients"
                  className="field mt-0.5"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">Description</span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What this list is for"
                  className="field mt-0.5"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Match</span>
              <select
                value={definition.matchType}
                onChange={(event) =>
                  setDefinition({
                    ...definition,
                    matchType: event.target.value as 'all' | 'any',
                  })
                }
                className="field w-auto py-1"
              >
                <option value="all">all rules</option>
                <option value="any">any rule</option>
              </select>
              <span className="text-muted">
                {definition.rules.length === 0 && '— with no rules this is everyone'}
              </span>
            </div>

            <ul className="mt-3 space-y-2">
              {definition.rules.map((rule, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2">
                  <select
                    value={rule.field}
                    onChange={(event) =>
                      updateRule(index, { field: event.target.value as SegmentField })
                    }
                    className="field w-auto py-1 text-sm"
                  >
                    {SEGMENT_FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {FIELD_LABELS[field]}
                      </option>
                    ))}
                  </select>

                  <select
                    value={rule.operator}
                    onChange={(event) =>
                      updateRule(index, { operator: event.target.value as SegmentOperator })
                    }
                    className="field w-auto py-1 text-sm"
                  >
                    {SEGMENT_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {OPERATOR_LABELS[operator]}
                      </option>
                    ))}
                  </select>

                  {!VALUELESS.includes(rule.operator) && (
                    <input
                      value={valueText(rule)}
                      onChange={(event) => updateRule(index, { value: event.target.value })}
                      placeholder={
                        rule.operator === 'in' || rule.operator === 'not_in'
                          ? 'comma, separated, values'
                          : 'value'
                      }
                      className="field w-auto flex-1 py-1 text-sm"
                    />
                  )}

                  <button
                    onClick={() =>
                      setDefinition({
                        ...definition,
                        rules: definition.rules.filter((_, i) => i !== index),
                      })
                    }
                    className="btn px-2 py-1 text-xs"
                    aria-label="Remove rule"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() =>
                  setDefinition({
                    ...definition,
                    rules: [
                      ...definition.rules,
                      { field: 'industry', operator: 'is', value: '' },
                    ],
                  })
                }
                className="btn text-xs"
              >
                Add a rule
              </button>

              <label className="ml-auto flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={definition.lostOpportunityNurture}
                  onChange={(event) =>
                    setDefinition({
                      ...definition,
                      lostOpportunityNurture: event.target.checked,
                    })
                  }
                />
                Only lost deals marked eligible for nurture
              </label>
            </div>

            <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
              <button
                onClick={save}
                disabled={pending || !name.trim()}
                className="btn btn-primary text-xs"
              >
                {pending ? 'Saving…' : editingId ? 'Save changes' : 'Create segment'}
              </button>
              {editingId && (
                <button onClick={reset} className="btn text-xs">
                  Cancel
                </button>
              )}
              {message && (
                <span
                  role="status"
                  className={`text-xs ${message.ok ? 'text-positive' : 'text-negative'}`}
                >
                  {message.text}
                </span>
              )}
            </div>
          </section>
        )}

        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Saved segments</h2>
            <p className="text-xs text-muted">
              Evaluated when a campaign sends, not when they were saved.
            </p>
          </header>

          {segments.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              No segments yet.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {segments.map((segment) => (
                <li key={segment.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{segment.name}</p>
                    {segment.description && (
                      <p className="mt-0.5 text-xs text-muted">{segment.description}</p>
                    )}
                    <p className="mt-0.5 text-xs text-faint">{segment.summary}</p>
                  </div>
                  {canManage && (
                    <button onClick={() => load(segment)} className="btn shrink-0 text-xs">
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <section className="card p-4">
          <h2 className="text-sm font-semibold">This audience</h2>

          {preview === null ? (
            <p className="mt-3 text-sm text-muted">Counting…</p>
          ) : (
            <>
              <p className="tnum mt-2 text-3xl font-semibold text-brand">
                {preview.contactable}
              </p>
              <p className="text-xs text-muted">
                may be emailed, of {preview.total} who match
              </p>

              <ul className="mt-4 space-y-1.5 border-t border-line pt-3 text-xs">
                <Reason count={preview.noConsent} label="have not opted in" />
                <Reason count={preview.suppressed} label="unsubscribed or bounced" />
                <Reason count={preview.noEmail} label="have no email address" />
              </ul>

              {preview.total > 0 && preview.contactable === 0 && (
                <p className="mt-3 text-xs text-warning">
                  Everyone here matches, but nobody has given consent. Widening the rules
                  will not change that.
                </p>
              )}
            </>
          )}
        </section>
      </aside>
    </div>
  )
}

/** What to show in the value box for a rule. */
function valueText(rule: SegmentRule): string {
  if (Array.isArray(rule.value)) return rule.value.join(', ')
  return typeof rule.value === 'string' ? rule.value : ''
}

/**
 * The "is one of" operators take a list, so a comma-separated box becomes one.
 *
 * Done on the way out rather than on every keystroke: splitting as the author
 * types would swallow the comma they just pressed. Empty entries are dropped
 * so a trailing comma does not become a rule matching the empty string.
 */
function normalizeDefinition(definition: SegmentDefinition): SegmentDefinition {
  return {
    ...definition,
    rules: definition.rules.map((rule) => {
      if (rule.operator !== 'in' && rule.operator !== 'not_in') return rule

      const parts = (Array.isArray(rule.value) ? rule.value : [String(rule.value ?? '')])
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter(Boolean)

      return { ...rule, value: parts }
    }),
  }
}

function Reason({ count, label }: { count: number; label: string }) {
  if (count === 0) return null

  return (
    <li className="flex justify-between gap-2 text-muted">
      <span>{label}</span>
      <span className="tnum">{count}</span>
    </li>
  )
}
