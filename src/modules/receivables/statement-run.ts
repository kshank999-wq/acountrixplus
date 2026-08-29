import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { customerStatements, customers, invoices, payments, statementSettings } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { DomainError, logUnexpected } from '@/modules/errors'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { saveStatement } from './statements'
import { sendStatement } from './statement-send'
import {
  DEFAULT_STATEMENT_POLICY,
  clampDayOfMonth,
  planStatements,
  type StatementCandidate,
  type StatementPolicy,
  type StatementRefusal,
} from './statement-runs'

/**
 * Sending the month's statements without anybody opening a page (spec §13, §24).
 *
 * The decision itself is in `statement-runs.ts` with no database. This is the
 * half that touches the world: reading the book, saving each statement so its
 * figures freeze, and sending it.
 *
 * ## Saving is part of the send here, unlike a chase
 *
 * Phase 43's chase run sends documents that already exist. This one **creates**
 * a document and then sends it, because a statement's figures are frozen at save
 * time (Phase 11) and frozen figures are the whole point of the document
 * (Phase 55).
 *
 * A send that fails therefore leaves a saved statement behind. That is right
 * rather than untidy: the saved row is the evidence of what was about to go
 * out, which is what `saveStatement` has existed for since Phase 11, and the
 * failure is in the delivery log where Phase 24 already looks.
 */

export type StatementSettings = StatementPolicy & {
  companyId: string
  /** A ceiling on one run, for the same reason `chase_settings` has one. */
  maxPerRun: number
  updatedAt: Date | null
}

const OFF: Omit<StatementSettings, 'companyId' | 'updatedAt'> = {
  ...DEFAULT_STATEMENT_POLICY,
  maxPerRun: 200,
}

/** This company's policy, or the off-by-default one. */
export async function getStatementPolicy(companyId: string): Promise<StatementSettings> {
  const [row] = await db
    .select()
    .from(statementSettings)
    .where(eq(statementSettings.companyId, companyId))
    .limit(1)

  if (!row) return { companyId, ...OFF, updatedAt: null }

  return {
    companyId,
    enabled: row.enabled,
    dayOfMonth: row.dayOfMonth,
    kind: row.kind,
    minimumBalanceCents: row.minimumBalanceCents,
    quietDays: row.quietDays,
    maxPerRun: row.maxPerRun,
    updatedAt: row.updatedAt,
  }
}

export type StatementPolicyInput = Partial<
  Omit<StatementSettings, 'companyId' | 'updatedAt'>
>

function validate(input: StatementPolicyInput) {
  if (input.dayOfMonth !== undefined && (input.dayOfMonth < 1 || input.dayOfMonth > 28)) {
    throw new DomainError(
      'Pick a day between the 1st and the 28th. Later days do not exist in every month, ' +
        'and a run that silently skips February is worse than one on the 28th.',
    )
  }
  if (input.minimumBalanceCents !== undefined && input.minimumBalanceCents < 0) {
    throw new DomainError('A minimum balance cannot be negative.')
  }
  if (input.quietDays !== undefined && input.quietDays < 0) {
    throw new DomainError('Quiet days cannot be negative.')
  }
  if (input.maxPerRun !== undefined && input.maxPerRun < 1) {
    throw new DomainError('A run has to be allowed to send at least one statement.')
  }
}

/**
 * Changes the policy.
 *
 * Gated on `accounting:journal` rather than `accounting:view`, unlike sending
 * one statement. Sending one is a person choosing to post a letter they are
 * looking at; switching this on decides that letters go out for ever without
 * anybody deciding again, which is the same class of act as switching on
 * chasing and takes the same permission.
 */
export async function updateStatementPolicy(
  ctx: ActorContext,
  input: StatementPolicyInput,
): Promise<StatementSettings> {
  requirePermission(ctx, 'accounting:journal')
  validate(input)

  const before = await getStatementPolicy(ctx.companyId)
  const after = { ...before, ...input, dayOfMonth: clampDayOfMonth(input.dayOfMonth ?? before.dayOfMonth) }

  await db
    .insert(statementSettings)
    .values({
      companyId: ctx.companyId,
      enabled: after.enabled,
      dayOfMonth: after.dayOfMonth,
      kind: after.kind,
      minimumBalanceCents: after.minimumBalanceCents,
      quietDays: after.quietDays,
      maxPerRun: after.maxPerRun,
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: statementSettings.companyId,
      set: {
        enabled: after.enabled,
        dayOfMonth: after.dayOfMonth,
        kind: after.kind,
        minimumBalanceCents: after.minimumBalanceCents,
        quietDays: after.quietDays,
        maxPerRun: after.maxPerRun,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      },
    })

  await recordAudit(ctx, {
    action: 'statement.policy',
    entityType: 'company',
    entityId: ctx.companyId,
    before: { enabled: before.enabled, dayOfMonth: before.dayOfMonth },
    after: { enabled: after.enabled, dayOfMonth: after.dayOfMonth },
  })

  return getStatementPolicy(ctx.companyId)
}

/**
 * Every customer, with what the decision needs and nothing else.
 *
 * One query rather than one per customer, for the reason `listCustomerSummaries`
 * gives: a list that runs a query per row stops loading at four hundred of them,
 * which is a size a real business reaches in a year.
 */
export async function statementCandidates(companyId: string): Promise<StatementCandidate[]> {
  // Open documents, in the home currency (Phase 56 — face amounts across
  // currencies add to a number with no meaning).
  const owing = db
    .select({
      customerId: invoices.customerId,
      balanceCents: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}), 0)`.as(
        'balance_cents',
      ),
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, companyId),
        sql`${invoices.status} not in ('void', 'draft')`,
        sql`${invoices.balanceCents} > 0`,
      ),
    )
    .groupBy(invoices.customerId)
    .as('owing')

  // What the business is holding for them (Phase 53). Void receipts hold
  // nothing (Phase 52).
  const heldCredit = db
    .select({
      customerId: payments.customerId,
      // Functional, to match the `owing` subquery beside it, which sums
      // `functional_balance_cents` (Phase 65). The minimum-balance floor
      // compares the two, and a floor that subtracts a face amount from a
      // converted one is not a threshold in any currency.
      heldCents: sql<string>`sum(${payments.functionalUnappliedCents})`.as('held_cents'),
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, companyId),
        eq(payments.status, 'posted'),
        sql`${payments.unappliedCents} > 0`,
      ),
    )
    .groupBy(payments.customerId)
    .as('held_credit')

  /**
   * When each customer last actually received one.
   *
   * `max(sent_at)` rather than `max(created_at)`: a statement saved and never
   * sent bought no quiet, which is the distinction Phase 55 existed to make.
   */
  const lastSent = db
    .select({
      customerId: customerStatements.customerId,
      lastSentAt: sql<string>`max(${customerStatements.sentAt})`.as('last_sent_at'),
    })
    .from(customerStatements)
    .where(
      and(eq(customerStatements.companyId, companyId), isNotNull(customerStatements.sentAt)),
    )
    .groupBy(customerStatements.customerId)
    .as('last_sent')

  const rows = await db
    .select({
      customerId: customers.id,
      customerName: customers.name,
      customerEmail: customers.email,
      balanceCents: owing.balanceCents,
      heldCents: heldCredit.heldCents,
      lastSentAt: lastSent.lastSentAt,
    })
    .from(customers)
    .leftJoin(owing, eq(owing.customerId, customers.id))
    .leftJoin(heldCredit, eq(heldCredit.customerId, customers.id))
    .leftJoin(lastSent, eq(lastSent.customerId, customers.id))
    .where(and(eq(customers.companyId, companyId), eq(customers.isActive, true)))

  return rows.map((row) => ({
    customerId: row.customerId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    balanceCents: Number(row.balanceCents ?? 0),
    heldCreditCents: Number(row.heldCents ?? 0),
    lastSentDate: row.lastSentAt ? String(row.lastSentAt).slice(0, 10) : null,
  }))
}

export type StatementPreview = {
  policy: StatementSettings
  asOf: string
  due: Array<{ candidate: StatementCandidate; balanceCents: number; heldCreditCents: number }>
  /** How many would go but for the cap. Zero on a normal month. */
  overCap: number
  held: Array<{ candidate: StatementCandidate; reason: StatementRefusal }>
  heldCounts: Record<StatementRefusal, number>
}

/**
 * What a run would do, without doing any of it.
 *
 * The same function the worker uses, so the screen cannot drift from the job.
 *
 * ## Asked as if it were on, and as if today were the day
 *
 * Phase 43 learned this the hard way and the lesson transfers exactly: computed
 * against the real policy, every row on a company that has not switched this on
 * reads "statement runs are switched off", including under the heading
 * promising to show what would go out — and on the other 27 days of the month
 * every row would read "not the day of the month for the run". The preview
 * would be empty at precisely the moment it is the whole point.
 *
 * So the plan is computed with `enabled` forced true and the day forced to
 * today, and the caller is handed the real `policy` alongside it. The switch is
 * still what decides whether anything is sent: `runStatements` checks the
 * stored policy, not this one.
 */
export async function previewStatements(
  companyId: string,
  asOf?: string,
): Promise<StatementPreview> {
  const [policy, candidates] = await Promise.all([
    getStatementPolicy(companyId),
    statementCandidates(companyId),
  ])

  const today = asOf ?? new Date().toISOString().slice(0, 10)
  const asIfOn = { ...policy, enabled: true }
  const plan = planStatements({
    candidates,
    policy: asIfOn,
    asOf: today,
    // The day is a scheduling question and this screen asks an eligibility
    // one. Forcing `dayOfMonth` to today looked equivalent and was not — the
    // clamp to 28 meant every row read "not the day" on the 29th, 30th and
    // 31st, which is what the browser found.
    ignoreRunDay: true,
  })

  return {
    policy,
    asOf: today,
    due: plan.due.slice(0, policy.maxPerRun),
    overCap: Math.max(0, plan.due.length - policy.maxPerRun),
    held: plan.held,
    heldCounts: plan.heldCounts,
  }
}

export type StatementRunResult = {
  companyId: string
  asOf: string
  enabled: boolean
  /** Statements saved. Equal to `sent` unless a delivery failed. */
  saved: number
  sent: number
  failed: number
  considered: number
  notes: string[]
}

/**
 * Sends the month's statements, or does nothing at all.
 *
 * Runs daily on the worker and decides for itself whether today is the day, so
 * the schedule lives in the company's policy rather than in a cron expression
 * somebody has to redeploy to change.
 */
export async function runStatements(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<StatementRunResult> {
  const companyId = ctx.companyId
  const today = opts.asOf ?? new Date().toISOString().slice(0, 10)

  const [policy, candidates] = await Promise.all([
    getStatementPolicy(companyId),
    statementCandidates(companyId),
  ])

  const base: StatementRunResult = {
    companyId,
    asOf: today,
    enabled: policy.enabled,
    saved: 0,
    sent: 0,
    failed: 0,
    considered: candidates.length,
    notes: [],
  }

  // The single most important line in the module. Absent settings mean off, and
  // off means this returns having touched nothing. The real policy is used
  // here, never the preview's as-if-on copy.
  if (!policy.enabled) return base

  const plan = planStatements({ candidates, policy, asOf: today })
  if (plan.due.length === 0) return base

  let saved = 0
  let sent = 0
  let failed = 0
  const notes: string[] = []

  for (const row of plan.due.slice(0, policy.maxPerRun)) {
    try {
      const statement = await saveStatement(ctx, {
        customerId: row.candidate.customerId,
        asOfDate: today,
        kind: policy.kind,
        // Balance-forward needs a period to carry a balance into: the month
        // ending today, which is what a monthly statement means.
        periodStart: policy.kind === 'balance_forward' ? monthStart(today) : undefined,
      })
      saved++

      const result = await sendStatement(ctx, statement.id)
      if (result.delivered) {
        sent++
      } else {
        failed++
        notes.push(`${row.candidate.customerName}: ${result.error ?? 'the provider refused it'}`)
      }
    } catch (error) {
      failed++
      // Logged rather than rethrown: one bad address is not a reason to leave
      // the rest of the month's statements unsent.
      logUnexpected(error, `sending a statement to ${row.candidate.customerName}`)
      notes.push(
        `${row.candidate.customerName}: ${error instanceof Error ? error.message : 'failed'}`,
      )
    }
  }

  if (plan.due.length > policy.maxPerRun) {
    notes.push(
      `${plan.due.length - policy.maxPerRun} more were due but the per-run cap held them back.`,
    )
  }

  return { ...base, saved, sent, failed, notes }
}

/** The first of the month `date` falls in. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** The statements this company has actually sent, most recent first. */
export async function recentStatementSends(ctx: ActorContext, limit = 20) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: customerStatements.id,
      customerName: customers.name,
      asOfDate: customerStatements.asOfDate,
      sentAt: customerStatements.sentAt,
      sentTo: customerStatements.sentTo,
      sendCount: customerStatements.sendCount,
    })
    .from(customerStatements)
    .innerJoin(customers, eq(customers.id, customerStatements.customerId))
    .where(
      and(
        eq(customerStatements.companyId, ctx.companyId),
        isNotNull(customerStatements.sentAt),
      ),
    )
    .orderBy(desc(customerStatements.sentAt))
    .limit(limit)
}
