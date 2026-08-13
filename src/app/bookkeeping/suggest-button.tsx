'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  acceptCategorizationAction,
  acceptRuleAction,
  rejectSuggestionAction,
  suggestCategoryAction,
  suggestRuleAction,
  type CategorySuggestionResult,
  type RuleSuggestionResult,
} from '@/app/actions/ai'

/**
 * Ask the assistant about one transaction (spec §11).
 *
 * The whole human-in-the-loop rule, made visible: the suggestion appears with
 * its reasoning and its confidence, and **nothing happens until Accept is
 * pressed**. Accept calls the same categorization service the dropdown does,
 * so the ledger cannot tell the difference and the audit log records the
 * person, not the model.
 *
 * Dismiss is a real action rather than a close button: a rejected suggestion
 * is recorded, and the rejections are the evidence for whether a prompt
 * version is worth keeping.
 */
export function SuggestButton({
  transactionId,
  canManageRules,
}: {
  transactionId: string
  canManageRules: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [suggestion, setSuggestion] = useState<CategorySuggestionResult | null>(null)
  const [rule, setRule] = useState<RuleSuggestionResult | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function askForCategory() {
    setRule(null)
    startTransition(async () => {
      setSuggestion(await suggestCategoryAction(transactionId))
    })
  }

  function askForRule() {
    setSuggestion(null)
    startTransition(async () => {
      setRule(await suggestRuleAction(transactionId))
    })
  }

  if (done) {
    return <p className="text-xs text-positive">{done}</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button onClick={askForCategory} disabled={pending} className="btn text-xs">
          {pending ? 'Thinking…' : 'Suggest a category'}
        </button>
        {canManageRules && (
          <button onClick={askForRule} disabled={pending} className="btn text-xs">
            Suggest a rule
          </button>
        )}
      </div>

      {suggestion && !suggestion.ok && (
        <p role="status" className="text-xs text-muted">
          {suggestion.error}
        </p>
      )}

      {suggestion?.ok && (
        <div className="rounded-lg border border-brand/30 bg-brand/5 p-3">
          <p className="text-sm">
            <span className="font-medium">
              {suggestion.accountNumber} {suggestion.accountName}
            </span>
            <span className="ml-1.5 chip bg-raised text-muted">
              {(suggestion.confidenceBp / 100).toFixed(0)}% sure
            </span>
          </p>
          <p className="mt-1 text-xs text-muted">{suggestion.rationale}</p>

          <div className="mt-2 flex gap-2">
            <button
              onClick={() =>
                startTransition(async () => {
                  const result = await acceptCategorizationAction(suggestion.suggestionId)
                  if (result.ok) {
                    setDone('Categorized.')
                    router.refresh()
                  }
                })
              }
              disabled={pending}
              className="btn btn-primary text-xs"
            >
              Accept
            </button>
            <button
              onClick={() =>
                startTransition(async () => {
                  await rejectSuggestionAction(suggestion.suggestionId)
                  setSuggestion(null)
                })
              }
              disabled={pending}
              className="btn text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {rule && !rule.ok && (
        <p role="status" className="text-xs text-muted">
          {rule.error}
        </p>
      )}

      {rule?.ok && (
        <div className="rounded-lg border border-brand/30 bg-brand/5 p-3">
          <p className="text-sm font-medium">{rule.name}</p>
          <p className="mt-1 text-xs">
            When <span className="font-mono">{rule.field}</span> {rule.operator.replace(/_/g, ' ')}{' '}
            <span className="font-mono">&ldquo;{rule.value}&rdquo;</span> →{' '}
            <span className="font-medium">{rule.accountName}</span>
            {rule.action === 'auto' ? ', automatically' : ', as a suggestion'}
          </p>
          <p className="mt-1 text-xs text-muted">{rule.rationale}</p>

          <div className="mt-2 flex gap-2">
            <button
              onClick={() =>
                startTransition(async () => {
                  const result = await acceptRuleAction(rule.suggestionId)
                  if (result.ok) {
                    setDone(result.message ?? 'Rule created.')
                    router.refresh()
                  }
                })
              }
              disabled={pending}
              className="btn btn-primary text-xs"
            >
              Create the rule
            </button>
            <button
              onClick={() =>
                startTransition(async () => {
                  await rejectSuggestionAction(rule.suggestionId)
                  setRule(null)
                })
              }
              disabled={pending}
              className="btn text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
