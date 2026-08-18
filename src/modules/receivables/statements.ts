import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  creditApplications,
  creditNotes,
  customerStatements,
  customers,
  invoiceWriteOffs,
  invoices,
  paymentApplications,
  payments,
} from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { agingBucket } from '@/modules/ledger/reports'

/**
 * Customer statements (spec §13: "customers, invoices, credits, payments,
 * aging, **statements**, write-offs").
 *
 * ## Two kinds, and why both exist
 *
 * **Open-item** lists what is unpaid, document by document. It is what a
 * business-to-business customer's accounts payable department wants, because
 * they pay by invoice and need to know which ones.
 *
 * **Balance-forward** carries a total in, lists the period's activity, and
 * carries a total out. It is what a customer on an account wants — a bank
 * statement for what they owe you.
 *
 * Most software picks one and calls it "the statement". They answer different
 * questions and a company usually needs both, for different customers.
 *
 * ## Why a sent statement is stored rather than regenerated
 *
 * "What did we send them, and when" is the first question in any collections
 * conversation, and a statement regenerated from today's data is not the
 * document the customer is holding. So the figures are frozen onto the row when
 * it is created — the same reasoning as Phase 9's prepared filings.
 */

export type StatementLine = {
  date: string
  kind: 'invoice' | 'payment' | 'credit' | 'write_off'
  reference: string
  description: string
  /** Positive increases what they owe; negative reduces it. */
  amountCents: number
  runningBalanceCents: number
  /** Only on open invoices. */
  dueDate?: string
  bucket?: ReturnType<typeof agingBucket>
  balanceCents?: number
}

export type CustomerStatement = {
  customerId: string
  customerName: string
  customerEmail: string | null
  kind: 'open_item' | 'balance_forward'
  periodStart: string | null
  asOfDate: string
  openingBalanceCents: number
  closingBalanceCents: number
  lines: StatementLine[]
  /** Unpaid documents by age, so the covering note can say "60 days overdue". */
  aging: Record<string, number>
  oldestUnpaidDate: string | null
}

/**
 * Builds a statement without saving it.
 *
 * Pure of side effects so the same function serves the preview, the saved
 * record, and the rendered document — three views that must never disagree
 * about what a customer owes.
 */
export async function buildStatement(
  ctx: ActorContext,
  input: {
    customerId: string
    asOfDate: string
    kind?: 'open_item' | 'balance_forward'
    /** Required for balance-forward; ignored for open-item. */
    periodStart?: string
  },
): Promise<CustomerStatement> {
  requirePermission(ctx, 'accounting:view')

  const kind = input.kind ?? 'open_item'

  const [customer] = await db
    .select()
    .from(customers)
    .where(scoped(ctx, customers, eq(customers.id, input.customerId)))
    .limit(1)

  if (!customer) throw new Error('Customer not found')

  if (kind === 'balance_forward' && !input.periodStart) {
    throw new Error('A balance-forward statement needs a period to carry a balance into.')
  }

  const activity = await customerActivity(ctx, input.customerId, input.asOfDate)

  // Everything before the period start is the opening balance; the rest is the
  // period's movement. Open-item statements start from zero and list only what
  // is still owed, so they have no opening balance by construction.
  const periodStart = kind === 'balance_forward' ? input.periodStart! : null

  const before = periodStart ? activity.filter((row) => row.date < periodStart) : []
  const during = periodStart ? activity.filter((row) => row.date >= periodStart) : activity

  const openingBalanceCents = before.reduce((sum, row) => sum + row.amountCents, 0)

  let running = openingBalanceCents
  const lines: StatementLine[] = []

  if (kind === 'balance_forward') {
    for (const row of during) {
      running += row.amountCents
      lines.push({ ...row, runningBalanceCents: running })
    }
  } else {
    // Open-item: the unpaid documents themselves, not the movements.
    const open = await openInvoices(ctx, input.customerId, input.asOfDate)

    for (const invoice of open) {
      running += invoice.balanceCents
      lines.push({
        date: invoice.issueDate,
        kind: 'invoice',
        reference: invoice.number,
        description: `Invoice ${invoice.number}`,
        amountCents: invoice.balanceCents,
        runningBalanceCents: running,
        dueDate: invoice.dueDate,
        bucket: agingBucket(invoice.dueDate, input.asOfDate),
        balanceCents: invoice.balanceCents,
      })
    }
  }

  const closingBalanceCents =
    kind === 'balance_forward'
      ? running
      : lines.reduce((sum, line) => sum + (line.balanceCents ?? 0), 0)

  const aging: Record<string, number> = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  }

  const open = await openInvoices(ctx, input.customerId, input.asOfDate)
  for (const invoice of open) {
    aging[agingBucket(invoice.dueDate, input.asOfDate)] += invoice.balanceCents
  }

  return {
    customerId: customer.id,
    customerName: customer.name,
    customerEmail: customer.email,
    kind,
    periodStart,
    asOfDate: input.asOfDate,
    openingBalanceCents,
    closingBalanceCents,
    lines,
    aging,
    oldestUnpaidDate: open[0]?.issueDate ?? null,
  }
}

/**
 * Every movement on a customer's account, oldest first.
 *
 * Four sources, and the reason they are unioned in code rather than SQL is
 * that each needs a different sign and label. A payment reduces what they owe;
 * so does a credit note and so does a write-off — but a statement that showed
 * all three as "payment" would tell a customer they had paid a debt somebody
 * gave up on collecting.
 */
async function customerActivity(
  ctx: ActorContext,
  customerId: string,
  asOfDate: string,
): Promise<Array<Omit<StatementLine, 'runningBalanceCents'>>> {
  const [invoiceRows, paymentRows, creditRows, writeOffRows] = await Promise.all([
    db
      .select({
        date: invoices.issueDate,
        reference: invoices.number,
        amountCents: invoices.totalCents,
      })
      .from(invoices)
      .where(
        scoped(
          ctx,
          invoices,
          eq(invoices.customerId, customerId),
          lte(invoices.issueDate, asOfDate),
          sql`${invoices.status} <> 'void'`,
        ),
      ),

    db
      .select({
        date: payments.paymentDate,
        reference: payments.reference,
        amountCents: paymentApplications.amountCents,
        invoiceNumber: invoices.number,
      })
      .from(paymentApplications)
      .innerJoin(payments, eq(payments.id, paymentApplications.paymentId))
      .innerJoin(invoices, eq(invoices.id, paymentApplications.invoiceId))
      .where(
        and(
          eq(paymentApplications.companyId, ctx.companyId),
          eq(payments.customerId, customerId),
          lte(payments.paymentDate, asOfDate),
        ),
      ),

    db
      .select({
        date: creditApplications.appliedOn,
        reference: creditNotes.number,
        amountCents: creditApplications.amountCents,
        invoiceNumber: invoices.number,
      })
      .from(creditApplications)
      .innerJoin(creditNotes, eq(creditNotes.id, creditApplications.creditNoteId))
      .innerJoin(invoices, eq(invoices.id, creditApplications.invoiceId))
      .where(
        and(
          eq(creditApplications.companyId, ctx.companyId),
          eq(creditNotes.customerId, customerId),
          lte(creditApplications.appliedOn, asOfDate),
        ),
      ),

    db
      .select({
        date: invoiceWriteOffs.writtenOffOn,
        reference: invoices.number,
        amountCents: invoiceWriteOffs.amountCents,
      })
      .from(invoiceWriteOffs)
      .innerJoin(invoices, eq(invoices.id, invoiceWriteOffs.invoiceId))
      .where(
        and(
          eq(invoiceWriteOffs.companyId, ctx.companyId),
          eq(invoices.customerId, customerId),
          lte(invoiceWriteOffs.writtenOffOn, asOfDate),
        ),
      ),
  ])

  const lines: Array<Omit<StatementLine, 'runningBalanceCents'>> = [
    ...invoiceRows.map((row) => ({
      date: row.date,
      kind: 'invoice' as const,
      reference: row.reference,
      description: `Invoice ${row.reference}`,
      amountCents: row.amountCents,
    })),
    ...paymentRows.map((row) => ({
      date: row.date,
      kind: 'payment' as const,
      reference: row.reference ?? '—',
      description: `Payment against ${row.invoiceNumber}`,
      amountCents: -row.amountCents,
    })),
    ...creditRows.map((row) => ({
      date: row.date,
      kind: 'credit' as const,
      reference: row.reference,
      description: `Credit note ${row.reference} against ${row.invoiceNumber}`,
      amountCents: -row.amountCents,
    })),
    ...writeOffRows.map((row) => ({
      date: row.date,
      kind: 'write_off' as const,
      reference: row.reference,
      // Named for what it is. A customer reading "payment" against a debt
      // nobody paid would be entitled to be confused.
      description: `Written off — invoice ${row.reference}`,
      amountCents: -row.amountCents,
    })),
  ]

  return lines.sort((a, b) => (a.date === b.date ? a.kind.localeCompare(b.kind) : a.date < b.date ? -1 : 1))
}

async function openInvoices(ctx: ActorContext, customerId: string, asOfDate: string) {
  return db
    .select({
      id: invoices.id,
      number: invoices.number,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      balanceCents: invoices.balanceCents,
    })
    .from(invoices)
    .where(
      scoped(
        ctx,
        invoices,
        eq(invoices.customerId, customerId),
        lte(invoices.issueDate, asOfDate),
        gt(invoices.balanceCents, 0),
        sql`${invoices.status} NOT IN ('void', 'written_off')`,
      ),
    )
    .orderBy(asc(invoices.issueDate))
}

/**
 * Saves a statement, freezing its figures.
 *
 * Recording it before it is sent, rather than after, so a send that fails
 * still leaves evidence of what was about to go out — the same reasoning the
 * outbox applies to notifications.
 */
export async function saveStatement(
  ctx: ActorContext,
  input: {
    customerId: string
    asOfDate: string
    kind?: 'open_item' | 'balance_forward'
    periodStart?: string
    sentTo?: string
  },
) {
  requirePermission(ctx, 'accounting:view')

  const statement = await buildStatement(ctx, input)

  return db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(customerStatements)
      .values({
        companyId: ctx.companyId,
        customerId: input.customerId,
        kind: statement.kind,
        periodStart: statement.periodStart,
        asOfDate: statement.asOfDate,
        openingBalanceCents: statement.openingBalanceCents,
        closingBalanceCents: statement.closingBalanceCents,
        figures: {
          lines: statement.lines,
          aging: statement.aging,
          oldestUnpaidDate: statement.oldestUnpaidDate,
        },
        sentTo: input.sentTo ?? statement.customerEmail,
        createdBy: ctx.userId,
      })
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'statement.create',
        entityType: 'customer_statement',
        entityId: saved.id,
        after: {
          customer: statement.customerName,
          kind: statement.kind,
          asOfDate: statement.asOfDate,
          closingBalanceCents: statement.closingBalanceCents,
        },
      },
      tx,
    )

    return saved
  })
}

export async function listStatements(
  ctx: ActorContext,
  opts: { customerId?: string; limit?: number } = {},
) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: customerStatements.id,
      customerId: customerStatements.customerId,
      customerName: customers.name,
      kind: customerStatements.kind,
      asOfDate: customerStatements.asOfDate,
      closingBalanceCents: customerStatements.closingBalanceCents,
      sentAt: customerStatements.sentAt,
      sentTo: customerStatements.sentTo,
      createdAt: customerStatements.createdAt,
    })
    .from(customerStatements)
    .innerJoin(customers, eq(customers.id, customerStatements.customerId))
    .where(
      scoped(
        ctx,
        customerStatements,
        opts.customerId ? eq(customerStatements.customerId, opts.customerId) : undefined,
      ),
    )
    .orderBy(desc(customerStatements.createdAt))
    .limit(opts.limit ?? 50)
}

/** Customers with something outstanding, for choosing who to send to. */
export async function customersWithBalances(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      // The *home-currency* balance, not the document one. A customer with a
      // $1,000 invoice and a €2,500 one has no meaningful sum of face amounts,
      // and adding them anyway produces 3,500 of nothing with a dollar sign in
      // front of it (Phase 35).
      balanceCents: sql<string>`coalesce(sum(${invoices.functionalBalanceCents}), 0)`,
      openCount: sql<string>`count(${invoices.id})`,
    })
    .from(customers)
    .leftJoin(
      invoices,
      and(
        eq(invoices.customerId, customers.id),
        gt(invoices.balanceCents, 0),
        sql`${invoices.status} NOT IN ('void', 'written_off')`,
      ),
    )
    .where(scoped(ctx, customers))
    .groupBy(customers.id, customers.name, customers.email)
    .orderBy(desc(sql`coalesce(sum(${invoices.functionalBalanceCents}), 0)`))
}
