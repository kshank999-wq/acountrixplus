'use client'

import { useRef, useState } from 'react'
import { MAX_TABLE_COLUMNS, normalizeCrop, type Block, type Crop } from '@/modules/design/blocks'

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
  team,
  assetUrl,
  onChange,
}: {
  block: Block
  clauses: Array<{ id: string; title: string; body: string; approved: boolean }>
  assets: Array<{ id: string; filename: string }>
  /**
   * The active team directory, for a `team` block (Phase 183).
   *
   * Active only: retiring somebody is how a firm takes them out of the
   * directory without taking them off the proposals that named them, so a
   * retired member keeps rendering where they are already chosen and cannot be
   * newly added.
   */
  team: Array<{ id: string; name: string; title: string | null }>
  /** Builds the URL of an asset, for the crop editor's preview (Phase 186). */
  assetUrl: (assetId: string) => string
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

          <CropEditor
            crop={block.crop}
            assetId={block.assetId}
            assetUrl={assetUrl}
            onChange={(crop) => set({ crop })}
          />

          <Select
            label="Shape"
            value={block.maskShape}
            options={[
              { value: 'none', label: 'Square corners' },
              { value: 'rounded', label: 'Rounded corners' },
              { value: 'circle', label: 'Circle' },
            ]}
            onChange={(value) => set({ maskShape: value as 'none' | 'rounded' | 'circle' })}
          />
          <p className="text-xs text-faint">
            The crop and the shape both reach the PDF. An email shows no pictures at all, so
            neither reaches one.
          </p>
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

      {block.type === 'table' && (
        <div className="space-y-2">
          <Field label="Title" value={block.title} onChange={(title) => set({ title })} />
          <TextArea
            label="Header"
            value={block.header.join(' | ')}
            rows={1}
            onChange={(value) =>
              set({
                header: value.trim()
                  ? value.split('|').map((cell) => cell.trim()).slice(0, MAX_TABLE_COLUMNS)
                  : [],
              })
            }
            hint={`Pipe-separated, up to ${MAX_TABLE_COLUMNS} columns. Leave empty for no header row.`}
          />
          <TextArea
            label="Rows"
            value={block.rows.map((row) => row.join(' | ')).join('\n')}
            rows={6}
            onChange={(value) =>
              set({
                /*
                  Padded to the table's width as it is typed, so the save path
                  never sees a ragged table — `validateBlocks` refuses one and
                  the author would get an error about a row they are halfway
                  through writing.
                */
                rows: value
                  .split('\n')
                  .filter((line) => line.trim())
                  .map((line) => {
                    const cells = line.split('|').map((cell) => cell.trim())
                    const width = Math.min(
                      block.header.length > 0 ? block.header.length : cells.length,
                      MAX_TABLE_COLUMNS,
                    )
                    return Array.from({ length: width }, (_, index) => cells[index] ?? '')
                  }),
              })
            }
            hint="One row per line, cells separated by |"
          />
          <label className="block text-xs text-muted">
            <span className="mb-1 block">Alignment</span>
            <input
              value={block.columnAlign.join(' | ')}
              onChange={(event) =>
                set({
                  columnAlign: event.target.value
                    .split('|')
                    .map((part) => part.trim().toLowerCase())
                    .filter((part): part is 'left' | 'center' | 'right' =>
                      part === 'left' || part === 'center' || part === 'right',
                    )
                    .slice(0, MAX_TABLE_COLUMNS),
                })
              }
              className="field py-1.5 text-sm"
              placeholder="left | left | right"
            />
            <span className="mt-1 block text-faint">
              Per column. Shorter than the row means left from there on.
            </span>
          </label>
          <Select
            label="Rules"
            value={block.style}
            options={[
              { value: 'rows', label: 'Between rows' },
              { value: 'grid', label: 'Every cell' },
              { value: 'plain', label: 'None' },
            ]}
            onChange={(value) => set({ style: value as 'grid' | 'rows' | 'plain' })}
          />
        </div>
      )}

      {/*
        Phase 5 added `button`, `qrCode` and `video` to the union, the palette
        and all three renderers — and not to this editor, whose own docstring
        says "one case per block type". So for twenty-three phases a marketing
        document could contain a call-to-action button that rendered on the
        page, in the email and in the PDF with its default label and an **empty
        url**, and there was no way to set it.

        Found in Phase 181 by counting which types reach which surfaces, which
        is now a test. The capability was §8's "buttons/links, QR codes,
        embedded/linked video" — three bullets that existed everywhere except
        where somebody would configure them.
      */}
      {block.type === 'button' && (
        <div className="space-y-2">
          <Field label="Label" value={block.label} onChange={(label) => set({ label })} />
          <Field label="Link" value={block.url} onChange={(url) => set({ url })} />
          <Select
            label="Style"
            value={block.style}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'outline', label: 'Outline' },
            ]}
            onChange={(value) => set({ style: value as 'solid' | 'outline' })}
          />
          <AlignPicker value={block.align} onChange={(align) => set({ align })} />
        </div>
      )}

      {block.type === 'qrCode' && (
        <div className="space-y-2">
          <Field
            label="Encodes"
            value={block.value}
            onChange={(value) => set({ value })}
          />
          <Field label="Caption" value={block.caption} onChange={(caption) => set({ caption })} />
          <label className="block text-xs text-muted">
            <span className="mb-1 block">Size — {block.sizePt}pt</span>
            <input
              type="range"
              min={48}
              max={288}
              step={12}
              value={block.sizePt}
              onChange={(event) => set({ sizePt: Number(event.target.value) })}
              className="w-full"
            />
          </label>
        </div>
      )}

      {block.type === 'video' && (
        <div className="space-y-2">
          <Field label="Link" value={block.url} onChange={(url) => set({ url })} />
          <Field label="Caption" value={block.caption} onChange={(caption) => set({ caption })} />
          <label className="block text-xs text-muted">
            <span className="mb-1 block">Thumbnail</span>
            <select
              value={block.thumbnailAssetId ?? ''}
              onChange={(event) => set({ thumbnailAssetId: event.target.value || null })}
              className="field py-1.5 text-sm"
            >
              <option value="">None</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.filename}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-faint">
              Rendered as a still that links out — a document that has to survive print and email
              cannot rely on an embedded player.
            </span>
          </label>
        </div>
      )}

      {block.type === 'team' && (
        <div className="space-y-2">
          <Field label="Title" value={block.title} onChange={(title) => set({ title })} />

          {team.length === 0 ? (
            /*
              A refusal a person can act on (Phase 119) rather than an empty
              list: the block is in the palette before anybody has filled the
              directory, and "no options" does not say where the options come
              from.
            */
            <p className="text-xs text-muted">
              Nobody is in the team directory yet. Add people in the Design Center and they
              become available here.
            </p>
          ) : (
            <>
              <fieldset className="space-y-1">
                <legend className="mb-1 text-xs text-muted">People</legend>
                {team.map((member) => {
                  const chosen = block.memberIds.indexOf(member.id)
                  return (
                    <label
                      key={member.id}
                      className="flex items-center gap-2 text-xs text-muted"
                    >
                      <input
                        type="checkbox"
                        checked={chosen >= 0}
                        onChange={(event) =>
                          /*
                            Appended on tick and removed on untick, so the order
                            in the block is the order the author chose them —
                            which is the order the document renders. A list that
                            re-sorted itself to the directory's order would throw
                            away the one thing a named selection says.
                          */
                          set({
                            memberIds: event.target.checked
                              ? [...block.memberIds, member.id]
                              : block.memberIds.filter((id) => id !== member.id),
                          })
                        }
                        className="rounded border-line"
                      />
                      <span>
                        {chosen >= 0 && (
                          <span className="mr-1 text-faint">{chosen + 1}.</span>
                        )}
                        {member.name}
                        {member.title && <span className="text-faint"> — {member.title}</span>}
                      </span>
                    </label>
                  )
                })}
              </fieldset>
              <p className="text-xs text-faint">
                {block.memberIds.length === 0
                  ? 'Nobody ticked, so the document shows everybody in the directory order.'
                  : 'They appear in the order you ticked them.'}
              </p>
            </>
          )}

          <Toggle
            label="Show headshots"
            checked={block.showPhotos}
            onChange={(showPhotos) => set({ showPhotos })}
          />
          {block.showPhotos && (
            <Select
              label="Headshot shape"
              value={block.photoShape}
              options={[
                { value: 'square', label: 'Square' },
                { value: 'rounded', label: 'Rounded' },
                { value: 'circle', label: 'Circle' },
              ]}
              onChange={(value) =>
                set({ photoShape: value as 'square' | 'rounded' | 'circle' })
              }
            />
          )}
          <Toggle
            label="Show qualifications after the name"
            checked={block.showQualifications}
            onChange={(showQualifications) => set({ showQualifications })}
          />
          <Select
            label="Layout"
            value={block.layout}
            options={[
              { value: 'list', label: 'List — one per row' },
              { value: 'grid', label: 'Grid — cards' },
            ]}
            onChange={(value) => set({ layout: value as 'list' | 'grid' })}
          />
          <p className="text-xs text-faint">
            Headshots and the grid layout apply on the page. The PDF sets the names and bios as
            text, and an email is stacked — see the block&rsquo;s own note.
          </p>
        </div>
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

/**
 * Choosing which part of a picture is shown (spec §7, Phase 186).
 *
 * ## A preview with a box over it, not four numbers
 *
 * A crop is a shape, and four spinners describing a shape is a form somebody
 * fills in twice and gets wrong once. So the control is the picture with the
 * kept region drawn on it: the author sees the framing they are choosing, which
 * is the only way to tell whether a face is in it.
 *
 * ## Dragging, with the arithmetic in fractions throughout
 *
 * Pointer positions are converted to fractions of the picture immediately and
 * never stored as pixels, which is the same decision `cropSchema` makes and for
 * the same reason: the preview is 300 points wide today and the asset may be
 * replaced by a larger scan tomorrow.
 *
 * Two gestures, because they are the two things people do. Dragging inside the
 * box **moves** it and dragging the corner **resizes** it, and both are clamped
 * by `normalizeCrop` rather than by arithmetic here — one answer to "where can
 * this box be", shared with the renderers.
 *
 * ## The presets earn their place
 *
 * A square and a 16:9 are most of what anybody wants, and dragging to an exact
 * ratio by hand is the kind of fiddling that makes a feature feel broken. They
 * centre on what is already chosen rather than resetting to the middle, so
 * picking "Square" after framing a face keeps the face.
 */
function CropEditor({
  crop,
  assetId,
  assetUrl,
  onChange,
}: {
  crop: Crop
  assetId: string | null
  assetUrl: (assetId: string) => string
  onChange: (crop: Crop) => void
}) {
  const frame = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ mode: 'move' | 'resize'; x: number; y: number } | null>(null)

  if (!assetId) {
    return (
      <p className="text-xs text-faint">Choose an image to crop it.</p>
    )
  }

  const safe = normalizeCrop(crop)

  /** A pointer position as a fraction of the picture, clamped to it. */
  function fractionOf(event: React.PointerEvent): { x: number; y: number } | null {
    const box = frame.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return null

    return {
      x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
    }
  }

  function begin(mode: 'move' | 'resize') {
    return (event: React.PointerEvent) => {
      const at = fractionOf(event)
      if (!at) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setDrag({ mode, x: at.x - safe.x, y: at.y - safe.y })
    }
  }

  function move(event: React.PointerEvent) {
    if (!drag) return
    const at = fractionOf(event)
    if (!at) return

    onChange(
      normalizeCrop(
        drag.mode === 'move'
          ? { ...safe, x: at.x - drag.x, y: at.y - drag.y }
          : { ...safe, width: at.x - safe.x, height: at.y - safe.y },
      ),
    )
  }

  /** Keeps the centre and takes the largest box of the wanted ratio. */
  function preset(ratio: number | null) {
    if (ratio === null) {
      onChange({ x: 0, y: 0, width: 1, height: 1 })
      return
    }

    const width = Math.min(1, ratio)
    const height = Math.min(1, 1 / ratio)
    const centreX = safe.x + safe.width / 2
    const centreY = safe.y + safe.height / 2

    onChange(normalizeCrop({ x: centreX - width / 2, y: centreY - height / 2, width, height }))
  }

  return (
    <div className="space-y-2">
      <span className="block text-xs text-muted">Crop</span>

      <div
        ref={frame}
        className="relative select-none overflow-hidden rounded border border-line bg-raised"
        onPointerMove={move}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={assetUrl(assetId)} alt="" className="block w-full opacity-40" draggable={false} />

        <div
          role="group"
          aria-label="Kept area"
          onPointerDown={begin('move')}
          className="absolute cursor-move border-2 border-brand"
          style={{
            left: `${safe.x * 100}%`,
            top: `${safe.y * 100}%`,
            width: `${safe.width * 100}%`,
            height: `${safe.height * 100}%`,
            // The kept part at full strength over the dimmed whole, so the
            // framing is visible rather than merely outlined.
            backgroundImage: `url(${assetUrl(assetId)})`,
            backgroundSize: `${100 / safe.width}% ${100 / safe.height}%`,
            backgroundPosition: `${(safe.x / (1 - safe.width || 1)) * 100}% ${
              (safe.y / (1 - safe.height || 1)) * 100
            }%`,
          }}
        >
          <span
            onPointerDown={begin('resize')}
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm bg-brand"
            aria-label="Resize the kept area"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {(
          [
            ['Whole picture', null],
            ['Square', 1],
            ['16:9', 16 / 9],
            ['4:3', 4 / 3],
          ] as const
        ).map(([label, ratio]) => (
          <button
            key={label}
            onClick={() => preset(ratio)}
            className="chip bg-raised px-2 py-1 text-xs text-muted hover:text-ink"
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-xs text-faint">
        {Math.round(safe.width * 100)}% × {Math.round(safe.height * 100)}% of the picture. Drag
        the box to move it, or its corner to resize.
      </p>
    </div>
  )
}
