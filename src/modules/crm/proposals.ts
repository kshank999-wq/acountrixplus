import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  companies,
  companyProfiles,
  opportunities,
  organizations,
  proposalItems,
  proposalScheduleStages,
  proposalVersions,
  proposalViews,
  proposals,
} from '@/db/schema'
import { brandKits, designDocuments } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { letterheadFor } from '@/modules/brand/letterhead'
import { partiesFor } from './parties'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { logActivity } from './opportunities'
import { snapshotProposalPdf } from '@/modules/pdf/service'
import { PIPELINE_STAGES, STAGE_PROBABILITY, stageIndex } from './pipeline'
import { Refusal } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'
import { scheduleStands, type ScheduleStage } from './billing-schedule'

/**
 * Proposal lifecycle (spec §7 commercial structure, §9 statuses).
 *
 * Phase 3 covers pricing, statuses, versioning, and view tracking. The visual
 * designer is Phase 4; it will attach layout to these records rather than
 * replacing them, which is why the narrative sections are plain text for now.
 */

export type ProposalStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'won'
  | 'lost'
  | 'expired'
  | 'no_decision'

export type ProposalItemInput = {
  description: string
  quantityMilli?: number
  unitPriceCents: number
  isOptional?: boolean
  isSelected?: boolean
  chartAccountId?: string | null
  /**
   * The catalogue item this line was priced from (Phase 168, spec §9).
   *
   * Optional, because a line typed by hand is a real line — a business quoting
   * something new should not have to add a catalogue entry first. Null means
   * nobody recorded which product it was, and `serviceBreakdown` reports those
   * lines under their own heading rather than dropping them.
   */
  itemId?: string | null
}

/** Extended amount for a line, rounded half-up to the nearest cent. */
export function itemAmountCents(quantityMilli: number, unitPriceCents: number): number {
  return Math.round((quantityMilli * unitPriceCents) / 1000)
}

/**
 * Proposal totals.
 *
 * Optional items count only when selected (spec §7), so the total always
 * reflects what the client would actually owe.
 */
export function computeTotals(
  items: Array<{ amountCents: number; isOptional: boolean; isSelected: boolean }>,
  opts: { discountCents?: number; taxCents?: number } = {},
) {
  const subtotalCents = items
    .filter((item) => !item.isOptional || item.isSelected)
    .reduce((sum, item) => sum + item.amountCents, 0)

  const discountCents = opts.discountCents ?? 0
  const taxCents = opts.taxCents ?? 0

  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  }
}

/** 32 random bytes: the client link must not be guessable from another. */
function newPublicToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * The probability an opportunity should carry at `stage`, honouring a manual
 * override. Expressed in SQL so a stage advance and its probability move in
 * one statement.
 */
function stageProbabilitySql(stage: keyof typeof STAGE_PROBABILITY) {
  return sql<number>`CASE WHEN ${opportunities.probabilityOverridden}
                          THEN ${opportunities.probability}
                          ELSE ${STAGE_PROBABILITY[stage]} END`
}

export async function createProposal(
  ctx: ActorContext,
  input: {
    opportunityId: string
    title: string
    items: ProposalItemInput[]
    discountCents?: number
    taxCents?: number
    executiveSummary?: string
    scope?: string
    deliverables?: string
    exclusions?: string
    assumptions?: string
    terms?: string
    expiresOn?: string
    number?: string
  },
) {
  requirePermission(ctx, 'proposals:manage')

  const [opportunity] = await db
    .select()
    .from(opportunities)
    .where(scoped(ctx, opportunities, eq(opportunities.id, input.opportunityId)))
    .limit(1)

  if (!opportunity) throw missing('opportunity')
  if (input.items.length === 0) throw new Refusal('A proposal needs at least one line item.')

  const items = input.items.map((item, index) => {
    const quantityMilli = item.quantityMilli ?? 1000
    return {
      description: item.description,
      quantityMilli,
      unitPriceCents: item.unitPriceCents,
      amountCents: itemAmountCents(quantityMilli, item.unitPriceCents),
      isOptional: item.isOptional ?? false,
      isSelected: item.isSelected ?? true,
      chartAccountId: item.chartAccountId ?? null,
      itemId: item.itemId ?? null,
      sortOrder: index,
    }
  })

  const totals = computeTotals(items, input)

  return db.transaction(async (tx) => {
    const number = input.number ?? (await nextProposalNumber(ctx, tx))

    const [proposal] = await tx
      .insert(proposals)
      .values({
        companyId: ctx.companyId,
        opportunityId: input.opportunityId,
        number,
        title: input.title,
        status: 'draft',
        ...totals,
        executiveSummary: input.executiveSummary ?? null,
        scope: input.scope ?? null,
        deliverables: input.deliverables ?? null,
        exclusions: input.exclusions ?? null,
        assumptions: input.assumptions ?? null,
        terms: input.terms ?? null,
        publicToken: newPublicToken(),
        expiresOn: input.expiresOn ?? null,
        createdBy: ctx.userId,
      })
      .returning()

    await tx.insert(proposalItems).values(
      items.map((item) => ({ companyId: ctx.companyId, proposalId: proposal.id, ...item })),
    )

    await logActivity(
      ctx,
      input.opportunityId,
      { kind: 'proposal_created', summary: `Proposal ${number} drafted` },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'proposal.create',
        entityType: 'proposal',
        entityId: proposal.id,
        after: { number, title: input.title, totalCents: totals.totalCents },
      },
      tx,
    )

    return proposal
  })
}

/**
 * Marks a proposal as sent and snapshots it (spec §7).
 *
 * The snapshot is what makes the client-facing link trustworthy: once someone
 * has been shown a price, editing the proposal produces a new version rather
 * than silently changing what they were quoted. It also moves the opportunity
 * to `proposal_sent`, so the pipeline reflects reality without a second step.
 */
export async function sendProposal(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)
  if (proposal.status === 'won' || proposal.status === 'lost') {
    throw new Refusal('That proposal has already been decided.')
  }

  const items = await db
    .select()
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(asc(proposalItems.sortOrder))

  // Who the two parties are, read now and frozen below (Phase 77). Every other
  // fact about this send is already frozen; this one was resolved live on every
  // later read, so renaming either side rewrote agreements already signed.
  const parties = await partiesAtSend(ctx, proposalId)

  // The document and the colours it was sent in (Phase 188). Read before the
  // transaction, with everything else that is about to be frozen.
  const [document] = await db
    .select()
    .from(designDocuments)
    .where(scoped(ctx, designDocuments, eq(designDocuments.proposalId, proposalId)))
    .limit(1)

  const [kitAtSend] = document?.brandKitId
    ? await db
        .select()
        .from(brandKits)
        .where(scoped(ctx, brandKits, eq(brandKits.id, document.brandKitId)))
        .limit(1)
    : []

  const brandAtSend = kitAtSend
    ? {
        primaryColor: kitAtSend.primaryColor,
        accentColor: kitAtSend.accentColor,
        textColor: kitAtSend.textColor,
        mutedColor: kitAtSend.mutedColor,
        surfaceColor: kitAtSend.surfaceColor,
        headingFont: kitAtSend.headingFont,
        bodyFont: kitAtSend.bodyFont,
        baseSizePt: kitAtSend.baseSizePt,
        logoAssetId: kitAtSend.logoAssetId,
      }
    : null

  return db.transaction(async (tx) => {
    const [{ nextVersion }] = await tx
      .select({ nextVersion: sql<number>`coalesce(max(${proposalVersions.versionNumber}), 0) + 1` })
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposalId))

    // One timestamp for the whole send, used for the version row *and* stamped
    // into the PDF. Two calls to `new Date()` would differ by milliseconds and
    // make the rendered bytes irreproducible, which is the one thing this
    // document must not be.
    const sentAt = new Date()

    const [version] = await tx.insert(proposalVersions).values({
      companyId: ctx.companyId,
      proposalId,
      versionNumber: nextVersion,
      snapshot: {
        title: proposal.title,
        number: proposal.number,
        executiveSummary: proposal.executiveSummary,
        scope: proposal.scope,
        // All six since Phase 182. A version exists so a sent proposal's
        // wording cannot change under the client, and two sections left out of
        // the snapshot would be two sections that could.
        deliverables: proposal.deliverables,
        exclusions: proposal.exclusions,
        assumptions: proposal.assumptions,
        terms: proposal.terms,
        subtotalCents: proposal.subtotalCents,
        discountCents: proposal.discountCents,
        taxCents: proposal.taxCents,
        totalCents: proposal.totalCents,
        expiresOn: proposal.expiresOn,
        items: items.map((item) => ({
          /*
            The id, since Phase 188.

            A client ticking an optional line sends its id back, and the
            acceptance has to recognise it. Matching against the **live** rows
            was the old answer and it is why a figure nobody was sent could be
            signed for: `updateProposalItems` deletes and reinserts, so after
            an edit the live ids are different ids for different prices.

            With the ids in here, the whole acceptance — which lines exist,
            which may be chosen, what each costs — is answered by the version
            the client is actually looking at.
          */
          id: item.id,
          description: item.description,
          quantityMilli: item.quantityMilli,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          isOptional: item.isOptional,
          isSelected: item.isSelected,
        })),
        /*
          The document, since Phase 188 (ADR 0021's seventh decision, finally).

          Its heading read *"the public link serves the snapshot, never a live
          render"* and the paragraph under it said the client *downloads* what
          they were sent — which was true of the PDF and of nothing else. The
          page served live blocks and a live brand kit, so Phase 21's own
          argument, that *"restyling proposals in June silently restyled every
          proposal ever sent"*, stayed true of the thing a client opens.

          The blocks are stored resolved-as-stored rather than merge-filled:
          the merge context is rebuilt at read time from the same frozen
          figures, so a client's name is current and the numbers are not.
        */
        document: document
          ? {
              blocks: document.blocks,
              pageSize: document.pageSize,
              orientation: document.orientation,
              marginTopPt: document.marginTopPt,
              marginRightPt: document.marginRightPt,
              marginBottomPt: document.marginBottomPt,
              marginLeftPt: document.marginLeftPt,
              headerText: document.headerText,
              footerText: document.footerText,
              brand: brandAtSend,
            }
          : null,
      },
      parties,
      totalCents: proposal.totalCents,
      sentAt,
      sentBy: ctx.userId,
    }).returning({ id: proposalVersions.id })

    // Rendered inside the transaction that records the send, so a proposal is
    // never marked sent without the document the client was sent. Doing it
    // afterwards leaves a window in which the client has the link and the
    // snapshot does not exist — which is exactly the window in which somebody
    // edits the price list.
    const snapshot = await snapshotProposalPdf(
      ctx,
      { proposalId, versionId: version.id, sentAt },
      tx,
    )

    const [updated] = await tx
      .update(proposals)
      .set({ status: 'sent', sentAt, updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, ctx.companyId)))
      .returning()

    // Keep the pipeline honest without making the user do it twice — but only
    // ever forwards. Resending a revised proposal to a deal already in
    // negotiation must not drag it back to "proposal sent", which would both
    // misstate where the deal is and reset its forecast weight.
    const earlierStages = PIPELINE_STAGES.slice(0, stageIndex('proposal_sent')).map((s) => s.key)

    await tx
      .update(opportunities)
      .set({
        stage: 'proposal_sent',
        // Follows the stage, unless a hand-set probability says otherwise —
        // the same rule `changeStage` applies.
        probability: stageProbabilitySql('proposal_sent'),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(opportunities.id, proposal.opportunityId),
          eq(opportunities.companyId, ctx.companyId),
          inArray(opportunities.stage, earlierStages),
        ),
      )

    await logActivity(
      ctx,
      proposal.opportunityId,
      {
        kind: 'proposal_sent',
        summary: `Proposal ${proposal.number} sent (version ${nextVersion})`,
      },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'proposal.send',
        entityType: 'proposal',
        entityId: proposalId,
        before: { status: proposal.status },
        after: {
          status: 'sent',
          version: nextVersion,
          totalCents: proposal.totalCents,
          // The digest is the point: it is what proves, later, that the file a
          // client downloads is the file that was rendered at this moment.
          pdfDigest: snapshot?.digest ?? null,
        },
      },
      tx,
    )

    return {
      proposal: updated,
      versionNumber: nextVersion,
      versionId: version.id,
      /** Null when the proposal had no design document to render. */
      pdfDocumentId: snapshot?.documentId ?? null,
    }
  })
}

/**
 * Records a client view of the proposal link (spec §9).
 *
 * Called from the public route, so it takes no actor: the viewer is the
 * client, not a user of the system. It only ever appends a view and advances
 * `sent` to `viewed` — it cannot change pricing or status beyond that.
 */
export async function recordView(
  publicToken: string,
  meta: { ipPrefix?: string | null; userAgent?: string | null },
) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal) return null

  await db.transaction(async (tx) => {
    await tx.insert(proposalViews).values({
      companyId: proposal.companyId,
      proposalId: proposal.id,
      ipPrefix: meta.ipPrefix ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })

    await tx
      .update(proposals)
      .set({
        // Only 'sent' advances; a decided proposal keeps its outcome.
        status: proposal.status === 'sent' ? 'viewed' : proposal.status,
        firstViewedAt: proposal.firstViewedAt ?? new Date(),
        lastViewedAt: new Date(),
        viewCount: proposal.viewCount + 1,
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, proposal.id))

    if (proposal.status === 'sent') {
      await tx
        .update(opportunities)
        .set({
          stage: 'viewed',
          probability: stageProbabilitySql('viewed'),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(opportunities.id, proposal.opportunityId),
            eq(opportunities.companyId, proposal.companyId),
            // Forward only: a deal already past "viewed" stays where it is.
            eq(opportunities.stage, 'proposal_sent'),
          ),
        )
    }
  })

  return proposal
}

/**
 * Records the client's decision on a proposal (spec §9).
 *
 * **`expired` is deliberately not one of the statuses this accepts** (Phase
 * 195). Expiry is a function of the clock rather than a judgement somebody
 * makes, and `lapseExpiredProposals` below is its only writer. Leaving it here
 * would have meant two writers of one status with different side effects: this
 * function stamps `decided_at`, and a lapse must not, because §9's *"average
 * time to decision"* counts every proposal carrying both timestamps and a
 * deadline passing is the absence of a decision rather than a fast one.
 *
 * Somebody who wants to close a lapsed proposal by hand has `no_decision`,
 * which is what that is. The buttons on the proposal list have always offered
 * exactly the three this accepts.
 */
export async function decideProposal(
  ctx: ActorContext,
  proposalId: string,
  status: 'won' | 'lost' | 'no_decision',
) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)
  if (proposal.status === 'draft') {
    throw new Refusal('Send the proposal before recording a decision on it.')
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(proposals)
      .set({ status, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, ctx.companyId)))
      .returning()

    await logActivity(
      ctx,
      proposal.opportunityId,
      { kind: 'proposal_decided', summary: `Proposal ${proposal.number} marked ${status}` },
      tx,
    )

    await recordAudit(
      ctx,
      {
        action: 'proposal.decide',
        entityType: 'proposal',
        entityId: proposalId,
        before: { status: proposal.status },
        after: { status },
      },
      tx,
    )

    return updated
  })
}

/**
 * Moves proposals past their validity date to `expired` (Phase 195, spec §9).
 *
 * ## The status nobody wrote
 *
 * §9's first bullet asks for *"proposal counts and value by Draft, Sent,
 * Viewed, Won, Lost, Expired, and No Decision"*, and `proposalStatusEnum` has
 * carried all seven since Phase 3. Measured in Phase 195, **six were
 * reachable**: nothing in the application ever set `expired`.
 *
 * Every part of the answer was already here. `proposals.expires_on` is
 * recorded, the client-facing page has refused a lapsed proposal by comparing
 * it against today since Phase 3 (`acceptance.ts`), and `serviceBreakdown`
 * already classifies `expired` alongside `lost`. What was missing is the one
 * write that makes the company's own reporting agree with what its client is
 * already being told — the dashboard counted a lapsed proposal as `sent`, open
 * and awaiting a reply, while the link it was sent on said it had expired.
 *
 * That is this project's two-documents defect in its usual shape, and the
 * usual shape of the last six phases besides: Phase 192's build nobody ran,
 * Phase 193's function nobody called, Phase 194's price nobody re-read, and
 * now a status nobody wrote.
 *
 * ## Why a sweep rather than a derived read
 *
 * Deriving it at every reader would mean each one remembering the comparison,
 * and `byStatus` is a `group by` — it cannot apply a per-row predicate without
 * becoming a different query. The project already answers this exact question
 * for payments: `payments.sweep_checkouts` writes `status = 'expired'` on
 * checkouts nobody came back from, and the service re-checks the date on read
 * anyway. `isAcceptable` is that re-check here, and it stays, because a client
 * can open the link in the hour before a sweep runs.
 *
 * `decided_at` is left alone, for the reason given on `decideProposal`.
 *
 * The opportunity is **not** moved. A proposal lapsing is not a deal lost: a
 * revised proposal on the same opportunity is the ordinary next step, and
 * `sendProposal` already advances the stage when one goes out. Closing the
 * opportunity is a judgement, and §9 has `lossReasons` for recording it.
 */
export async function lapseExpiredProposals(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<{ lapsed: number; numbers: string[] }> {
  requirePermission(ctx, 'proposals:manage')

  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)

  /*
    `lt` rather than `lte`: `expires_on` is the last day the proposal is good
    for, which is how `isAcceptable` reads it. A proposal expiring today is
    still acceptable today, and the two must not disagree by a day.
  */
  const candidates = await db
    .select({
      id: proposals.id,
      number: proposals.number,
      status: proposals.status,
      opportunityId: proposals.opportunityId,
    })
    .from(proposals)
    .where(
      scoped(
        ctx,
        proposals,
        inArray(proposals.status, ['sent', 'viewed']),
        isNotNull(proposals.expiresOn),
        lt(proposals.expiresOn, asOf),
      ),
    )

  const numbers: string[] = []

  for (const { id: proposalId, number, status, opportunityId } of candidates) {
    /*
      Read first and then written one row at a time, so the audit trail can
      say which status each proposal came *from* — `viewed` and `sent` are
      different facts about whether the client ever opened it, and a
      before/after record that guessed would be worse than none.

      The status guard is repeated on the write, as the checkout sweep does:
      if a decision landed between the read and here, that write wins and the
      database arbitrates.

      Destructured to `proposalId` rather than written as `proposal.id`, and
      not only for the reading: `modules/source/isolation-scan` counts a write
      as keyed when its `where` matches `eq(x.y, input.z)` or `eq(x.y, zId)`,
      so a write keyed by a local row's `.id` is **absent from the census**
      that §19's isolation claim is argued from. This one is tenant-filtered
      either way; the naming is what makes it visible. The scanner's blind spot
      is a finding in its own right and ADR 0195 nominates it.
    */
    const [updated] = await db
      .update(proposals)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(proposals.id, proposalId),
          eq(proposals.companyId, ctx.companyId),
          eq(proposals.status, status),
        ),
      )
      .returning({ id: proposals.id })

    if (!updated) continue

    await logActivity(ctx, opportunityId, {
      kind: 'proposal_decided',
      summary: `Proposal ${number} expired without a decision`,
    })

    await recordAudit(ctx, {
      action: 'proposal.expire',
      entityType: 'proposal',
      entityId: proposalId,
      before: { status },
      after: { status: 'expired', asOf },
    })

    numbers.push(number)
  }

  return { lapsed: numbers.length, numbers }
}

/** Replaces a draft proposal's line items and recomputes its totals. */
export async function updateProposalItems(
  ctx: ActorContext,
  proposalId: string,
  items: ProposalItemInput[],
  opts: { discountCents?: number; taxCents?: number } = {},
) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)
  if (items.length === 0) throw new Refusal('A proposal needs at least one line item.')

  const prepared = items.map((item, index) => {
    const quantityMilli = item.quantityMilli ?? 1000
    return {
      description: item.description,
      quantityMilli,
      unitPriceCents: item.unitPriceCents,
      amountCents: itemAmountCents(quantityMilli, item.unitPriceCents),
      isOptional: item.isOptional ?? false,
      isSelected: item.isSelected ?? true,
      chartAccountId: item.chartAccountId ?? null,
      itemId: item.itemId ?? null,
      sortOrder: index,
    }
  })

  const totals = computeTotals(prepared, {
    discountCents: opts.discountCents ?? proposal.discountCents,
    taxCents: opts.taxCents ?? proposal.taxCents,
  })

  return db.transaction(async (tx) => {
    await tx
      .delete(proposalItems)
      .where(
        and(
          eq(proposalItems.proposalId, proposalId),
          eq(proposalItems.companyId, ctx.companyId),
        ),
      )

    await tx.insert(proposalItems).values(
      prepared.map((item) => ({ companyId: ctx.companyId, proposalId, ...item })),
    )

    const [updated] = await tx
      .update(proposals)
      .set({ ...totals, updatedAt: new Date() })
      .where(and(eq(proposals.id, proposalId), eq(proposals.companyId, ctx.companyId)))
      .returning()

    await recordAudit(
      ctx,
      {
        action: 'proposal.update',
        entityType: 'proposal',
        entityId: proposalId,
        before: { totalCents: proposal.totalCents },
        after: { totalCents: totals.totalCents, lineCount: prepared.length },
      },
      tx,
    )

    return updated
  })
}

/**
 * Both parties to a proposal, as they stand at this instant (Phase 77).
 *
 * Called once per send and written into the version. The client is reached
 * through the opportunity, which is where a proposal's counterparty has lived
 * since Phase 3; the company through Phase 75's letterhead, so the names on the
 * record are the same names the document prints.
 *
 * A proposal whose opportunity or organisation has since gone gets a party with
 * no name rather than a failed send — the agreement still happened, and the
 * record of it should say what it can.
 */
async function partiesAtSend(ctx: ActorContext, proposalId: string) {
  const [row] = await db
    .select({
      company: companies,
      profile: companyProfiles,
      client: organizations,
    })
    .from(proposals)
    .innerJoin(companies, eq(companies.id, proposals.companyId))
    .leftJoin(companyProfiles, eq(companyProfiles.companyId, proposals.companyId))
    .leftJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .leftJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  if (!row) throw missing('proposal')

  return partiesFor({
    letterhead: letterheadFor({ companyName: row.company.name, profile: row.profile }),
    client: row.client,
  })
}

async function loadProposal(ctx: ActorContext, proposalId: string) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  if (!proposal) throw missing('proposal')
  return proposal
}

export async function getProposal(ctx: ActorContext, proposalId: string) {
  requirePermission(ctx, 'proposals:view')

  const proposal = await loadProposal(ctx, proposalId)
  const items = await db
    .select()
    .from(proposalItems)
    .where(scoped(ctx, proposalItems, eq(proposalItems.proposalId, proposalId)))
    .orderBy(asc(proposalItems.sortOrder))

  const versions = await db
    .select({
      versionNumber: proposalVersions.versionNumber,
      totalCents: proposalVersions.totalCents,
      sentAt: proposalVersions.sentAt,
    })
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposalId))
    .orderBy(desc(proposalVersions.versionNumber))

  return { proposal, items, versions }
}

export async function listProposals(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'proposals:view')

  return db
    .select({
      id: proposals.id,
      number: proposals.number,
      title: proposals.title,
      status: proposals.status,
      totalCents: proposals.totalCents,
      sentAt: proposals.sentAt,
      viewCount: proposals.viewCount,
      lastViewedAt: proposals.lastViewedAt,
      expiresOn: proposals.expiresOn,
      opportunityId: proposals.opportunityId,
      organizationName: organizations.name,
      publicToken: proposals.publicToken,
    })
    .from(proposals)
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(scoped(ctx, proposals))
    .orderBy(desc(proposals.updatedAt))
    .limit(opts.limit ?? 200)
}

/** The public, read-only shape shown at the client-facing link. */
export async function proposalByToken(publicToken: string) {
  const [row] = await db
    .select({
      proposal: proposals,
      organizationName: organizations.name,
    })
    .from(proposals)
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .innerJoin(organizations, eq(organizations.id, opportunities.organizationId))
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!row) return null

  const items = await db
    .select()
    .from(proposalItems)
    .where(eq(proposalItems.proposalId, row.proposal.id))
    .orderBy(asc(proposalItems.sortOrder))

  return { ...row, items }
}

async function nextProposalNumber(ctx: ActorContext, tx: Executor): Promise<string> {
  const [row] = await tx
    .select({ count: sql<string>`count(*)` })
    .from(proposals)
    .where(eq(proposals.companyId, ctx.companyId))

  return `PROP-${1001 + Number(row?.count ?? 0)}`
}

/**
 * The billing schedule on a proposal (spec §6, §7, Phase 154).
 *
 * Stored as rows and read in order. `scheduleStands` is the gate rather than the
 * database: the refusals are sentences somebody editing a proposal has to read,
 * and "the stages must come to 100%" is not something a CHECK across rows can
 * say in those words.
 */
export async function setBillingSchedule(
  ctx: ActorContext,
  proposalId: string,
  stages: readonly ScheduleStage[],
) {
  requirePermission(ctx, 'proposals:manage')

  const proposal = await loadProposal(ctx, proposalId)

  // An empty schedule is how a proposal says "bill it the old way", so it is
  // cleared rather than refused. `scheduleStands` refuses an empty *schedule*,
  // which is a different question: it is asked of stages somebody has written.
  if (stages.length > 0) {
    const verdict = scheduleStands(stages)
    if (!verdict.ok) throw new Refusal(verdict.why)
  }

  /**
   * Not over the top of a stage that has been invoiced (Phase 156).
   *
   * This function is `delete` then `insert`, and Phase 155 left it that way on a
   * part-billed contract: it dropped the rows holding `invoice_id`, reinserted
   * them null, left the invoices orphaned, and let `billStage` charge the same
   * stage a second time. Reachable from the screen that phase added, which
   * offers the Billing schedule button on any proposal — won and part-billed
   * included.
   *
   * Checked before the transaction rather than inside it: nothing here should
   * have started deleting before the question was asked.
   */
  const { scheduleMayBeReplaced } = await import('./billing-schedule')
  const current = await stageStatesFor(ctx, proposal.id)
  const replaceable = scheduleMayBeReplaced(current, stages)
  if (!replaceable.ok) throw new Refusal(replaceable.why)

  return db.transaction(async (tx) => {
    await tx
      .delete(proposalScheduleStages)
      .where(
        scoped(ctx, proposalScheduleStages, eq(proposalScheduleStages.proposalId, proposal.id)),
      )

    if (stages.length > 0) {
      await tx.insert(proposalScheduleStages).values(
        stages.map((stage, index) => ({
          companyId: ctx.companyId,
          proposalId: proposal.id,
          label: stage.label.trim(),
          kind: stage.kind,
          percentBp: stage.percentBp,
          sortOrder: index,
        })),
      )
    }

    await recordAudit(
      ctx,
      {
        action: 'proposal.schedule',
        entityType: 'proposal',
        entityId: proposal.id,
        after: { stages: stages.map((s) => ({ label: s.label, kind: s.kind, bp: s.percentBp })) },
      },
      tx,
    )

    return { stages: stages.length }
  })
}

/** The schedule a proposal carries, in order. Empty when it has none. */
export async function billingSchedule(
  ctx: ActorContext,
  proposalId: string,
  exec: Executor = db,
): Promise<ScheduleStage[]> {
  const rows = await exec
    .select({
      label: proposalScheduleStages.label,
      kind: proposalScheduleStages.kind,
      percentBp: proposalScheduleStages.percentBp,
    })
    .from(proposalScheduleStages)
    .where(scoped(ctx, proposalScheduleStages, eq(proposalScheduleStages.proposalId, proposalId)))
    .orderBy(asc(proposalScheduleStages.sortOrder))

  return rows.map((row) => ({
    label: row.label,
    kind: row.kind as ScheduleStage['kind'],
    percentBp: row.percentBp,
  }))
}

/**
 * Every proposal's schedule in one query, for the list (Phase 154).
 *
 * The list shows all of them and a per-proposal read would be one query per row
 * — the shape `sentVersions` exists to avoid for the same screen.
 */
export async function schedulesFor(
  ctx: ActorContext,
  exec: Executor = db,
): Promise<Map<string, Array<ScheduleStage & { invoiceId: string | null }>>> {
  requirePermission(ctx, 'proposals:view')

  const rows = await exec
    .select({
      proposalId: proposalScheduleStages.proposalId,
      label: proposalScheduleStages.label,
      kind: proposalScheduleStages.kind,
      percentBp: proposalScheduleStages.percentBp,
      // What has been billed, so the list can show it and offer the next stage
      // without a query per row (Phase 155).
      invoiceId: proposalScheduleStages.invoiceId,
    })
    .from(proposalScheduleStages)
    .where(scoped(ctx, proposalScheduleStages))
    .orderBy(asc(proposalScheduleStages.proposalId), asc(proposalScheduleStages.sortOrder))

  const byProposal = new Map<string, Array<ScheduleStage & { invoiceId: string | null }>>()
  for (const row of rows) {
    const stages = byProposal.get(row.proposalId) ?? []
    stages.push({
      label: row.label,
      kind: row.kind as ScheduleStage['kind'],
      percentBp: row.percentBp,
      invoiceId: row.invoiceId,
    })
    byProposal.set(row.proposalId, stages)
  }

  return byProposal
}

/** The opportunity a proposal belongs to, for a worker holding only its id. */
export async function opportunityIdFor(
  ctx: ActorContext,
  proposalId: string,
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ opportunityId: proposals.opportunityId })
    .from(proposals)
    .where(scoped(ctx, proposals, eq(proposals.id, proposalId)))
    .limit(1)

  return row?.opportunityId ?? null
}

/**
 * The stored stages with what has happened to each, for the replace check.
 *
 * Local rather than `stage-invoicing`'s `stageStates`, which imports this file —
 * and unlike that one this needs no pricing, because the question is only which
 * stages carry an invoice.
 */
async function stageStatesFor(ctx: ActorContext, proposalId: string) {
  const rows = await db
    .select({
      label: proposalScheduleStages.label,
      kind: proposalScheduleStages.kind,
      percentBp: proposalScheduleStages.percentBp,
      invoiceId: proposalScheduleStages.invoiceId,
      billedCents: proposalScheduleStages.billedCents,
    })
    .from(proposalScheduleStages)
    .where(scoped(ctx, proposalScheduleStages, eq(proposalScheduleStages.proposalId, proposalId)))
    .orderBy(asc(proposalScheduleStages.sortOrder))

  return rows.map((row) => ({
    label: row.label,
    kind: row.kind as ScheduleStage['kind'],
    percentBp: row.percentBp,
    // Not priced: `scheduleMayBeReplaced` asks only which stages were invoiced.
    amountCents: row.billedCents ?? 0,
    earnsRevenue: row.kind !== 'deposit',
    invoiceId: row.invoiceId,
    billedCents: row.billedCents,
  }))
}
