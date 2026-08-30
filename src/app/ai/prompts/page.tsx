import { requireActor, requireSession } from '@/lib/current-user'
import { can } from '@/modules/tenancy/context'
import { AppShell, SubNav } from '@/components/app-shell'
import { listPrompts } from '@/modules/ai/prompts'
import { AI_NAV } from '../nav'
import { PromptEditor } from './prompt-editor'

export const dynamic = 'force-dynamic'

/**
 * The prompt registry (spec §12 "versioning, testing, and rollback").
 *
 * Exposed rather than hidden because a prompt is the part of an AI feature a
 * company most often needs to change — house style, the accounts they care
 * about, what their industry calls things — and the part most likely to make
 * things worse. Versions are additive and the built-in is always one click
 * away, so an experiment is reversible.
 */
export default async function PromptsPage() {
  const actor = await requireActor()
  const session = await requireSession()

  if (!can(actor, 'ai:manage')) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold">Prompts</h1>
        <p className="mt-2 text-sm text-muted">
          Your role ({actor.role}) does not include managing the AI module.
        </p>
      </main>
    )
  }

  const prompts = await listPrompts(actor)

  return (
    <AppShell
      actor={actor}
      companyName={session.companyName}
      active="ai"
    >
      <SubNav items={AI_NAV} active="/ai/prompts" />

      <p className="mb-4 text-sm text-muted">
        Every request records which prompt version answered it, so a change here is traceable in
        the usage ledger. Saving never overwrites — it adds a version and activates it, and the
        built-in is always available to fall back to.
      </p>

      <div className="space-y-3">
        {prompts.map((prompt) => (
          <PromptEditor
            key={prompt.key}
            promptKey={prompt.key}
            builtIn={{
              version: prompt.builtIn.version,
              systemPrompt: prompt.builtIn.systemPrompt,
              template: prompt.builtIn.template,
              notes: prompt.builtIn.notes,
            }}
            versions={prompt.versions.map((version) => ({
              version: version.version,
              notes: version.notes,
              isActive: version.isActive,
              createdAt: version.createdAt?.toISOString().slice(0, 10) ?? '',
            }))}
            activeVersion={prompt.activeVersion}
            activeSource={prompt.activeSource}
          />
        ))}
      </div>
    </AppShell>
  )
}
