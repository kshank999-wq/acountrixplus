'use client'

import type { Block } from '@/modules/design/blocks'

/**
 * Field editor for the selected block.
 *
 * One case per block type. Deliberately plain inputs rather than a
 * WYSIWYG surface: spec §7 asks for business-document layout first, and a
 * form the author can reason about produces cleaner documents than a
 * contenteditable canvas that quietly accumulates markup.
 */
export function BlockEditor({
  block,
  clauses,
  assets,
  onChange,
}: {
  block: Block
  clauses: Array<{ id: string; title: string; body: string; approved: boolean }>
  assets: Array<{ id: string; filename: string }>
  onChange: (block: Block) => void
}) {
  const set = (patch: Partial<Block>) => onChange({ ...block, ...patch } as Block)

  return (
    <section className="card p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Edit block
      </h2>

      {block.type === 'cover' && (
        <div className="space-y-2">
          <Field label="Title" value={block.title} onChange={(title) => set({ title })} />
          <Field
            label="Subtitle"
            value={block.subtitle}
            onChange={(subtitle) => set({ subtitle })}
          />
          <Field
            label="Prepared for"
            value={block.preparedFor}
            onChange={(preparedFor) => set({ preparedFor })}
          />
          <Toggle
            label="Show logo"
            checked={block.showLogo}
            onChange={(showLogo) => set({ showLogo })}
          />
          <Toggle
            label="Brand colour background"
            checked={block.useBrandBackground}
            onChange={(useBrandBackground) => set({ useBrandBackground })}
          />
        </div>
      )}

      {block.type === 'heading' && (
        <div className="space-y-2">
          <Field label="Text" value={block.text} onChange={(text) => set({ text })} />
          <Select
            label="Level"
            value={String(block.level)}
            options={[
              { value: '1', label: 'Title' },
              { value: '2', label: 'Section' },
              { value: '3', label: 'Subsection' },
            ]}
            onChange={(value) => set({ level: Number(value) as 1 | 2 | 3 })}
          />
          <AlignPicker value={block.align} onChange={(align) => set({ align })} />
        </div>
      )}

      {block.type === 'text' && (
        <div className="space-y-2">
          <TextArea
            label="Text"
            value={block.text}
            rows={6}
            onChange={(text) => set({ text })}
            hint="A blank line starts a new paragraph. Merge fields work here."
          />
          <AlignPicker value={block.align} onChange={(align) => set({ align })} />
          <Toggle
            label="Lead paragraph (larger)"
            checked={block.emphasis}
            onChange={(emphasis) => set({ emphasis })}
          />
        </div>
      )}

      {block.type === 'list' && (
        <div className="space-y-2">
          <TextArea
            label="Items"
            value={block.items.join('\n')}
            rows={6}
            onChange={(value) => set({ items: value.split('\n') })}
            hint="One item per line."
          />
          <Toggle
            label="Numbered"
            checked={block.ordered}
            onChange={(ordered) => set({ ordered })}
          />
        </div>
      )}

      {block.type === 'keyValue' && (
        <div className="space-y-2">
          <Field label="Title" value={block.title} onChange={(title) => set({ title })} />
          <TextArea
            label="Rows"
            value={block.rows.map((row) => `${row.label} | ${row.value}`).join('\n')}
            rows={6}
            onChange={(value) =>
              set({
                rows: value
                  .split('\n')
                  .filter((line) => line.trim())
                  .map((line) => {
                    const [label, ...rest] = line.split('|')
                    return { label: label.trim(), value: rest.join('|').trim() }
                  }),
              })
            }
            hint="One row per line, as: Label | Value"
          />
        </div>
      )}

      {block.type === 'pricingTable' && (
        <div className="space-y-2">
          <Field label="Title" value={block.title} onChange={(title) => set({ title })} />
          <Toggle
            label="Show quantity column"
            checked={block.showQuantity}
            onChange={(showQuantity) => set({ showQuantity })}
          />
          <Toggle
            label="Show rate column"
            checked={block.showUnitPrice}
            onChange={(showUnitPrice) => set({ showUnitPrice })}
          />
          <Toggle
            label="Let the client choose optional items"
            checked={block.allowOptionalSelection}
            onChange={(allowOptionalSelection) => set({ allowOptionalSelection })}
          />
          <p className="text-xs text-faint">
            Line items come from the proposal itself, so the figures here always match.
          </p>
        </div>
      )}

      {block.type === 'image' && (
        <div className="space-y-2">
          <Select
            label="Image"
            value={block.assetId ?? ''}
            options={[
              { value: '', label: 'Choose an image…' },
              ...assets.map((asset) => ({ value: asset.id, label: asset.filename })),
            ]}
            onChange={(assetId) => set({ assetId: assetId || null })}
          />
          <Field
            label="Caption"
            value={block.caption}
            onChange={(caption) => set({ caption })}
          />
          <label className="block text-xs text-muted">
            <span className="mb-1 block">Width ({block.widthPercent}%)</span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={block.widthPercent}
              onChange={(event) => set({ widthPercent: Number(event.target.value) })}
              className="w-full"
            />
          </label>
          <AlignPicker value={block.align} onChange={(align) => set({ align })} />
        </div>
      )}

      {block.type === 'columns' && (
        <div className="space-y-2">
          {block.columns.map((column, index) => (
            <div key={index} className="rounded-lg border border-line p-2">
              <Field
                label={`Column ${index + 1} heading`}
                value={column.heading}
                onChange={(heading) =>
                  set({
                    columns: block.columns.map((item, i) =>
                      i === index ? { ...item, heading } : item,
                    ),
                  })
                }
              />
              <TextArea
                label="Body"
                value={column.body}
                rows={3}
                onChange={(body) =>
                  set({
                    columns: block.columns.map((item, i) =>
                      i === index ? { ...item, body } : item,
                    ),
                  })
                }
              />
            </div>
          ))}
          <div className="flex gap-2">
            {block.columns.length < 3 && (
              <button
                onClick={() => set({ columns: [...block.columns, { heading: '', body: '' }] })}
                className="btn px-2 py-1 text-xs"
              >
                Add column
              </button>
            )}
            {block.columns.length > 2 && (
              <button
                onClick={() => set({ columns: block.columns.slice(0, -1) })}
                className="btn px-2 py-1 text-xs"
              >
                Remove last
              </button>
            )}
          </div>
        </div>
      )}

      {block.type === 'clause' && (
        <div className="space-y-2">
          <Select
            label="Clause"
            value={block.clauseVersionId ?? ''}
            options={[
              { value: '', label: 'Choose a clause…' },
              ...clauses.map((clause) => ({
                value: clause.id,
                label: `${clause.title}${clause.approved ? '' : ' (draft)'}`,
              })),
            ]}
            onChange={(clauseVersionId) => {
              const chosen = clauses.find((clause) => clause.id === clauseVersionId)
              // The wording is copied in, so the block still renders if the
              // library changes and so the sent version stays fixed.
              set({
                clauseVersionId: clauseVersionId || null,
                title: chosen?.title ?? '',
                body: chosen?.body ?? '',
              })
            }}
          />
          <p className="text-xs text-faint">
            The wording is copied in at this version. Revising the clause later does not change
            this document.
          </p>
        </div>
      )}

      {block.type === 'signature' && (
        <div className="space-y-2">
          <Field label="Prompt" value={block.prompt} onChange={(prompt) => set({ prompt })} />
          <TextArea
            label="Agreement text"
            value={block.agreementText}
            rows={3}
            onChange={(agreementText) => set({ agreementText })}
          />
        </div>
      )}

      {block.type === 'spacer' && (
        <label className="block text-xs text-muted">
          <span className="mb-1 block">Height ({block.heightPt}pt)</span>
          <input
            type="range"
            min={4}
            max={216}
            step={4}
            value={block.heightPt}
            onChange={(event) => set({ heightPt: Number(event.target.value) })}
            className="w-full"
          />
        </label>
      )}

      {(block.type === 'divider' || block.type === 'pageBreak') && (
        <p className="text-xs text-muted">Nothing to configure.</p>
      )}
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field py-1.5 text-sm"
      />
    </label>
  )
}

function TextArea({
  label,
  value,
  rows,
  onChange,
  hint,
}: {
  label: string
  value: string
  rows: number
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <label className="block text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="field text-sm"
      />
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="rounded border-line"
      />
      {label}
    </label>
  )
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <label className="block text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function AlignPicker({
  value,
  onChange,
}: {
  value: 'left' | 'center' | 'right'
  onChange: (value: 'left' | 'center' | 'right') => void
}) {
  return (
    <div className="text-xs text-muted">
      <span className="mb-1 block">Alignment</span>
      <div className="flex gap-1">
        {(['left', 'center', 'right'] as const).map((option) => (
          <button
            key={option}
            onClick={() => onChange(option)}
            className={`chip px-2 py-1 ${
              value === option ? 'bg-brand text-brand-ink' : 'bg-raised text-muted'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}
