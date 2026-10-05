/**
 * Which accounts need attention, and why (spec §11, §10).
 *
 * ## What this is, and what it deliberately is not
 *
 * §11's Strategic Account Assistant is asked to *"summarize relationship
 * history, identify neglected high-value prospects, recommend next actions, and
 * draft personalized outreach."* Four verbs, and only three of them want a
 * model.
 *
 * **Identifying** a neglected high-value account is a measurement. It is
 * `max(occurred_at)` against a cadence, a sum of invoices, and a weighted
 * pipeline — arithmetic a database does exactly and a language model
 * approximates. Handing it to a model would make the one part of this
 * capability that can be *checked* into the part that cannot, and would put it
 * behind a module §11 itself says the core product must work without.
 *
 * So this file is pure: no database, no clock, no gateway. `asOf` is a
 * parameter because a function that reads the clock cannot be asked what the
 * list looked like last Tuesday, and because a test that has to wait is a test
 * nobody runs.
 *
 * The assistant in `modules/ai/accounts.ts` reads what this computes. It
 * summarizes, recommends and drafts — and when the AI module is off, the list
 * is still there.
 *
 * ## The rule that shaped the registry
 *
 * **A ground that fires on every row is not a finding.** A `lead` nobody has
 * phoned is not neglected; that is what a lead *is*. Flag every one and the
 * list becomes the organization table with extra steps, which is how an
 * attention list teaches people to stop opening it.
 *
 * So every ground declares the accounts it applies to, and the scope is part of
 * the argument rather than a filter bolted on afterwards.
 */

/** Spec §6's lifecycle stages, as the enum stores them. */
export type LifecycleStage =
  | 'lead'
  | 'prospect'
  | 'active_client'
  | 'former_client'
  | 'vendor'
  | 'strategic_target'

/**
 * How long is too long, per lifecycle stage, in days.
 *
 * Declared rather than configurable, for now, and stated here so that the one
 * number a reader will want to argue with is in one place with its reason
 * attached.
 *
 * The shape of the argument is that cadence follows what silence costs:
 *
 * - An **active client** is paying. A month of silence is how a renewal gets
 *   lost to somebody who did call.
 * - A **prospect** has shown interest, and interest decays. Six weeks is about
 *   the point where a warm conversation has to be restarted rather than
 *   continued.
 * - A **strategic target** is a named account somebody decided to pursue
 *   (§10). Deciding to pursue an account and then not contacting it for a
 *   quarter is the specific failure §11 asks to surface.
 * - A **former client** is the cheapest revenue in the business and the easiest
 *   to forget, so twice a year rather than never.
 * - A **lead** has no cadence at all. It has not asked for anything, nobody has
 *   committed to it, and a cadence here would flag the whole top of the funnel.
 * - A **vendor** is somebody we buy from. Silence is not a sales problem.
 */
export const CONTACT_CADENCE_DAYS: Readonly<Record<LifecycleStage, number | null>> = {
  active_client: 30,
  prospect: 42,
  strategic_target: 90,
  former_client: 180,
  lead: null,
  vendor: null,
}

/**
 * A strategic account's cadence, whatever stage it sits in.
 *
 * `is_strategic_account` is a separate column from the lifecycle stage
 * precisely because an existing client can also be strategic, and the schema
 * says so. A strategic active client is the account most expensive to lose, so
 * it gets the tightest cadence in the file rather than its stage's.
 */
export const STRATEGIC_CADENCE_DAYS = 21

/** Days of silence before this account counts as having gone quiet, or null. */
export function cadenceFor(facts: Pick<AccountFacts, 'lifecycleStage' | 'isStrategicAccount'>) {
  const byStage = CONTACT_CADENCE_DAYS[facts.lifecycleStage]

  if (!facts.isStrategicAccount) return byStage

  /*
    A strategic vendor is still a vendor. Marking a supplier strategic is a
    statement about the supply, not a commitment to court them, so the override
    tightens an existing cadence and never invents one.
  */
  if (byStage === null) return null

  return Math.min(byStage, STRATEGIC_CADENCE_DAYS)
}

/**
 * Everything a ground may read about one account.
 *
 * Every field is a measured figure rather than a judgement, so the grounds
 * below argue from facts a reader can go and check (Phase 141: declare the
 * knowledge, measure the fact).
 */
export type AccountFacts = {
  organizationId: string
  name: string
  lifecycleStage: LifecycleStage
  isStrategicAccount: boolean
  /** Who owns the relationship. Null is itself a finding on a named account. */
  ownerId: string | null
  /**
   * The last exchange in either direction, excluding internal notes.
   *
   * `null` means **never**, which is a different problem from "not recently"
   * and gets its own ground. `communications.lastContactedAt` omits accounts
   * with no exchange for exactly this reason, and it is right to.
   */
  lastContactedAt: Date | null
  /** Invoiced in the functional currency over the window, voids excluded. */
  invoicedCents: number
  /** Open opportunities, weighted by their probability. */
  weightedPipelineCents: number
  openOpportunities: number
  /**
   * The longest-waiting proposal that has been sent and not decided.
   *
   * `viewed` separates two very different silences: a proposal somebody opened
   * and did not answer is a decision being avoided, and one never opened may
   * simply not have arrived.
   */
  oldestUndecidedProposal: { sentAt: Date; viewed: boolean } | null
  /** Open tasks whose due date has passed. */
  overdueTasks: number
}

/**
 * What is at stake on this account, in cents.
 *
 * **The larger of realised and prospective, never the sum.** Adding them
 * double-counts the commonest open opportunity there is — a renewal of the
 * revenue already in the first figure — and a list that ranks a renewing client
 * above a genuinely larger prospect is ranking by bookkeeping accident.
 *
 * `max` makes no claim about whether the pipeline is incremental. It answers
 * the question the ranking actually needs: how much would it cost to get this
 * one wrong.
 */
export function stakeCents(facts: Pick<AccountFacts, 'invoicedCents' | 'weightedPipelineCents'>) {
  return Math.max(facts.invoicedCents, facts.weightedPipelineCents)
}

export type Severity = 'high' | 'medium' | 'low'

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 }

/** The reasons an account can need attention. */
export type AttentionGround =
  | 'never-contacted'
  | 'gone-quiet'
  | 'proposal-unanswered'
  | 'pipeline-unattended'
  | 'unowned'
  | 'overdue-follow-up'

export type GroundDefinition = {
  key: AttentionGround
  /** One line for a list. */
  label: string
  severity: Severity
  /**
   * Which accounts this can fire on, and why those.
   *
   * Stated as prose next to a predicate rather than as a predicate alone,
   * because the scope is the part of a ground most likely to be wrong and the
   * part a reader cannot infer from the code.
   */
  appliesTo: string
  /** Why this is worth somebody's morning. */
  because: string
  /** Whether the ground can fire on this account at all. */
  inScope: (facts: AccountFacts) => boolean
  /**
   * The finding, or null.
   *
   * Returns the sentence a person reads, so a ground that fires without being
   * able to say what it found is not expressible.
   */
  detect: (facts: AccountFacts, asOf: Date) => string | null
}

const DAY_MS = 86_400_000

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

export const ATTENTION_GROUNDS: readonly GroundDefinition[] = [
  {
    key: 'never-contacted',
    label: 'Never contacted',
    severity: 'high',
    appliesTo:
      'An account somebody has committed to — strategic, or already a client, or carrying an ' +
      'open opportunity. Not a lead: a lead nobody has called yet is the ordinary state of a ' +
      'lead, and flagging every one would make this list the organization table with extra steps.',
    because:
      'Deciding an account is worth pursuing and then never speaking to it is the specific ' +
      'failure §11 names, and it is invisible in every other view: the account looks fine in a ' +
      'list sorted by name, the pipeline shows a deal, and nothing anywhere says that no ' +
      'conversation has ever happened. It is also the cheapest thing on this list to fix.',
    inScope: (facts) =>
      facts.isStrategicAccount ||
      facts.lifecycleStage === 'active_client' ||
      facts.lifecycleStage === 'prospect' ||
      facts.openOpportunities > 0,
    detect: (facts) =>
      facts.lastContactedAt === null
        ? 'No exchange has ever been logged against this account.'
        : null,
  },
  {
    key: 'gone-quiet',
    label: 'Gone quiet',
    severity: 'high',
    appliesTo:
      'Any account whose lifecycle stage has a cadence — so not leads and not vendors. A ' +
      'strategic account takes the tighter of its stage cadence and the strategic one, because ' +
      'the two columns say different things and both are true at once.',
    because:
      'The question a sales list is opened to answer, and the one nobody can answer by looking ' +
      'at a timeline per account. Silence is not a state anything records, which is why it has ' +
      'to be computed: no row is ever written saying "nothing happened for seven weeks".',
    inScope: (facts) => cadenceFor(facts) !== null && facts.lastContactedAt !== null,
    detect: (facts, asOf) => {
      const cadence = cadenceFor(facts)
      if (cadence === null || facts.lastContactedAt === null) return null

      const silent = daysBetween(facts.lastContactedAt, asOf)
      if (silent < cadence) return null

      return (
        `${plural(silent, 'day')} since the last exchange, against a ${cadence}-day cadence for ` +
        `${facts.isStrategicAccount && cadence === STRATEGIC_CADENCE_DAYS ? 'a strategic account' : `a ${facts.lifecycleStage.replace('_', ' ')}`}.`
      )
    },
  },
  {
    key: 'proposal-unanswered',
    label: 'Proposal waiting',
    severity: 'high',
    appliesTo:
      'Any account with a proposal sent and not decided. No lifecycle condition: a proposal is ' +
      'an offer somebody made, and whose stage the recipient sits in does not change that it is ' +
      'outstanding.',
    because:
      'A proposal has a shelf life, and the platform already knows when it was sent and whether ' +
      'it was opened — `proposal_views` exists. Two weeks unanswered after being read is a ' +
      'decision being avoided and is worth a phone call; two weeks unanswered and never opened ' +
      'is more likely an email that did not arrive, which is a different call. The finding says ' +
      'which, because the two need different sentences.',
    inScope: (facts) => facts.oldestUndecidedProposal !== null,
    detect: (facts, asOf) => {
      const proposal = facts.oldestUndecidedProposal
      if (!proposal) return null

      const waiting = daysBetween(proposal.sentAt, asOf)
      if (waiting < 14) return null

      return proposal.viewed
        ? `A proposal has been open for ${plural(waiting, 'day')} since it was read, with no decision recorded.`
        : `A proposal sent ${plural(waiting, 'day')} ago has never been opened.`
    },
  },
  {
    key: 'pipeline-unattended',
    label: 'Deal without a conversation',
    severity: 'medium',
    appliesTo:
      'An account with at least one open opportunity and some exchange on record. The ' +
      'never-contacted case is a separate, higher ground, so this one does not restate it.',
    because:
      'An open deal is a claim that something is in progress. Thirty days of silence against ' +
      'that claim means either the deal has quietly died and the pipeline is overstating itself, ' +
      'or it is alive and being neglected. Both are worth knowing and the pipeline view shows ' +
      'neither — a stage is not a date.',
    inScope: (facts) => facts.openOpportunities > 0 && facts.lastContactedAt !== null,
    detect: (facts, asOf) => {
      if (facts.lastContactedAt === null) return null

      const silent = daysBetween(facts.lastContactedAt, asOf)
      if (silent < 30) return null

      return (
        `${plural(facts.openOpportunities, 'open opportunity', 'open opportunities')}, and ` +
        `${plural(silent, 'day')} since anybody spoke to them.`
      )
    },
  },
  {
    key: 'unowned',
    label: 'Nobody owns it',
    severity: 'medium',
    appliesTo:
      'A strategic account, or one with an open opportunity. An unowned lead is a queue; an ' +
      'unowned named account is a decision nobody made.',
    because:
      'Every other ground on this list is addressed to somebody. An account with no owner has ' +
      'nobody for the rest of the list to be addressed to, which makes this the one finding ' +
      'that blocks acting on the others. It is also the only one here that is a fact rather ' +
      'than a duration, so it never goes stale and never resolves itself.',
    inScope: (facts) => facts.isStrategicAccount || facts.openOpportunities > 0,
    detect: (facts) =>
      facts.ownerId === null
        ? 'No owner is set, so no follow-up on this account is anybody’s in particular.'
        : null,
  },
  {
    key: 'overdue-follow-up',
    label: 'Follow-up overdue',
    severity: 'low',
    appliesTo:
      'Any account with an open task past its due date. No lifecycle condition and no cadence: ' +
      'somebody chose a date and the date has passed, so there is nothing left to infer about ' +
      'whether this account was meant to be contacted. It is the one ground on this list whose ' +
      'scope is the finding itself.',
    because:
      'Somebody already decided this needed doing and wrote it down, which makes it the ' +
      'best-evidenced item on the list and the least in need of interpretation. It is `low` ' +
      'severity for that reason and not because it matters least: the task list shows it ' +
      'already, so this ground exists to put it beside the other five rather than to break the ' +
      'news.',
    inScope: (facts) => facts.overdueTasks > 0,
    detect: (facts) =>
      facts.overdueTasks > 0
        ? `${plural(facts.overdueTasks, 'follow-up')} past its due date.`
        : null,
  },
]

export class UnknownGroundError extends Error {
  constructor(key: string) {
    super(
      `No attention ground is declared for "${key}". Registered: ` +
        `${ATTENTION_GROUNDS.map((ground) => ground.key).join(', ')}.`,
    )
    this.name = 'UnknownGroundError'
  }
}

/** The declaration for a ground, or a throw naming what is registered. */
export function groundFor(key: string): GroundDefinition {
  const found = ATTENTION_GROUNDS.find((ground) => ground.key === key)
  if (!found) throw new UnknownGroundError(key)
  return found
}

export type Finding = {
  ground: AttentionGround
  label: string
  severity: Severity
  /** What was found, in a sentence somebody can act on. */
  detail: string
}

export type AccountAttention = {
  organizationId: string
  name: string
  findings: Finding[]
  /** The worst severity among the findings. */
  severity: Severity
  stakeCents: number
  /** Days since the last exchange, or null when there has never been one. */
  silentDays: number | null
}

/** Every ground that fires on one account, worst first. */
export function assessAccount(facts: AccountFacts, asOf: Date): AccountAttention | null {
  const findings: Finding[] = []

  for (const ground of ATTENTION_GROUNDS) {
    if (!ground.inScope(facts)) continue

    const detail = ground.detect(facts, asOf)
    if (detail === null) continue

    findings.push({
      ground: ground.key,
      label: ground.label,
      severity: ground.severity,
      detail,
    })
  }

  if (findings.length === 0) return null

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  return {
    organizationId: facts.organizationId,
    name: facts.name,
    findings,
    severity: findings[0].severity,
    stakeCents: stakeCents(facts),
    silentDays: facts.lastContactedAt === null ? null : daysBetween(facts.lastContactedAt, asOf),
  }
}

/**
 * The accounts needing attention, ranked.
 *
 * Severity first, then stake. Ranking by stake alone would bury a strategic
 * target nobody has ever called under a large client who is merely a week late,
 * and §11 asks for the *neglected* ones — the money is the tie-break, not the
 * question.
 */
export function rankAccounts(
  facts: readonly AccountFacts[],
  asOf: Date,
): AccountAttention[] {
  return facts
    .map((account) => assessAccount(account, asOf))
    .filter((account): account is AccountAttention => account !== null)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.stakeCents - a.stakeCents ||
        a.name.localeCompare(b.name),
    )
}

/**
 * Whether the registry has anything to say about this ground on this account.
 *
 * The device Phase 101 established: each entry argues for itself, and the
 * argument is held to a floor by a test so that a ground added later cannot be
 * a bare key with a predicate.
 */
export function groundStands(ground: GroundDefinition): string[] {
  const problems: string[] = []

  if (ground.because.length < 180) {
    problems.push(`${ground.key} does not argue itself — "because" is ${ground.because.length} characters.`)
  }
  if (ground.appliesTo.length < 100) {
    problems.push(
      `${ground.key} does not say which accounts it applies to, and the scope is the part of a ` +
        'ground most likely to be wrong.',
    )
  }

  return problems
}
