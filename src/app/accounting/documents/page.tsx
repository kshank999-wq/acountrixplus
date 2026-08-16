import { requireActor, currentSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listDocuments } from '@/modules/evidence/service'
import { openQuestions } from '@/modules/evidence/notes'
import { ACCOUNTING_NAV } from '../nav'
import { DocumentsBoard } from './board'

export const dynamic = 'force-dynamic'

/**
 * Everything this company has attached, and every question nobody has answered
 * (spec §13 "audit trail, accountant notes, attachments, exports").
 *
 * Two lists on one page because they are the two halves of the same year-end
 * conversation: what we have paperwork for, and what we are still waiting to
 * be told. The open questions come first — a document list is a reference, and
 * an unanswered question is work.
 */
export default async function DocumentsPage() {
  const actor = await requireActor()
  const session = await currentSession()

  if (!can(actor, 'accounting:view')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Documents</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include access to the accounting workspace.
        </p>
      </main>
    )
  }

  const [documents, questions] = await Promise.all([
    listDocuments(actor),
    openQuestions(actor),
  ])

  const totalBytes = documents.reduce((sum, document) => sum + document.sizeBytes, 0)

  return (
    <AppShell
      actor={actor}
      companyName={session?.companyName ?? 'Accountrix Plus'}
      active="accounting"
    >
      <SubNav items={ACCOUNTING_NAV} active="/accounting/documents" />
      <DocumentsBoard
        documents={documents.map((document) => ({
          id: document.id,
          filename: document.filename,
          contentType: document.contentType,
          sizeBytes: document.sizeBytes,
          note: document.note,
          uploadedByName: document.uploadedByName,
          createdAt: document.createdAt.toISOString().slice(0, 10),
          attachedTo: document.attachedTo,
        }))}
        questions={questions.map((question) => ({
          id: question.id,
          body: question.body,
          authorName: question.authorName,
          createdAt: question.createdAt.toISOString().slice(0, 10),
          subjectType: question.subjectType,
          subjectId: question.subjectId,
        }))}
        totalBytes={totalBytes}
        canManage={can(actor, 'accounting:journal')}
      />
    </AppShell>
  )
}
