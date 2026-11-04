/**
 * §7's twelve proposal components, and how each one reaches the page
 * (Phase 182).
 *
 * ## Why this register exists
 *
 * ADR 0173 measured that *"10 of the 12 components §7 names have a dedicated
 * block or column; these two have neither."* That was correct and it was
 * generous, because "has a column" and "reaches the client" are different
 * claims and the audit checked the first one.
 *
 * `proposals` carried `executive_summary`, `scope`, `exclusions` and `terms`.
 * All four were written by `createProposal`, written by the AI draft, and
 * snapshotted into `proposal_versions` so a sent proposal's wording freezes
 * with its figures. **None of the four was rendered anywhere** — not the
 * client-facing page, not the PDF, not the email, and there was no merge field
 * for any of them.
 *
 * The templates made it look handled: a `heading` and a `text` block with the
 * ids `scope` and `exclusions`, filled with placeholder prose telling the author
 * to describe their scope. So the author typed it into the form, opened the
 * designer, and typed it again — the column keeping the first copy and the
 * client reading the second.
 *
 * Phase 49's rule at scale: a column with no reader is a field that does not
 * exist. So the fix was not two more columns of the same kind; it was six merge
 * fields, and a register that makes "this component has a home" mean "a client
 * can read it".
 *
 * ## What an entry has to say
 *
 * Three things, and the third is the one the audit could not check: where the
 * content is **stored**, how it **reaches a rendered document**, and what a
 * reader loses if it does not. A component whose `reaches` is `'nothing'` is a
 * field somebody fills in that nobody sees.
 */

import { RegistryError } from '@/modules/errors/registry'

/** How a component's content gets onto the document the client reads. */
export type ComponentReach =
  /**
   * A merge field the author places in a block — `{{proposal.scope}}`.
   *
   * The engine's own mechanism for putting record data into a document, and
   * what the four orphaned narrative columns needed all along.
   */
  | 'merge-field'
  /**
   * A block type the author adds, holding its own content.
   *
   * `cover`, `table`, `clause`, `signature`. The block *is* the component.
   */
  | 'block'
  /**
   * A block type that renders data the caller supplies rather than its own.
   *
   * `pricingTable` holds no figures on purpose, so the page can never disagree
   * with the proposal's totals.
   */
  | 'block-from-data'
  /** Its own table, rendered by a screen rather than by the design engine. */
  | 'table'

export type ProposalComponent = {
  /** §7's own word for it, so the list can be checked against the bullet. */
  key: string
  label: string
  /** Where the content lives. A table name, a column, or the block's type. */
  storedIn: string
  reaches: ComponentReach
  /**
   * The merge field, for the six that are narrative columns.
   *
   * Required when `reaches` is `merge-field` and absent otherwise, which is
   * what a test asserts — because a narrative column with no merge field is
   * precisely the four this register was written for.
   */
  mergeField: string | null
  because: string
}

export const PROPOSAL_COMPONENTS: readonly ProposalComponent[] = [
  {
    key: 'cover',
    label: 'Cover',
    storedIn: 'cover block',
    reaches: 'block',
    mergeField: null,
    because:
      'A title page is layout rather than content, so the block holds its own title and subtitle ' +
      'and takes the client name from a merge field. The one component where the block being the ' +
      'component is obviously right: there is nothing about a cover to store on the proposal.',
  },
  {
    key: 'executive summary',
    label: 'Executive summary',
    storedIn: 'proposals.executive_summary',
    reaches: 'merge-field',
    mergeField: 'proposal.executiveSummary',
    because:
      'Written by hand or by the AI draft, which has produced one since Phase 6 — and until Phase ' +
      '182 there was no way to get it onto the page, so the assistant generated a summary into a ' +
      'column no document read. The most expensive of the four orphans, because something was ' +
      'actively producing content for it.',
  },
  {
    key: 'scope',
    label: 'Scope of work',
    storedIn: 'proposals.scope',
    reaches: 'merge-field',
    mergeField: 'proposal.scope',
    because:
      'The section a dispute is settled by reading. The template placed a block telling the author ' +
      'to *"describe what is included, in the order the work will happen"* while the column held ' +
      'what they had already described, so the two could disagree and the client only ever saw ' +
      'the block.',
  },
  {
    key: 'deliverables',
    label: 'Deliverables',
    storedIn: 'proposals.deliverables',
    reaches: 'merge-field',
    mergeField: 'proposal.deliverables',
    because:
      'What the client receives, as distinct from the work done to produce it — the distinction ' +
      'that decides whether a job is finished. Added in Phase 182; it had no column and no block, ' +
      'and would have been typed into a `text` block where nothing could version it with the ' +
      'figures it was priced against.',
  },
  {
    key: 'schedule',
    label: 'Schedule',
    storedIn: 'proposal_schedule_stages',
    reaches: 'table',
    mergeField: null,
    because:
      'Its own table since Phase 154, because a schedule is *stages with amounts* that invoices ' +
      'are raised against — not prose. It reaches the client through its own screen rather than ' +
      'the design engine, which is the right answer for the one component that is also a billing ' +
      'instruction.',
  },
  {
    key: 'exclusions',
    label: 'What is not included',
    storedIn: 'proposals.exclusions',
    reaches: 'merge-field',
    mergeField: 'proposal.exclusions',
    because:
      'The second section a dispute is settled by reading, and the one most likely to be omitted ' +
      'in a hurry. Same orphaning as scope, with the same template block filled with the same ' +
      'kind of placeholder — and an exclusions list the client never saw is the single most ' +
      'expensive missing paragraph in a proposal.',
  },
  {
    key: 'assumptions',
    label: 'Assumptions',
    storedIn: 'proposals.assumptions',
    reaches: 'merge-field',
    mergeField: 'proposal.assumptions',
    because:
      'What the price assumes to be true — site access, existing conditions, decisions made by a ' +
      'date. Distinct from exclusions: an exclusion is work not being done, an assumption is work ' +
      'priced on a condition that may turn out false, and the remedy for each is different. Added ' +
      'in Phase 182 alongside deliverables.',
  },
  {
    key: 'fee table',
    label: 'Fee table',
    storedIn: 'proposal_items',
    reaches: 'block-from-data',
    mergeField: null,
    because:
      'The `pricingTable` block holds no figures of its own, deliberately: its own comment says ' +
      'the point is that *"the figures on the page can never drift from the proposal\'s actual ' +
      'totals."* The one component where a column would be wrong, because two copies of a total ' +
      'is how a client is sent the wrong number.',
  },
  {
    key: 'optional items',
    label: 'Optional items',
    storedIn: 'proposal_items.is_optional',
    reaches: 'block-from-data',
    mergeField: null,
    because:
      'A flag on the line rather than a section, so the same `pricingTable` renders both and the ' +
      'client-facing page can let somebody tick them — which `allowOptionalSelection` does. A ' +
      'separate "optional items" section would have needed its own totals and its own chance to ' +
      'disagree with them.',
  },
  {
    key: 'terms',
    label: 'Terms',
    storedIn: 'proposals.terms',
    reaches: 'merge-field',
    mergeField: 'proposal.terms',
    because:
      'The commercial terms of this proposal, as opposed to the standard legal language below. ' +
      'The fourth orphan, and the one whose absence from the page is hardest to notice, because a ' +
      'proposal with approved clauses and no terms looks complete.',
  },
  {
    key: 'legal clauses',
    label: 'Legal clauses',
    storedIn: 'clause_versions',
    reaches: 'block',
    mergeField: null,
    because:
      'A `clause` block storing the **version** id rather than the clause id, so what a client was ' +
      'shown does not change when the company later revises its standard terms. Not a column, ' +
      'because the content belongs to the library and a proposal only points at it.',
  },
  {
    key: 'signature/acceptance',
    label: 'Signature',
    storedIn: 'proposal_acceptances',
    reaches: 'block',
    mergeField: null,
    because:
      'A `signature` block places the prompt and the wording; the acceptance itself is a row ' +
      'written by the client-facing page, which is the only component whose content the company ' +
      'does not author. Two halves on purpose — the block is in the document, the acceptance is ' +
      'evidence about it.',
  },
]

export function proposalComponentFor(key: string): ProposalComponent {
  const found = PROPOSAL_COMPONENTS.find((component) => component.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'PROPOSAL_COMPONENTS',
    key,
    message:
      `No proposal component is declared as "${key}". This register is §7's twelve, each saying ` +
      'how its content reaches the document a client reads — so a lookup answering `undefined` ' +
      'would report a component as homed when nothing renders it, which is the defect the ' +
      `register was written for. Declared: ${PROPOSAL_COMPONENTS.map((c) => c.key).join(', ')}.`,
  })
}

/** The six narrative sections, in §7's order. For a form and for a template. */
export function narrativeComponents(): ProposalComponent[] {
  return PROPOSAL_COMPONENTS.filter((component) => component.reaches === 'merge-field')
}

export function proposalComponentStands(component: ProposalComponent): string[] {
  const problems: string[] = []

  if (component.because.length < 230) {
    problems.push(
      `${component.key} does not argue itself. The argument here is why its content lives where ` +
        'it does, because four of these had a column and no reader for a hundred and seventy-odd ' +
        'phases and "it has a column" was what made that look finished.',
    )
  }

  /*
    The check that would have caught the four orphans. A narrative column
    reaches the page through a merge field and through nothing else, so an
    entry claiming `merge-field` with no field named is a column nobody can
    render — and an entry naming a field while reaching the page another way is
    two mechanisms for one component.
  */
  if (component.reaches === 'merge-field' && !component.mergeField) {
    problems.push(
      `${component.key} is stored in a column and names no merge field, so nothing can put it on ` +
        'the page. This is exactly the state `executive_summary`, `scope`, `exclusions` and ' +
        '`terms` were in until Phase 182.',
    )
  }

  if (component.reaches !== 'merge-field' && component.mergeField) {
    problems.push(
      `${component.key} reaches the page as a ${component.reaches} and also names a merge field, ` +
        'which is two mechanisms for one component and two places for it to disagree with itself.',
    )
  }

  return problems
}

/**
 * The column a narrative component lives in, as the code names it.
 *
 * `proposals.executive_summary` becomes `executiveSummary`. Derived rather than
 * stored, so a register entry cannot name a column and a field that disagree —
 * and the form, the action and the version snapshot all read the same six names
 * from the same place.
 */
export function narrativeColumn(component: ProposalComponent): string {
  return component.storedIn
    .replace('proposals.', '')
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
