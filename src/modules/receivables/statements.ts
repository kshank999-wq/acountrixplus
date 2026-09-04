import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  companies,
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
import { describeNet, netPosition } from './net-position'
import {
  balancesByCurrency,
  foreignBalanceNote,
  homeCurrencyOwed,
  type CurrencyBalance,
} from './statement-currency'
import {
  heldByCurrency,
  netByCurrency,
  type CurrencyPosition,
} from './settlement-currency'
import { agingBucket } from '@/modules/ledger/aging'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

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
  /**
   * Positive increases what they owe; negative reduces it.
   *
   * In `currency` where one is given — what the customer was actually
   * invoiced, which is what they have to pay (Phase 61).
   */
  amountCents: number
  /** The currency of `amountCents`. Absent on a movement line. */
  currency?: string
  /** What `amountCents` is worth in the company's currency. Comparable. */
  functionalBalanceCents?: number
  /**
   * The company-currency total so far.
   *
   * Never a demand: it is a sum across documents, and this is the only
   * currency such a sum can be in.
   */
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
  /** The company's own currency — the one every total here is in. */
  currency: string
  /**
   * What the invoices on this statement come to, before credit is netted off.
   *
   * Kept alongside `dueCents` rather than replaced by it, because the two
   * answer different questions: the gross is what was billed, and the net is
   * what to pay. A statement that showed only the net would leave a customer
   * unable to reconcile it against their own purchase ledger.
   *
   * **In the company's currency** (Phase 61). It is a sum across documents, so
   * it can be in no other — and it is therefore a figure for comparing one
   * customer against another, not one to ask anybody to pay. What to pay is
   * `currencyBalances`.
   */
  closingBalanceCents: number
  /**
   * What is outstanding, in the currency each part of it is outstanding in.
   *
   * One entry for almost every customer there has ever been. More than one
   * means there is no single total to state, and stating one is exactly what
   * this document used to do: a customer invoiced €4,000 and $1,200 was told
   * they owed "$5,200.00".
   */
  currencyBalances: CurrencyBalance[]
  /**
   * What is due in each currency, once the credit held **in that currency** is
   * set against it (Phase 62).
   *
   * ADR 0061 could only net against the home-currency balance, because a
   * receipt carried no currency. It does now, so a euro credit meets a euro
   * invoice and a dollar credit does not.
   */
  positions: CurrencyPosition[]
  /**
   * What to say about a balance the net-position sentence did not cover, or
   * null when there is none.
   */
  foreignNote: string | null
  /**
   * What the business is holding for this customer (Phase 54).
   *
   * Phase 53 gave an overpayment somewhere to live and left this document
   * blind to it, so a customer holding $600 against a $900 invoice was sent a
   * statement claiming $900 — a claim they could disprove from their own bank
   * records.
   */
  heldCreditCents: number
  /** What is actually due once the credit is netted off. Never below zero. */
  dueCents: number
  /** What the business still owes them, when the credit runs past the debt. */
  ourDebtCents: number
  /** A sentence for the covering note, decided by the same pure function. */
  positionNote: string
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

  if (!customer) throw missing('customer')

  if (kind === 'balance_forward' && !input.periodStart) {
    throw new Refusal('A balance-forward statement needs a period to carry a balance into.')
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
      // The running total is in the company's currency, because it is a sum
      // across documents and a sum only means something when its terms agree
      // (Phase 61). The line itself shows what the customer was invoiced.
      running += invoice.functionalBalanceCents
      lines.push({
        date: invoice.issueDate,
        kind: 'invoice',
        reference: invoice.number,
        description: `Invoice ${invoice.number}`,
        amountCents: invoice.balanceCents,
        currency: invoice.currency,
        functionalBalanceCents: invoice.functionalBalanceCents,
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
      : lines.reduce((sum, line) => sum + (line.functionalBalanceCents ?? 0), 0)

  /**
   * What the business is holding for them, across every posted receipt.
   *
   * Read here rather than by the caller because all three views of a statement
   * — the preview, the saved record and the rendered document — come through
   * this function, and they must never disagree about what a customer owes.
   *
   * Cut off at `asOfDate`, like the invoices above it: a receipt that arrived
   * in August did not reduce what was due on the June statement, and counting
   * it would net a credit against invoices it had not yet met.
   */
  const heldRows = await db
    .select({
      // Grouped by the currency the receipt was actually in (Phase 62). This
      // used to be one `sum()` read as the company's own money, so a customer
      // who overpaid a €4,000 invoice by €500 was holding "$500".
      currency: payments.currency,
      total: sql<string>`coalesce(sum(${payments.unappliedCents}), 0)`,
    })
    .from(payments)
    .where(
      scoped(
        ctx,
        payments,
        eq(payments.customerId, input.customerId),
        eq(payments.status, 'posted'),
        lte(payments.paymentDate, input.asOfDate),
      ),
    )
    .groupBy(payments.currency)

  const held = heldByCurrency(
    heldRows.map((row) => ({ currency: row.currency, unappliedCents: Number(row.total) })),
  )

  const [company] = await db
    .select({ currency: companies.currency })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1)

  const homeCurrency = company?.currency ?? 'USD'

  const aging: Record<string, number> = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  }

  const open = await openInvoices(ctx, input.customerId, input.asOfDate)
  for (const invoice of open) {
    // In the company's currency: an aging bucket sums across customers and
    // documents, so it is a comparison figure and never a demand (Phase 61).
    aging[agingBucket(invoice.dueDate, input.asOfDate)] += invoice.functionalBalanceCents
  }

  /**
   * What is outstanding, in the currency each part of it is outstanding in.
   *
   * The figure a customer acts on. `closingBalanceCents` above is a sum across
   * documents and is therefore in the company's money — useful for comparing
   * one customer against another, and no use at all for telling somebody what
   * to pay, because they cannot send it (Phase 61).
   */
  const currencyBalances = balancesByCurrency(open)

  /**
   * Phase 54's netting, now done once per currency (Phase 62).
   *
   * ADR 0061 could only net against the home-currency balance, because a
   * receipt carried no currency and the credit's was genuinely unknowable. It
   * is known now, so a euro credit is set against the euro balance and a
   * dollar credit is not — which is what a customer would do with their own
   * ledger, and what they will expect the statement to have done.
   */
  const positions = netByCurrency(
    currencyBalances.map((row) => ({
      currency: row.currency,
      balanceCents: row.balanceCents,
    })),
    held,
  )

  /**
   * The headline figures stay in the company's currency, because they are sums
   * across currencies and can be in no other. What to actually pay, per
   * currency, is `positions`.
   */
  const heldCreditCents = held.reduce((sum, row) => sum + row.heldCents, 0)
  const position = netPosition({
    owedCents: homeCurrencyOwed(currencyBalances, homeCurrency),
    heldCents: held.find((row) => row.currency === homeCurrency)?.heldCents ?? 0,
  })

  const foreignNote = foreignBalanceNote(currencyBalances, homeCurrency)

  return {
    customerId: customer.id,
    customerName: customer.name,
    customerEmail: customer.email,
    kind,
    periodStart,
    asOfDate: input.asOfDate,
    openingBalanceCents,
    closingBalanceCents,
    heldCreditCents,
    dueCents: position.dueCents,
    ourDebtCents: position.ourDebtCents,
    currency: homeCurrency,
    currencyBalances,
    positions,
    positionNote: describeNet(position, homeCurrency),
    /**
     * Said beneath the sentence above, because Phase 54's sentence covers the
     * home-currency balance alone. Silence would leave a customer reading
     * "nothing is due" over a euro invoice listed right there.
     */
    foreignNote,
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
          // A statement showing a payment that was taken back would be a
          // statement the customer can disprove (Phase 52).
          eq(payments.status, 'posted'),
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
      // What the customer was invoiced in, and what that is worth to us
      // (Phase 61). The first is what the line shows and what they must pay;
      // the second is the only one that may be added or compared.
      currency: invoices.currency,
      functionalBalanceCents: invoices.functionalBalanceCents,
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
 *
 * ## What it no longer claims (Phase 55)
 *
 * This used to write `sentTo` from the customer's address at save time, while
 * `sentAt` was written by nothing at all. The result was a row showing a
 * statement, a date and an email address it had never been sent to — and a
 * business reading that column would conclude the customer had been told.
 *
 * Both columns now belong to `sendStatement` and neither is written here. A
 * saved statement is a saved statement; it says nothing about where it went
 * until it goes.
 */
export async function saveStatement(
  ctx: ActorContext,
  input: {
    customerId: string
    asOfDate: string
    kind?: 'open_item' | 'balance_forward'
    periodStart?: string
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
          /**
           * Frozen with everything else (Phase 54). A statement sent in March
           * has to still say in July what it said in March — including that
           * $600 of the customer's money was being held at the time, which is
           * the figure they would query.
           */
          heldCreditCents: statement.heldCreditCents,
          dueCents: statement.dueCents,
          ourDebtCents: statement.ourDebtCents,
          positionNote: statement.positionNote,
          /**
           * Frozen too (Phase 62), for the reason the figures above are: a
           * statement that told a customer €500 was being held has to keep
           * saying €500, and the held total alone cannot say which currency.
           * Absent on every statement frozen before this phase, which read as
           * the company's own currency and still does.
           */
          positions: statement.positions,
        },
        // `sentTo` and `sentAt` are deliberately not set here — see above.
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
          heldCreditCents: statement.heldCreditCents,
          dueCents: statement.dueCents,
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

  const rows = await db
    .select({
      id: customerStatements.id,
      customerId: customerStatements.customerId,
      customerName: customers.name,
      kind: customerStatements.kind,
      asOfDate: customerStatements.asOfDate,
      closingBalanceCents: customerStatements.closingBalanceCents,
      figures: customerStatements.figures,
      sendCount: customerStatements.sendCount,
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

  return rows.map((row) => {
    /**
     * Read back out of the frozen figures rather than recomputed (Phase 54).
     *
     * Asking the books again would answer as of *today*, so a statement sent in
     * March would silently change its mind in July — which is exactly the
     * question somebody has the list open to answer: what did we tell them?
     *
     * Absent on every statement saved before Phase 54, which read as a plain
     * gross balance and should keep reading as one.
     */
    const frozen = (row.figures ?? {}) as Partial<
      Pick<CustomerStatement, 'heldCreditCents' | 'dueCents' | 'positionNote'>
    >

    return {
      ...row,
      heldCreditCents: frozen.heldCreditCents ?? 0,
      dueCents: frozen.dueCents ?? row.closingBalanceCents,
      positionNote: frozen.positionNote ?? null,
    }
  })
}

/** Customers with something outstanding, for choosing who to send to. */
export async function customersWithBalances(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  /**
   * What the business is holding for each customer (Phase 54).
   *
   * A subquery rather than another join onto the same grouped rows: joining it
   * alongside `invoices` would multiply the receipts by the open invoices and
   * count the held credit once per invoice. Void receipts hold nothing
   * (Phase 52).
   */
  const heldCredit = db
    .select({
      customerId: payments.customerId,
      // Functional (Phase 65), to match `balanceCents` below — which is
      // explicitly the home-currency balance, and was being reduced by a face
      // amount in whatever currency the receipt happened to arrive in.
      heldCents: sql<string>`sum(${payments.functionalUnappliedCents})`.as('held_cents'),
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, ctx.companyId),
        eq(payments.status, 'posted'),
        gt(payments.unappliedCents, 0),
      ),
    )
    .groupBy(payments.customerId)
    .as('held_credit')

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
      heldCreditCents: sql<string>`coalesce(max(${heldCredit.heldCents}), 0)`,
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
    .leftJoin(heldCredit, eq(heldCredit.customerId, customers.id))
    .where(scoped(ctx, customers))
    .groupBy(customers.id, customers.name, customers.email)
    .orderBy(desc(sql`coalesce(sum(${invoices.functionalBalanceCents}), 0)`))
}
