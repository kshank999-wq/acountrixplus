import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { contributions, customers, financialAccounts, funds } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createJournalEntry } from '@/modules/ledger/journal'
import { INDUSTRY_ACCOUNTS } from '@/modules/coa/standard'
import { FundError, fundAccounts, fundDimensionId, requireFund } from './service'

/**
 * Money in, to a fund (spec §5, "Nonprofit — grants, donors").
 *
 * ## The claim: a promise is revenue when it is made
 *
 * A charity told in December that it will receive £50,000 in March has
 * £50,000 of revenue in December and £50,000 it cannot spend yet. That is what
 * an unconditional promise to give *is* — a receivable — and it is the one
 * piece of nonprofit revenue recognition that reliably surprises people, so it
 * is the piece this module gets explicitly right.
 *
 * Waiting for the cheque would report the year the appeal succeeded as the
 * worse year and the following one as a windfall, which is exactly backwards
 * for a trustee trying to work out whether the appeal worked.
 *
 * The consequence lands on the other side: **receiving a pledge is not
 * revenue.** It clears a receivable. `receivePledge` posts no revenue line at
 * all, and a test asserts that the income for the year does not move when the
 * money arrives.
 */

export type ContributionKind = 'gift' | 'pledge'

/** Which revenue account a gift lands in. */
export type ContributionSource = 'donation' | 'grant'

export type ContributionRow = {
  id: string
  fundId: string
  fundCode: string
  fundName: string
  donorId: string | null
  donorName: string | null
  kind: ContributionKind
  receivedOn: string
  amountCents: number
  receivedCents: number
  /** What a pledge still owes. Always zero for a gift. */
  outstandingCents: number
  reference: string | null
  memo: string | null
  journalEntryId: string | null
}

/**
 * Records a gift or a promise, and recognises the revenue.
 *
 * A gift debits the bank; a pledge debits Pledges Receivable. Both credit the
 * same revenue account, because both are revenue on the day they happen — the
 * difference between them is which asset went up, not whether the charity is
 * better off.
 *
 * Both lines carry the fund dimension, including the cash line. Tagging only
 * the revenue would answer "what did the roof appeal raise" and not "what did
 * it raise and spend", and the second question is the one a donor asks.
 */
export async function recordContribution(
  ctx: ActorContext,
  input: {
    fundId: string
    donorId?: string | null
    kind?: ContributionKind
    source?: ContributionSource
    receivedOn: string
    amountCents: number
    /** Where the money landed. Required for a gift, ignored for a pledge. */
    financialAccountId?: string | null
    reference?: string | null
    memo?: string | null
  },
): Promise<{ id: string; journalEntryId: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'funds')

  if (input.amountCents <= 0) {
    throw new FundError('A contribution must be more than nothing.')
  }

  const kind: ContributionKind = input.kind ?? 'gift'
  const fund = await requireFund(ctx, input.fundId)
  const accounts = await fundAccounts(ctx)

  const revenueAccountId =
    input.source === 'grant'
      ? accounts.need(INDUSTRY_ACCOUNTS.grantRevenue, 'a Grant Revenue account')
      : accounts.need(INDUSTRY_ACCOUNTS.contributionRevenue, 'a Contributions account')

  return db.transaction(async (tx) => {
    const dimension = { [await fundDimensionFor(ctx)]: fund.dimensionValueId }

    let debitAccountId: string
    if (kind === 'pledge') {
      debitAccountId = accounts.need(
        INDUSTRY_ACCOUNTS.pledgesReceivable,
        'a Pledges Receivable account',
      )
    } else {
      if (!input.financialAccountId) {
        throw new FundError('Say which account the money went into.')
      }

      const [bank] = await tx
        .select({ chartAccountId: financialAccounts.chartAccountId })
        .from(financialAccounts)
        .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
        .limit(1)

      if (!bank) throw new FundError('That account does not exist.')
      debitAccountId = bank.chartAccountId
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.receivedOn,
        memo:
          kind === 'pledge'
            ? `Pledge to ${fund.name}`
            : `${input.source === 'grant' ? 'Grant' : 'Donation'} to ${fund.name}`,
        source: 'contribution',
        sourceType: 'fund',
        sourceId: fund.id,
        lines: [
          {
            chartAccountId: debitAccountId,
            debitCents: input.amountCents,
            dimensions: dimension,
            memo: kind === 'pledge' ? 'Promised, not yet received' : null,
          },
          {
            chartAccountId: revenueAccountId,
            creditCents: input.amountCents,
            dimensions: dimension,
          },
        ],
      },
      tx,
    )

    const [row] = await tx
      .insert(contributions)
      .values({
        companyId: ctx.companyId,
        fundId: fund.id,
        donorId: input.donorId ?? null,
        kind: kind as never,
        receivedOn: input.receivedOn,
        amountCents: input.amountCents,
        // A gift is settled the moment it is recorded; a pledge starts at zero
        // and only moves when money actually arrives.
        receivedCents: kind === 'gift' ? input.amountCents : 0,
        reference: input.reference?.trim() || null,
        memo: input.memo?.trim() || null,
        journalEntryId: entry.id,
        createdBy: ctx.userId,
      })
      .returning({ id: contributions.id })

    await recordAudit(
      ctx,
      {
        action: 'contribution.record',
        entityType: 'contribution',
        entityId: row.id,
        after: { fundId: fund.id, kind, amountCents: input.amountCents, receivedOn: input.receivedOn },
      },
      tx,
    )

    return { id: row.id, journalEntryId: entry.id }
  })
}

/**
 * A promised amount arrives.
 *
 * Debits the bank, credits Pledges Receivable, and **posts no revenue** — the
 * revenue was recognised when the promise was made. An entry here that touched
 * an income account would count the same gift twice, and would do it in a way
 * that reconciles perfectly: the bank agrees, the fund balance agrees, and only
 * the income for the year is wrong by the size of the appeal.
 */
export async function receivePledge(
  ctx: ActorContext,
  input: {
    contributionId: string
    amountCents: number
    receivedOn: string
    financialAccountId: string
    memo?: string | null
  },
): Promise<{ receivedCents: number; outstandingCents: number; journalEntryId: string }> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'funds')

  if (input.amountCents <= 0) {
    throw new FundError('A receipt must be more than nothing.')
  }

  const accounts = await fundAccounts(ctx)
  const receivableId = accounts.need(
    INDUSTRY_ACCOUNTS.pledgesReceivable,
    'a Pledges Receivable account',
  )

  return db.transaction(async (tx) => {
    // Locked for the same reason a document balance is: two people banking the
    // same cheque at the same moment would each read the old `receivedCents`,
    // and the later write would silently forgive the first.
    const [row] = await tx
      .select()
      .from(contributions)
      .where(scoped(ctx, contributions, eq(contributions.id, input.contributionId)))
      .for('update')
      .limit(1)

    if (!row) throw new FundError('That contribution does not exist.')
    if (row.kind !== 'pledge') {
      throw new FundError('That is a gift, not a promise — the money is already in.')
    }

    const outstanding = row.amountCents - row.receivedCents
    if (input.amountCents > outstanding) {
      throw new FundError(
        `That is more than is still promised. ${(outstanding / 100).toFixed(2)} is outstanding.`,
      )
    }

    const fund = await requireFund(ctx, row.fundId, tx)

    const [bank] = await tx
      .select({ chartAccountId: financialAccounts.chartAccountId })
      .from(financialAccounts)
      .where(scoped(ctx, financialAccounts, eq(financialAccounts.id, input.financialAccountId)))
      .limit(1)

    if (!bank) throw new FundError('That account does not exist.')

    const dimension = { [await fundDimensionFor(ctx)]: fund.dimensionValueId }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.receivedOn,
        memo: `Pledge received — ${fund.name}`,
        source: 'contribution',
        sourceType: 'contribution',
        sourceId: row.id,
        lines: [
          { chartAccountId: bank.chartAccountId, debitCents: input.amountCents, dimensions: dimension },
          {
            chartAccountId: receivableId,
            creditCents: input.amountCents,
            dimensions: dimension,
            memo: 'Promise settled — the revenue was recognised when it was made',
          },
        ],
      },
      tx,
    )

    const receivedCents = row.receivedCents + input.amountCents

    await tx
      .update(contributions)
      .set({ receivedCents })
      .where(eq(contributions.id, row.id))

    await recordAudit(
      ctx,
      {
        action: 'contribution.receive',
        entityType: 'contribution',
        entityId: row.id,
        before: { receivedCents: row.receivedCents },
        after: { receivedCents, amountCents: input.amountCents },
      },
      tx,
    )

    return {
      receivedCents,
      outstandingCents: row.amountCents - receivedCents,
      journalEntryId: entry.id,
    }
  })
}

/** Contributions to one fund, or to all of them, newest first. */
export async function listContributions(
  ctx: ActorContext,
  opts: { fundId?: string; outstandingOnly?: boolean; limit?: number } = {},
): Promise<ContributionRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      id: contributions.id,
      fundId: contributions.fundId,
      fundCode: funds.code,
      fundName: funds.name,
      donorId: contributions.donorId,
      donorName: customers.name,
      kind: contributions.kind,
      receivedOn: contributions.receivedOn,
      amountCents: contributions.amountCents,
      receivedCents: contributions.receivedCents,
      reference: contributions.reference,
      memo: contributions.memo,
      journalEntryId: contributions.journalEntryId,
    })
    .from(contributions)
    .innerJoin(funds, eq(funds.id, contributions.fundId))
    .leftJoin(customers, eq(customers.id, contributions.donorId))
    .where(
      scoped(
        ctx,
        contributions,
        and(
          opts.fundId ? eq(contributions.fundId, opts.fundId) : undefined,
          opts.outstandingOnly
            ? sql`${contributions.receivedCents} < ${contributions.amountCents}`
            : undefined,
        ),
      ),
    )
    .orderBy(desc(contributions.receivedOn), desc(contributions.createdAt))
    .limit(opts.limit ?? 200)

  return rows.map((row) => ({
    ...row,
    kind: row.kind as ContributionKind,
    outstandingCents: row.amountCents - row.receivedCents,
  }))
}

/**
 * Promises still owed, oldest first.
 *
 * The fundraiser's list, and the reason `receivedCents` is kept on the row as
 * well as in the ledger: "which promises are outstanding" should not require
 * reading journal lines.
 */
export async function outstandingPledges(ctx: ActorContext): Promise<ContributionRow[]> {
  requirePermission(ctx, 'accounting:view')

  const rows = await db
    .select({
      id: contributions.id,
      fundId: contributions.fundId,
      fundCode: funds.code,
      fundName: funds.name,
      donorId: contributions.donorId,
      donorName: customers.name,
      kind: contributions.kind,
      receivedOn: contributions.receivedOn,
      amountCents: contributions.amountCents,
      receivedCents: contributions.receivedCents,
      reference: contributions.reference,
      memo: contributions.memo,
      journalEntryId: contributions.journalEntryId,
    })
    .from(contributions)
    .innerJoin(funds, eq(funds.id, contributions.fundId))
    .leftJoin(customers, eq(customers.id, contributions.donorId))
    .where(
      scoped(
        ctx,
        contributions,
        and(
          eq(contributions.kind, 'pledge'),
          sql`${contributions.receivedCents} < ${contributions.amountCents}`,
        ),
      ),
    )
    .orderBy(asc(contributions.receivedOn))

  return rows.map((row) => ({
    ...row,
    kind: row.kind as ContributionKind,
    outstandingCents: row.amountCents - row.receivedCents,
  }))
}

/**
 * The Fund dimension's id, required rather than optional.
 *
 * Every caller here has already resolved a fund, and a fund cannot exist
 * without the dimension — so a null at this point is a corrupted database
 * rather than a case to handle.
 */
async function fundDimensionFor(ctx: ActorContext): Promise<string> {
  const id = await fundDimensionId(ctx)
  if (!id) throw new FundError('Could not resolve the Fund dimension.')
  return id
}
