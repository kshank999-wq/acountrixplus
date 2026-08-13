'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  applyTemplateAction,
  saveAsTemplateAction,
  saveDocumentAction,
} from '@/app/actions/studio'
import {
  definitionsForKind,
  moveBlock,
  type Block,
  type BlockType,
} from '@/modules/design/blocks'
import { MERGE_FIELD_GROUPS, resolveBlocks, type MergeContext } from '@/modules/design/merge-fields'
import { DocumentPage } from '@/components/design/document-page'
import { BlockEditor } from './block-editor'

type Brand = {
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

type Item = {
  id: string
  description: string
  quantityMilli: number
  unitPriceCents: number
  amountCents: number
  isOptional: boolean
  isSelected: boolean
}

/**
 * The proposal designer (spec §7).
 *
 * Two panes: a block list on the left and a live preview on the right, using
 * the same renderer the client will see. Editing a sent proposal is blocked —
 * the sent version is a snapshot, and changing what a client is looking at
 * mid-read would be worse than making them wait for version 2.
 */
export function Designer({
  documentId,
  proposalNumber,
  proposalTitle,
  isEditable,
  status,
  initialBlocks,
  setup,
  brand,
  context,
  unresolvedFields,
  items,
  discountCents,
  taxCents,
  templates,
  clauses,
  assets,
}: {
  documentId: string
  proposalNumber: string
  proposalTitle: string
  isEditable: boolean
  status: string
  initialBlocks: Block[]
  setup: {
    pageSize: string
    orientation: string
    marginTopPt: number
    marginRightPt: number
    marginBottomPt: number
    marginLeftPt: number
    headerText: string | null
    footerText: string | null
  }
  brand: Brand | null
  context: MergeContext
  unresolvedFields: string[]
  items: Item[]
  discountCents: number
  taxCents: number
  templates: Array<{
    key: string
    name: string
    description: string
    source: string
    industry: string | null
  }>
  clauses: Array<{ id: string; title: string; body: string; approved: boolean }>
  assets: Array<{ id: string; filename: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [blocks, setBlocks] = useState<Block[]>(initialBlocks)
  const [selectedId, setSelectedId] = useState<string | null>(initialBlocks[0]?.id ?? null)
  const [dirty, setDirty] = useState(false)
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)

  const definitions = useMemo(() => definitionsForKind('proposal'), [])
  const selected = blocks.find((block) => block.id === selectedId) ?? null

  function notify(result: { ok: boolean; message?: string; error?: string }) {
    setToast({
      text: result.ok ? (result.message ?? 'Saved.') : (result.error ?? 'Failed.'),
      ok: result.ok,
    })
    setTimeout(() => setToast(null), 5000)
  }

  function update(next: Block[]) {
    setBlocks(next)
    setDirty(true)
  }

  function addBlock(type: BlockType) {
    const definition = definitions.find((item) => item.type === type)
    if (!definition) return

    const block = definition.create(crypto.randomUUID())
    update([...blocks, block])
    setSelectedId(block.id)
  }

  function save() {
    startTransition(async () => {
      const result = await saveDocumentAction(documentId, blocks)
      notify(result)
      if (result.ok) {
        setDirty(false)
        router.refresh()
      }
    })
  }

  const preview = useMemo(() => resolveBlocks(blocks, context), [blocks, context])
  const assetUrl = (assetId: string) => `/api/assets/${assetId}`

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">
            <span className="tnum text-faint">{proposalNumber}</span> {proposalTitle}
          </h1>
          <p className="text-xs text-muted">
            {isEditable
              ? 'Editing the draft. The client sees this once you send it.'
              : `This proposal is ${status.replace('_', ' ')} — its sent version is locked.`}
          </p>
        </div>

        {isEditable && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowTemplates((value) => !value)}
              className="btn text-xs"
            >
              Templates
            </button>
            <button
              onClick={() => {
                const name = prompt('Save this layout as a template. Name it:')
                if (!name) return
                startTransition(async () => {
                  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
                  notify(await saveAsTemplateAction(documentId, key, name))
                })
              }}
              className="btn text-xs"
            >
              Save as template
            </button>
            <button
              onClick={save}
              disabled={!dirty || pending}
              className="btn btn-primary text-xs"
            >
              {pending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </div>
        )}
      </header>

      {showTemplates && isEditable && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Start from a template</h2>
          <p className="mt-0.5 text-xs text-warning">
            Applying a template replaces everything in this document.
          </p>

          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {templates.map((template) => (
              <li key={`${template.source}-${template.key}`}>
                <button
                  onClick={() =>
                    startTransition(async () => {
                      const result = await applyTemplateAction(documentId, template.key)
                      notify(result)
                      if (result.ok) {
                        setShowTemplates(false)
                        router.refresh()
                      }
                    })
                  }
                  disabled={pending}
                  className="w-full rounded-lg border border-line p-3 text-left hover:bg-raised"
                >
                  <p className="text-sm font-medium">
                    {template.name}
                    {template.source === 'company' && (
                      <span className="ml-1.5 chip bg-brand/15 text-brand">yours</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{template.description}</p>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unresolvedFields.length > 0 && (
        <p className="card border-warning/40 p-3 text-xs text-warning">
          These merge fields have no value yet and will render blank:{' '}
          <span className="font-mono">{unresolvedFields.join(', ')}</span>. Fill them in through
          Company Studio or the client record.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        {/* Left: block list and the selected block's fields. */}
        <div className="space-y-3">
          {isEditable && (
            <section className="card p-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Add a block
              </h2>
              <div className="flex flex-wrap gap-1">
                {definitions.map((definition) => (
                  <button
                    key={definition.type}
                    onClick={() => addBlock(definition.type)}
                    title={definition.description}
                    className="chip bg-raised px-2 py-1 text-muted hover:text-ink"
                  >
                    {definition.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="card overflow-hidden">
            <header className="border-b border-line px-3 py-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Blocks
              </h2>
            </header>

            <ul className="divide-y divide-line">
              {blocks.map((block, index) => (
                <li key={block.id}>
                  <div
                    className={`flex items-center gap-2 px-3 py-2 ${
                      selectedId === block.id ? 'bg-raised' : ''
                    }`}
                  >
                    <button
                      onClick={() => setSelectedId(block.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="text-sm">{labelFor(block)}</span>
                    </button>

                    {isEditable && (
                      <div className="flex shrink-0 gap-0.5">
                        <button
                          onClick={() => update(moveBlock(blocks, index, index - 1))}
                          disabled={index === 0}
                          className="btn px-1.5 py-0.5 text-xs"
                          aria-label="Move up"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => update(moveBlock(blocks, index, index + 1))}
                          disabled={index === blocks.length - 1}
                          className="btn px-1.5 py-0.5 text-xs"
                          aria-label="Move down"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => {
                            update(blocks.filter((item) => item.id !== block.id))
                            if (selectedId === block.id) setSelectedId(null)
                          }}
                          className="btn px-1.5 py-0.5 text-xs"
                          aria-label="Delete block"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}

              {blocks.length === 0 && (
                <li className="px-3 py-8 text-center text-xs text-muted">
                  Empty document. Add a block or apply a template.
                </li>
              )}
            </ul>
          </section>

          {selected && isEditable && (
            <BlockEditor
              block={selected}
              clauses={clauses}
              assets={assets}
              onChange={(next) =>
                update(blocks.map((block) => (block.id === next.id ? next : block)))
              }
            />
          )}

          {isEditable && (
            <details className="card p-3">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
                Merge fields
              </summary>
              <p className="mt-2 text-xs text-muted">
                Paste any of these into a text field. They fill in from the client record and
                Company Studio.
              </p>
              {MERGE_FIELD_GROUPS.map((group) => (
                <div key={group.group} className="mt-2">
                  <p className="text-xs font-medium">{group.group}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {group.fields.map((field) => (
                      <code
                        key={field.key}
                        className="rounded bg-raised px-1.5 py-0.5 text-xs"
                        title={field.label}
                      >
                        {`{{${field.key}}}`}
                      </code>
                    ))}
                  </div>
                </div>
              ))}
            </details>
          )}
        </div>

        {/* Right: live preview through the real renderer. */}
        <section className="card overflow-hidden">
          <header className="border-b border-line px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Preview
            </h2>
          </header>
          <div className="max-h-[75vh] overflow-y-auto bg-white">
            <DocumentPage
              blocks={preview}
              setup={setup}
              brand={brand}
              context={context}
              data={{
                items,
                discountCents,
                taxCents,
                logoUrl: brand?.logoAssetId ? assetUrl(brand.logoAssetId) : null,
                assetUrl,
              }}
            />
          </div>
        </section>
      </div>

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

/** A short label for the block list, preferring the block's own content. */
function labelFor(block: Block): string {
  switch (block.type) {
    case 'cover':
      return `Cover — ${truncate(block.title) || 'untitled'}`
    case 'heading':
      return `Heading — ${truncate(block.text) || 'untitled'}`
    case 'text':
      return `Text — ${truncate(block.text) || 'empty'}`
    case 'list':
      return `List — ${block.items.length} item${block.items.length === 1 ? '' : 's'}`
    case 'keyValue':
      return `Details — ${truncate(block.title) || `${block.rows.length} rows`}`
    case 'pricingTable':
      return `Fee table — ${truncate(block.title)}`
    case 'image':
      return block.assetId ? 'Image' : 'Image — none chosen'
    case 'columns':
      return `Columns — ${block.columns.length}`
    case 'clause':
      return `Clause — ${truncate(block.title) || 'none chosen'}`
    case 'signature':
      return 'Acceptance'
    case 'divider':
      return 'Divider'
    case 'spacer':
      return `Spacer — ${block.heightPt}pt`
    case 'pageBreak':
      return 'Page break'
    default:
      return 'Block'
  }
}

function truncate(value: string, length = 28): string {
  const trimmed = value.trim()
  return trimmed.length > length ? `${trimmed.slice(0, length)}…` : trimmed
}
