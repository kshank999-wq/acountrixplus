import { requireActor, currentSession } from '@/lib/current-user'
import {
  engagementsForPractice,
  listPracticeMembers,
  practicesFor,
} from '@/modules/practice/service'
import { practiceWorkQueue } from '@/modules/practice/switching'
import { practiceNotifications, preferencesFor } from '@/modules/mobile/notifications'
import { explain, isSilence, type Channel, type Outcome } from '@/modules/mobile/decision'
import { PracticeBoard } from './board'
import { NewPracticeForm } from './new-practice'

export const dynamic = 'force-dynamic'

/**
 * The practice workspace (spec §14).
 *
 * Deliberately outside `AppShell`: the shell is chrome for *a company's*
 * books, with its workspace tabs and its company name in the corner. This page
 * is about the person rather than any one company, and dressing it in one
 * company's chrome would imply the client list belonged to whichever books
 * happened to be open.
 */
export default async function PracticePage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string }>
}) {
  const actor = await requireActor()
  const session = await currentSession()
  const params = await searchParams

  const practices = await practicesFor(actor.userId)

  if (practices.length === 0) {
    return (
      <Frame userName={actor.userName} companyName={session?.companyName ?? null}>
        <NewPracticeForm />
      </Frame>
    )
  }

  const practice =
    practices.find((entry) => entry.practiceId === params.p) ?? practices[0]

  const [queue, engagements, members, briefTopics, briefLog] = await Promise.all([
    practiceWorkQueue(actor.userId, practice.practiceId),
    engagementsForPractice(practice.practiceId, actor.userId),
    listPracticeMembers(practice.practiceId, actor.userId),
    preferencesFor({ kind: 'practice', practiceId: practice.practiceId }, actor.userId),
    // Safe without a further permission check: `practicesFor` above already
    // proved this person is a member of this firm, and the reader is scoped to
    // their own rows within it.
    practiceNotifications(practice.practiceId, actor.userId),
  ])

  return (
    <Frame userName={actor.userName} companyName={session?.companyName ?? null}>
      <PracticeBoard
        practice={practice}
        practices={practices}
        queue={queue.map((item) => ({
          companyId: item.companyId,
          companyName: item.companyName,
          role: item.role,
          awaitingReview: item.awaitingReview,
          oldestAwaiting: item.oldestAwaiting,
          triage: {
            rung: item.triage.rung,
            headline: item.triage.headline,
            others: item.triage.others,
          },
        }))}
        engagements={engagements.map((engagement) => ({
          id: engagement.id,
          companyName: engagement.companyName,
          status: engagement.status,
          initiatedBy: engagement.initiatedBy,
          grantedRole: engagement.grantedRole,
          staffing: engagement.staffing,
          note: engagement.note,
          requestedAt: engagement.requestedAt.toISOString().slice(0, 10),
        }))}
        members={members.map((member) => ({
          userId: member.userId,
          name: member.name,
          email: member.email,
          practiceRole: member.practiceRole,
          isActive: member.isActive,
        }))}
        isOwner={practice.practiceRole === 'owner'}
        selfUserId={actor.userId}
        briefEnabled={
          briefTopics.find((topic) => topic.topic === 'practice_brief')?.enabled ?? true
        }
        briefHistory={briefLog.map((row) => ({
          id: row.id,
          on: row.createdAt.toISOString().slice(0, 10),
          title: row.title,
          // Worded once, on the server, by the core that owns the vocabulary.
          explanation: explain({
            channel: row.channel as Channel,
            outcome: row.outcome as Outcome,
            detail: row.detail,
          }),
          silent: isSilence(row.outcome as Outcome),
          // Phase 91. Null for a suppression, which composed no letter, and for
          // one swept by retention — both still read as "we told you", with
          // nothing left to open.
          letter: row.letter,
        }))}
      />
    </Frame>
  )
}

function Frame({
  userName,
  companyName,
  children,
}: {
  userName: string
  companyName: string | null
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface/90">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div>
            <h1 className="text-base font-semibold tracking-tight">Practice</h1>
            <p className="text-xs text-muted">{userName}</p>
          </div>
          {companyName && (
            <a href="/bookkeeping" className="btn text-xs">
              Back to {companyName}
            </a>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
