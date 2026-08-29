'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  deleteDocumentAction,
  detachEvidenceAction,
  resolveNoteAction,
  uploadEvidenceAction,
  writeNoteAction,
  type ActionResult,
} from '@/app/actions/evidence'
import {
  EVIDENCE_ACCEPT,
  MAX_EVIDENCE_MB,
  formatBytes,
} from '@/modules/evidence/vocabulary'

export type EvidenceItemView = {
  documentId: string
  filename: string
  contentType: string
  sizeBytes: number
  uploadedByName: string | null
}

export type NoteView = {
  id: string
  body: string
  isQuestion: boolean
  authorName: string
  createdAt: string
  resolved: boolean
}

/**
 * Paperwork and notes on one record.
 *
 * One component for every kind of record, because "what is the evidence for
 * this?" is the same question about a bill, a journal entry and a fixed asset,
 * and three panels would have drifted into three answers. What may be attached
 * to what — and who may do it — is decided on the server by the subject
 * registry; this only knows a type name and an id.
 */
export function EvidencePanel({
  subjectType,
  subjectId,
  documents,
  notes,
  canManage,
  compact = false,
}: {
  subjectType: string
  subjectId: string
  documents: EvidenceItemView[]
  notes: NoteView[]
  canManage: boolean
  compact?: boolean
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [noteBody, setNoteBody] = useState('')
  const [asQuestion, setAsQuestion] = useState(false)

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

  function upload(file: File) {
    const form = new FormData()
    form.set('subjectType', subjectType)
    form.set('subjectId', subjectId)
    form.set('file', file)
    act(() => uploadEvidenceAction(form))
    if (fileInput.current) fileInput.current.value = ''
  }

  const openQuestions = notes.filter((note) => note.isQuestion && !note.resolved)

  return (
    <section className={compact ? 'space-y-3' : 'card space-y-4 p-4'}>
      {!compact && (
        <header>
          <h3 className="text-sm font-semibold">Paperwork and notes</h3>
          <p className="text-xs text-muted">
            {documents.length === 0 ? 'Nothing attached yet.' : `${documents.length} attached.`}
            {openQuestions.length > 0 && (
              <span className="text-warning">
                {' '}
                {openQuestions.length} unanswered{' '}
                {openQuestions.length === 1 ? 'question' : 'questions'}.
              </span>
            )}
          </p>
        </header>
      )}

      {notice && (
        <p className={`text-xs ${notice.ok ? 'text-success' : 'text-danger'}`} role="status">
          {notice.text}
        </p>
      )}

      <ul className="space-y-1">
        {documents.map((document) => (
          <li key={document.documentId} className="flex flex-wrap items-center gap-2 text-sm">
            <a
              href={`/api/documents/${document.documentId}`}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate text-action hover:underline"
            >
              {document.filename}
            </a>
            <span className="text-xs text-faint">{formatBytes(document.sizeBytes)}</span>
            {canManage && (
              <>
                <button
                  className="btn btn-ghost text-xs"
                  disabled={pending}
                  onClick={() =>
                    act(() =>
                      detachEvidenceAction({
                        subjectType,
                        subjectId,
                        documentId: document.documentId,
                      }),
                    )
                  }
                  title="Take it off this record. The file stays in your documents."
                >
                  Remove
                </button>
                <button
                  className="btn btn-ghost text-xs text-danger"
                  disabled={pending}
                  onClick={() => act(() => deleteDocumentAction(document.documentId))}
                  title="Delete the file everywhere it is attached."
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <div>
          <input
            ref={fileInput}
            type="file"
            accept={EVIDENCE_ACCEPT}
            className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border file:border-line file:bg-raised file:px-3 file:py-1.5 file:text-xs file:text-ink"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) upload(file)
            }}
          />
          <p className="mt-1 text-xs text-faint">
            PDF, photo, or spreadsheet, up to {MAX_EVIDENCE_MB} MB. The same file attached to two
            records is stored once.
          </p>
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        {notes.length === 0 ? (
          <p className="text-xs text-faint">No notes.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((note) => (
              <li key={note.id} className="text-sm">
                <p className={note.isQuestion && !note.resolved ? 'text-warning' : ''}>
                  {note.isQuestion && <span className="font-medium">Q: </span>}
                  {note.body}
                </p>
                <p className="text-xs text-faint">
                  {note.authorName} · {note.createdAt}
                  {note.isQuestion && note.resolved && ' · answered'}
                  {note.isQuestion && !note.resolved && canManage && (
                    <>
                      {' · '}
                      <button
                        className="text-action hover:underline"
                        disabled={pending}
                        onClick={() => act(() => resolveNoteAction(note.id))}
                      >
                        mark answered
                      </button>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <div className="space-y-2">
            <textarea
              value={noteBody}
              onChange={(event) => setNoteBody(event.target.value)}
              rows={2}
              placeholder="Why this was treated the way it was…"
              className="field text-sm"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={asQuestion}
                  onChange={(event) => setAsQuestion(event.target.checked)}
                />
                This is a question
              </label>
              <button
                className="btn btn-ghost text-xs"
                disabled={pending || noteBody.trim().length === 0}
                onClick={() => {
                  act(() =>
                    writeNoteAction({
                      subjectType,
                      subjectId,
                      body: noteBody,
                      isQuestion: asQuestion,
                    }),
                  )
                  setNoteBody('')
                  setAsQuestion(false)
                }}
              >
                {asQuestion ? 'Ask' : 'Add note'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
