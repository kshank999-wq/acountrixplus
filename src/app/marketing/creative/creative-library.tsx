'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createCreativeAction, duplicateCreativeAction } from '@/app/actions/marketing'

type Document = {
  id: string
  name: string
  blockCount: number
  updatedAt: string | null
}

/** The creative library (spec §8). */
export function CreativeLibrary({
  documents,
  templates,
  canManage,
}: {
  documents: Document[]
  templates: Array<{ key: string; name: string; description: string; source: string }>
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [templateKey, setTemplateKey] = useState('')

  function create() {
    setError(null)

    startTransition(async () => {
      const result = await createCreativeAction(name, templateKey)
      if (result.ok && result.documentId) {
        router.push(`/marketing/creative/${result.documentId}`)
      } else if (!result.ok) {
        setError(result.error)
      }
    })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <section className="card overflow-hidden">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Creative</h2>
          <p className="text-xs text-muted">
            Designed once, rendered as email and as a web page.
          </p>
        </header>

        {documents.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            Nothing here yet. Start one on the right.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((document) => (
              <li key={document.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/marketing/creative/${document.id}`}
                    className="text-sm font-medium text-action hover:underline"
                  >
                    {document.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    {document.blockCount} block{document.blockCount === 1 ? '' : 's'}
                    {document.updatedAt && ` · edited ${document.updatedAt.slice(0, 10)}`}
                  </p>
                </div>

                {canManage && (
                  <button
                    onClick={() =>
                      startTransition(async () => {
                        const result = await duplicateCreativeAction(document.id)
                        if (result.ok && result.documentId) {
                          router.push(`/marketing/creative/${result.documentId}`)
                        } else if (!result.ok) {
                          setError(result.error)
                        }
                      })
                    }
                    disabled={pending}
                    className="btn shrink-0 text-xs"
                  >
                    Duplicate
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <section className="card h-fit p-4">
          <h2 className="text-sm font-semibold">New creative</h2>

          <label className="mt-3 block">
            <span className="text-xs text-muted">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Year-end newsletter"
              className="field mt-0.5"
            />
          </label>

          <label className="mt-3 block">
            <span className="text-xs text-muted">Start from</span>
            <select
              value={templateKey}
              onChange={(event) => setTemplateKey(event.target.value)}
              className="field mt-0.5"
            >
              <option value="">A blank document</option>
              {templates.map((template) => (
                <option key={`${template.source}-${template.key}`} value={template.key}>
                  {template.name}
                  {template.source === 'company' ? ' (yours)' : ''}
                </option>
              ))}
            </select>
            <span className="mt-0.5 block text-xs text-faint">
              Proposal templates work here too — strip out what does not apply.
            </span>
          </label>

          {error && (
            <p role="alert" className="mt-2 text-xs text-negative">
              {error}
            </p>
          )}

          <button
            onClick={create}
            disabled={pending || !name.trim()}
            className="btn btn-primary mt-3 w-full text-xs"
          >
            {pending ? 'Creating…' : 'Create'}
          </button>
        </section>
      )}
    </div>
  )
}
