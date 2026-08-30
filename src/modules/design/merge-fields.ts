import { formatCents } from '@/lib/money'
import {
  addressLines,
  type Letterhead,
  type LetterheadProfile,
} from '@/modules/brand/letterhead'
import type { Block } from './blocks'

/**
 * Dynamic merge fields (spec §7).
 *
 * Written as `{{company.name}}` in any text a user types. Resolution is a pure
 * function over a flat context, so it can be tested directly and reused by
 * both the proposal renderer and Phase 5's marketing templates.
 */

export type MergeContext = Record<string, string>

/** Every field the editor offers, grouped for the insert menu. */
export const MERGE_FIELD_GROUPS: Array<{
  group: string
  fields: Array<{ key: string; label: string }>
}> = [
  {
    group: 'Your company',
    fields: [
      { key: 'company.name', label: 'Company name' },
      { key: 'company.legalName', label: 'Legal name' },
      { key: 'company.tradingName', label: 'Trading as' },
      { key: 'company.email', label: 'Email' },
      { key: 'company.phone', label: 'Phone' },
      { key: 'company.website', label: 'Website' },
      { key: 'company.address', label: 'Address' },
      { key: 'company.paymentInstructions', label: 'Payment instructions' },
      { key: 'company.footer', label: 'Document footer' },
    ],
  },
  {
    group: 'Client',
    fields: [
      { key: 'client.name', label: 'Client name' },
      { key: 'client.contactName', label: 'Contact name' },
      { key: 'client.email', label: 'Contact email' },
      { key: 'client.address', label: 'Client address' },
    ],
  },
  {
    group: 'Proposal',
    fields: [
      { key: 'proposal.number', label: 'Proposal number' },
      { key: 'proposal.title', label: 'Title' },
      { key: 'proposal.total', label: 'Total' },
      { key: 'proposal.subtotal', label: 'Subtotal' },
      { key: 'proposal.date', label: 'Date' },
      { key: 'proposal.expiresOn', label: 'Valid through' },
    ],
  },
  {
    group: 'Project',
    fields: [
      { key: 'project.code', label: 'Job code' },
      { key: 'project.name', label: 'Job name' },
    ],
  },
]

export const KNOWN_MERGE_FIELDS: string[] = MERGE_FIELD_GROUPS.flatMap((group) =>
  group.fields.map((field) => field.key),
)

/** Matches `{{ field.path }}`, tolerating whitespace inside the braces. */
const FIELD_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

/**
 * Substitutes merge fields in a string.
 *
 * An unresolved field renders as an empty string rather than leaving
 * `{{client.name}}` visible on a page a client will read. The editor surfaces
 * unresolved fields separately through `findUnresolvedFields`, so the author
 * finds out before sending rather than the client finding out after.
 */
export function resolveMergeFields(text: string, context: MergeContext): string {
  if (!text) return ''
  return text.replace(FIELD_PATTERN, (_match, key: string) => context[key] ?? '')
}

/** Merge fields present in the text that the context cannot fill. */
export function findUnresolvedFields(text: string, context: MergeContext): string[] {
  if (!text) return []

  const unresolved = new Set<string>()
  for (const match of text.matchAll(FIELD_PATTERN)) {
    const key = match[1]
    if (!context[key]) unresolved.add(key)
  }
  return [...unresolved]
}

/**
 * Applies merge fields across every text-bearing field of a block.
 *
 * Returns a new block; the stored document keeps the field syntax so it stays
 * reusable as a template.
 */
export function resolveBlock(block: Block, context: MergeContext): Block {
  const fill = (value: string) => resolveMergeFields(value, context)

  switch (block.type) {
    case 'cover':
      return {
        ...block,
        title: fill(block.title),
        subtitle: fill(block.subtitle),
        preparedFor: fill(block.preparedFor),
      }
    case 'heading':
      return { ...block, text: fill(block.text) }
    case 'text':
      return { ...block, text: fill(block.text) }
    case 'list':
      return { ...block, items: block.items.map(fill) }
    case 'keyValue':
      return {
        ...block,
        title: fill(block.title),
        rows: block.rows.map((row) => ({ label: fill(row.label), value: fill(row.value) })),
      }
    case 'columns':
      return {
        ...block,
        columns: block.columns.map((column) => ({
          heading: fill(column.heading),
          body: fill(column.body),
        })),
      }
    case 'clause':
      return { ...block, title: fill(block.title), body: fill(block.body) }
    case 'pricingTable':
      return { ...block, title: fill(block.title) }
    case 'image':
      return { ...block, caption: fill(block.caption) }
    case 'signature':
      return { ...block, prompt: fill(block.prompt), agreementText: fill(block.agreementText) }
    case 'button':
      return { ...block, label: fill(block.label), url: fill(block.url) }
    case 'qrCode':
      return { ...block, value: fill(block.value), caption: fill(block.caption) }
    case 'video':
      return { ...block, url: fill(block.url), caption: fill(block.caption) }
    default:
      return block
  }
}

export function resolveBlocks(blocks: Block[], context: MergeContext): Block[] {
  return blocks.map((block) => resolveBlock(block, context))
}

/** Every unresolved field across a document, for the pre-send check. */
export function unresolvedInBlocks(blocks: Block[], context: MergeContext): string[] {
  const unresolved = new Set<string>()

  for (const block of blocks) {
    for (const text of textsOf(block)) {
      for (const field of findUnresolvedFields(text, context)) unresolved.add(field)
    }
  }

  return [...unresolved].sort()
}

/** Every user-authored string in a block. */
function textsOf(block: Block): string[] {
  switch (block.type) {
    case 'cover':
      return [block.title, block.subtitle, block.preparedFor]
    case 'heading':
    case 'text':
      return [block.text]
    case 'list':
      return block.items
    case 'keyValue':
      return [block.title, ...block.rows.flatMap((row) => [row.label, row.value])]
    case 'columns':
      return block.columns.flatMap((column) => [column.heading, column.body])
    case 'clause':
      return [block.title, block.body]
    case 'pricingTable':
      return [block.title]
    case 'image':
      return [block.caption]
    case 'signature':
      return [block.prompt, block.agreementText]
    case 'button':
      return [block.label, block.url]
    case 'qrCode':
      return [block.value, block.caption]
    case 'video':
      return [block.url, block.caption]
    default:
      return []
  }
}

export type MergeSources = {
  /**
   * The letterhead, since Phase 76 — not a hand-picked set of profile columns.
   * Everything the designer can insert about the company now comes from the
   * same object the invoice prints its masthead from.
   */
  company?: (Letterhead & { paymentInstructions?: string | null }) | null
  /**
   * A client's address is a postal address like anybody else's, so it takes
   * the same fields the letterhead does — including the second line and the
   * country, which the formatter this replaced dropped on the floor.
   */
  client?:
    | (Pick<
        LetterheadProfile,
        'addressLine1' | 'addressLine2' | 'city' | 'region' | 'postalCode' | 'country'
      > & {
        name?: string | null
        contactName?: string | null
        email?: string | null
      })
    | null
  proposal?: {
    number?: string | null
    title?: string | null
    totalCents?: number | null
    subtotalCents?: number | null
    issuedOn?: string | null
    expiresOn?: string | null
  } | null
  project?: { code?: string | null; name?: string | null } | null
}

/**
 * Builds the flat context the resolver reads.
 *
 * Absent values become empty strings here rather than at substitution time, so
 * `findUnresolvedFields` can distinguish "no such field" from "field is
 * genuinely blank" — both render as nothing, but only the first is worth
 * warning an author about.
 */
export function buildMergeContext(sources: MergeSources): MergeContext {
  const context: MergeContext = {}
  const set = (key: string, value: string | null | undefined) => {
    if (value) context[key] = value
  }

  const { company, client, proposal, project } = sources

  // `company.name` is the letterhead's name, which is the registered one where
  // there is one — the same string the invoice heads itself with. `legalName`
  // was `?? company.name` before, which made the two keys indistinguishable.
  set('company.name', company?.name)
  set('company.legalName', company?.name)
  set('company.tradingName', company?.tradingName)
  set('company.email', company?.email)
  set('company.phone', company?.phone)
  set('company.website', company?.website)
  set('company.address', company ? company.address.join('\n') : null)
  set('company.paymentInstructions', company?.paymentInstructions)
  set('company.footer', company?.footer)

  set('client.name', client?.name)
  set('client.contactName', client?.contactName)
  set('client.email', client?.email)
  set('client.address', addressLines(client).join('\n') || null)

  set('proposal.number', proposal?.number)
  set('proposal.title', proposal?.title)
  if (proposal?.totalCents !== null && proposal?.totalCents !== undefined) {
    set('proposal.total', formatCents(proposal.totalCents))
  }
  if (proposal?.subtotalCents !== null && proposal?.subtotalCents !== undefined) {
    set('proposal.subtotal', formatCents(proposal.subtotalCents))
  }
  set('proposal.date', proposal?.issuedOn)
  set('proposal.expiresOn', proposal?.expiresOn)

  set('project.code', project?.code)
  set('project.name', project?.name)

  return context
}
