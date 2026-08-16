'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  deleteDocumentAction,
  resolveNoteAction,
  type ActionResult,
} from '@/app/actions/evidence'
import {
  EVIDENCE_SUBJECT_LABELS,
  EVIDENCE_SUBJECT_PATHS,
  formatBytes,
} from '@/modules/evidence/vocabulary'

type Document = {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  note: string | null
  uploadedByName: string | null
  createdAt: string
  attachedTo: number
}

type Question = {
  id: string
  body: string
  authorName: string
  createdAt: string
  subjectType: string
  subjectId: string
}

/**
 * The company's paperwork, and the questions still open on it.
 *
 * The count in "attached to" is the column worth reading: a document attached
 * to nothing is one somebody uploaded and forgot, and a document attached to
 * four records is the one thing a deletion has to warn about.
 */
export function DocumentsBoard({
  documents,
  questions,
  totalBytes,
  canManage,
}: {
  documents: Document[]
  questions: Question[]
  totalBytes: number
  canManage: boolean
}) {
  const router = useRouter()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [filter, setFilter] = useState('')

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

  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? documents.filter((document) => document.filename.toLowerCase().includes(needle))
    : documents

  const orphans = documents.filter((document) => document.attachedTo === 0).length

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Documents</h2>
        <p className="text-sm text-muted">
          {documents.length} {documents.length === 1 ? 'file' : 'files'},{' '}
          {formatBytes(totalBytes)}.{' '}
          <span className="text-faint">
            Stored once each — the same file attached to three records is one file, and deleting
            it removes it from all three.
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

      <Card
        title="Open questions"
        subtitle="Asked by somebody working on these books, and not yet answered."
      >
        {questions.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            Nothing outstanding. A question is a note somebody marked as one — it stays here until
            it is answered rather than scrolling out of a comment thread.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {questions.map((question) => (
              <li key={question.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{question.body}</p>
                  <p className="text-xs text-muted">
                    {question.authorName} · {question.createdAt} · on a{' '}
                    {(EVIDENCE_SUBJECT_LABELS[question.subjectType] ?? question.subjectType)
                      .toLowerCase()}
                    {EVIDENCE_SUBJECT_PATHS[question.subjectType] && (
                      <>
                        {' · '}
                        <Link
                          href={EVIDENCE_SUBJECT_PATHS[question.subjectType] as string}
                          className="text-brand hover:underline"
                        >
                          go there
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                {canManage && (
                  <button
                    className="btn btn-ghost text-xs"
                    disabled={pending}
                    onClick={() => act(() => resolveNoteAction(question.id))}
                  >
                    Mark answered
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Everything attached"
        subtitle={
          orphans > 0
            ? `${orphans} of these are attached to nothing — uploaded and then forgotten.`
            : 'Every file here hangs on at least one record.'
        }
      >
        <div className="border-b border-line px-4 py-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by filename"
            className="field py-1.5 text-sm"
          />
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            {documents.length === 0
              ? 'Nothing yet. Attach a supplier invoice to a bill, or a statement to a reconciliation, and it appears here.'
              : 'No file matches that.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">File</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">Attached to</th>
                <th className="px-4 py-2 font-medium">Added</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((document) => (
                <tr key={document.id} className="border-t border-line">
                  <td className="px-4 py-1.5">
                    <a
                      href={`/api/documents/${document.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand hover:underline"
                    >
                      {document.filename}
                    </a>
                    {document.note && (
                      <span className="block text-xs text-faint">{document.note}</span>
                    )}
                  </td>
                  <td className="tnum px-4 py-1.5 text-right text-muted">
                    {formatBytes(document.sizeBytes)}
                  </td>
                  <td
                    className={`tnum px-4 py-1.5 text-right ${
                      document.attachedTo === 0 ? 'text-warning' : 'text-muted'
                    }`}
                  >
                    {document.attachedTo === 0 ? 'nothing' : document.attachedTo}
                  </td>
                  <td className="px-4 py-1.5 text-muted">
                    {document.createdAt}
                    {document.uploadedByName && (
                      <span className="block text-xs text-faint">{document.uploadedByName}</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {canManage && (
                      <button
                        className="btn btn-ghost text-xs text-danger"
                        disabled={pending}
                        onClick={() => act(() => deleteDocumentAction(document.id))}
                        title={
                          document.attachedTo > 0
                            ? `Removes it from ${document.attachedTo} record${
                                document.attachedTo === 1 ? '' : 's'
                              }.`
                            : 'Nothing points at this.'
                        }
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
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
