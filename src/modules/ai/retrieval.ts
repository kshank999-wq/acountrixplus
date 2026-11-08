import { desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactions,
  chartAccounts,
  companies,
  companyProfiles,
  serviceItems,
  financialAccounts,
} from '@/db/schema'
import { can, scoped, type ActorContext } from '@/modules/tenancy/context'
import type { Permission } from '@/modules/permissions'

/**
 * The retrieval layer (spec §12: "Retrieval layer supplies only relevant
 * company records and documents after tenant and permission checks").
 *
 * Every function here is scoped to the acting company and gated on the same
 * permission the human would need to read the data by hand. That is the whole
 * point: **AI must never become a way to read something you could not read
 * yourself.** A salesperson asking an assistant about cash flow gets nothing,
 * exactly as they would from the reports page.
 *
 * The checks return empty rather than throwing. A context builder assembling
 * five kinds of data for an insight should produce an insight from the four
 * the user may see, not fail entirely because of the fifth.
 */

/** Reads scoped data only when the actor holds the permission. */
async function ifPermitted<T>(
  ctx: ActorContext,
  permission: Permission,
  read: () => Promise<T>,
  fallback: T,
): Promise<T> {
  return can(ctx, permission) ? read() : fallback
}

export type AccountOption = { id: string; number: string; name: string; type: string }

/** The chart of accounts a categorization suggestion may choose from. */
export async function accountOptions(ctx: ActorContext): Promise<AccountOption[]> {
  return ifPermitted(
    ctx,
    'bookkeeping:view',
    async () =>
      db
        .select({
          id: chartAccounts.id,
          number: chartAccounts.number,
          name: chartAccounts.name,
          type: chartAccounts.type,
        })
        .from(chartAccounts)
        .where(scoped(ctx, chartAccounts, eq(chartAccounts.isActive, true)))
        .orderBy(chartAccounts.number),
    [],
  )
}

export type TransactionContext = {
  id: string
  postedDate: string
  description: string
  merchantName: string | null
  amountCents: number
}

/** One transaction, by id, or null if it is not this company's. */
export async function transactionContext(
  ctx: ActorContext,
  transactionId: string,
): Promise<TransactionContext | null> {
  if (!can(ctx, 'bookkeeping:view')) return null

  const [row] = await db
    .select({
      id: bankTransactions.id,
      postedDate: bankTransactions.postedDate,
      description: bankTransactions.description,
      merchantName: bankTransactions.merchantName,
      amountCents: bankTransactions.amountCents,
    })
    .from(bankTransactions)
    .where(scoped(ctx, bankTransactions, eq(bankTransactions.id, transactionId)))
    .limit(1)

  return row ?? null
}

/** Recent activity for the anomaly review. */
export async function recentTransactions(
  ctx: ActorContext,
  limit = 120,
): Promise<TransactionContext[]> {
  return ifPermitted(
    ctx,
    'bookkeeping:view',
    async () =>
      db
        .select({
          id: bankTransactions.id,
          postedDate: bankTransactions.postedDate,
          description: bankTransactions.description,
          merchantName: bankTransactions.merchantName,
          amountCents: bankTransactions.amountCents,
        })
        .from(bankTransactions)
        .where(
          scoped(
            ctx,
            bankTransactions,
            ne(bankTransactions.reviewState, 'excluded'),
          ),
        )
        .orderBy(desc(bankTransactions.postedDate))
        .limit(limit),
    [],
  )
}

export type InboxShape = {
  uncategorizedCount: number
  /**
   * What is waiting, one line per currency (Phase 129).
   *
   * A single total was a sum of `amount_cents` across every account, and an
   * account can be foreign — so a company banking in euros and dollars got the
   * two added together and handed to the assistant, which stated the result
   * with a dollar sign. Phase 122's defect, reaching a person through a
   * sentence rather than a report.
   *
   * Grouping is the only honest repair here: these rows have **not posted**,
   * so unlike everywhere else there is no functional twin to sum instead. A
   * transaction still in the inbox has been converted by nobody.
   */
  uncategorizedTotals: Array<{ currency: string; cents: number }>
  topMerchants: Array<{ name: string; count: number }>
}

/** What the transaction inbox looks like right now, for the summary. */
export async function inboxShape(ctx: ActorContext): Promise<InboxShape> {
  return ifPermitted(
    ctx,
    'bookkeeping:view',
    async () => {
      const totals = await db
        .select({
          currency: financialAccounts.currency,
          count: sql<string>`count(*)`,
          total: sql<string>`coalesce(sum(${bankTransactions.amountCents}), 0)`,
        })
        .from(bankTransactions)
        .innerJoin(
          financialAccounts,
          eq(financialAccounts.id, bankTransactions.financialAccountId),
        )
        .where(
          scoped(
            ctx,
            bankTransactions,
            inArray(bankTransactions.reviewState, ['new', 'suggested', 'needs_review']),
          ),
        )
        .groupBy(financialAccounts.currency)
        .orderBy(financialAccounts.currency)

      const merchants = await db
        .select({
          name: sql<string>`coalesce(${bankTransactions.merchantName}, ${bankTransactions.description})`,
          count: sql<string>`count(*)`,
        })
        .from(bankTransactions)
        .where(
          scoped(
            ctx,
            bankTransactions,
            inArray(bankTransactions.reviewState, ['new', 'suggested', 'needs_review']),
          ),
        )
        .groupBy(sql`coalesce(${bankTransactions.merchantName}, ${bankTransactions.description})`)
        .orderBy(sql`count(*) desc`)
        .limit(5)

      return {
        uncategorizedCount: totals.reduce((sum, row) => sum + Number(row.count), 0),
        uncategorizedTotals: totals.map((row) => ({
          currency: row.currency,
          cents: Number(row.total),
        })),
        topMerchants: merchants.map((row) => ({ name: row.name, count: Number(row.count) })),
      }
    },
    { uncategorizedCount: 0, uncategorizedTotals: [], topMerchants: [] },
  )
}

export type CompanyContext = {
  name: string
  industry: string | null
  tagline: string | null
  /**
   * How the business describes itself, in its own words (Phase 200).
   *
   * `companyProfiles.description` was loaded by nothing and editable nowhere —
   * a column with a schema definition, a service that accepted it and no field
   * on the Design Center form. Phase 200 added the field and this line.
   *
   * It is here beside `tagline` because the two together are the only prose a
   * company writes about itself, and §11 asks the marketing assistant to
   * *adapt content to company voice*. `tagline` had been on this type since
   * Phase 6 and **no caller had ever read it**, which is why adding the data
   * was not enough on its own.
   */
  description: string | null
  services: Array<{ name: string; description: string | null; unitPriceCents: number }>
}

/**
 * The company's own description of itself, for drafting.
 *
 * Gated on `crm:view` rather than a financial permission: the service catalog
 * and profile are what a salesperson already works from, and the prices here
 * are list prices the company publishes, not ledger figures.
 */
export async function companyContext(ctx: ActorContext): Promise<CompanyContext | null> {
  if (!can(ctx, 'crm:view')) return null

  const [row] = await db
    .select({ company: companies, profile: companyProfiles })
    .from(companies)
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, companies.id))
    .where(eq(companies.id, ctx.companyId))
    .limit(1)

  if (!row) return null

  const services = await db
    .select({
      name: serviceItems.name,
      description: serviceItems.description,
      unitPriceCents: serviceItems.unitPriceCents,
    })
    .from(serviceItems)
    .where(scoped(ctx, serviceItems, eq(serviceItems.isActive, true)))
    .limit(20)

  return {
    name: row.profile?.legalName || row.company.name,
    industry: row.company.industry,
    tagline: row.profile?.tagline ?? null,
    description: row.profile?.description ?? null,
    services: services.map((service) => ({
      name: service.name,
      description: service.description,
      unitPriceCents: service.unitPriceCents ?? 0,
    })),
  }
}

/**
 * Renders records as the compact lines a prompt wants.
 *
 * Kept here rather than in each capability so there is one place that decides
 * how much of a record a model is shown. Ids are included because the model
 * must return one; nothing else identifying is.
 */
export function renderAccounts(accounts: AccountOption[]): string {
  return accounts
    .map((account) => `${account.id} | ${account.number} ${account.name} (${account.type})`)
    .join('\n')
}

export function renderTransactions(rows: TransactionContext[]): string {
  return rows
    .map(
      (row) =>
        `${row.id} | ${row.postedDate} | ${row.merchantName ?? row.description} | ${(row.amountCents / 100).toFixed(2)}`,
    )
    .join('\n')
}

/**
 * The company's own words, as the lines a prompt wants (Phase 200).
 *
 * §11's *adapt content to company voice*, and the material to adapt to. Three
 * facts a business stated about itself: what it does, what it says it is, and
 * which industry it is in.
 *
 * ## Why this is a block and not three placeholders
 *
 * Empty is the common case — a company that has not opened the Design Center
 * has none of it — and three placeholders would render as three blank labelled
 * lines, which a model then has to explain. One block that is **absent when
 * there is nothing in it** is the same choice Phase 195 made for the
 * comparison figures, for the same reason.
 *
 * The services catalogue is deliberately **not** in here. It is a price list,
 * it already has its own placeholder in the proposal prompt, and voice is what
 * a business says about itself rather than what it sells — the conflation is
 * why `proposal.draft` v1 could say *"write in the company's voice"* while
 * being given nothing but a catalogue.
 */
export function renderVoice(context: CompanyContext | null): string {
  if (!context) return ''

  /*
    The company's own *words*, and `industry` is deliberately not one of them.

    An industry is picked from a list at registration — by us, to choose a
    chart of accounts — so it is a classification rather than something the
    business said. Including it made this block never empty, because every
    company has one, which defeated the whole point of a section that is absent
    when there is nothing in it. The proposal prompt already has its own
    `{{industryLine}}`.

    Found by the assertion that this is empty for a company which has written
    nothing: it failed, and the reason was a field nobody typed.
  */
  const lines = [
    context.tagline ? `They describe themselves as: ${context.tagline}` : null,
    context.description ? `In their own words: ${context.description}` : null,
  ].filter((line): line is string => line !== null)

  if (lines.length === 0) return ''

  return `\n\nHow this business talks about itself:\n${lines.join('\n')}`
}

export function renderServices(services: CompanyContext['services']): string {
  return services
    .map(
      (service) =>
        `• ${service.name}${service.description ? ` — ${service.description}` : ''}`,
    )
    .join('\n')
}
