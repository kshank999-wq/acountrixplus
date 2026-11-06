import { and, desc, eq } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  brandKits,
  designDocuments,
  proposalItems,
  proposalVersions,
  proposalViews,
  proposals,
} from '@/db/schema'
import type { BrandTokens } from '@/components/design/document-render'

/**
 * What a client is looking at (Phase 188, spec §7).
 *
 * ## ADR 0021's seventh decision was a heading, not a fact
 *
 * > ### Decision 7: the public link serves the snapshot, never a live render
 *
 * The paragraph under that heading says a client *"downloads what they were
 * sent"*, which was true — `/p/<token>/pdf` serves the issued bytes. The
 * heading claims something larger, and `README.md` copied the heading.
 *
 * The page served **live rows**: live `proposal_items`, live `discountCents`
 * and `taxCents`, live `designDocuments.blocks`, live `brandKits`. And
 * `updateProposalItems` asks for `proposals:manage` and checks no status — the
 * designer's `isEditable` is a property of that screen, not of the system.
 *
 * Measured rather than reasoned about. Send at £1,000, edit the items to
 * £1,200, and:
 *
 * - the client's page shows £1,200 while the PDF in their inbox says £1,000;
 * - `acceptProposal` recomputes server-side, correctly refusing to trust the
 *   browser's total, and records **£1,200**;
 * - the acceptance is filed against version 1, whose snapshot says £1,000.
 *
 * A signature on a figure the client was never sent, attached to a document
 * that says a different number, with nothing anywhere reporting it.
 *
 * ## One function, because two readers is how this happened
 *
 * The page, the acceptance and the PDF each assembled their own view of "the
 * proposal" from whatever rows were nearest. That is the shape of the defect
 * rather than an accident of it: three readers of one question will answer it
 * three ways eventually, and here two of them already did.
 *
 * So everything a client may see comes from here, out of the version they were
 * sent. `acceptProposal` reads the same function, which is what makes the
 * total it records and the total on the page the same number by construction.
 *
 * ## What stays live, on purpose
 *
 * Three things, and each is a fact about *now* rather than about what was
 * offered: whether the proposal has since been decided, what questions have
 * been asked and answered on it, and the client's own name in a merge field.
 * Freezing those would be freezing the wrong thing — a client should not be
 * told a proposal is open after it was withdrawn.
 */

/** A line as it was sent, with the id a client's selection refers to. */
export type SentItem = {
  id: string
  description: string
  quantityMilli: number
  unitPriceCents: number
  amountCents: number
  isOptional: boolean
  isSelected: boolean
}

export type ClientFacingProposal = {
  proposalId: string
  companyId: string
  versionId: string
  versionNumber: number
  sentAt: Date
  /** Live: a withdrawn proposal must not still say "open". */
  status: string
  items: SentItem[]
  totals: {
    subtotalCents: number
    discountCents: number
    taxCents: number
    totalCents: number
  }
  expiresOn: string | null
  blocks: unknown
  brand: BrandTokens | null
  setup: {
    pageSize: string
    orientation: string
    marginTopPt: number
    marginRightPt: number
    marginBottomPt: number
    marginLeftPt: number
    headerText: string | null
    footerText: string | null
  } | null
  /**
   * Whether the figures came from the version rather than the live record.
   *
   * Always true for a version written from Phase 188 onward. False means the
   * snapshot predates the id being stored, and the acceptance has to match the
   * client's selections against live rows — which is the old behaviour, kept
   * for the rows that already exist and **reported** rather than hidden.
   */
  itemsFromSnapshot: boolean
  /** As above, for the blocks and the brand. */
  documentFromSnapshot: boolean
}

type SnapshotItem = Partial<SentItem>

type Snapshot = {
  subtotalCents?: number
  discountCents?: number
  taxCents?: number
  totalCents?: number
  expiresOn?: string | null
  items?: SnapshotItem[]
  document?: {
    blocks?: unknown
    pageSize?: string
    orientation?: string
    marginTopPt?: number
    marginRightPt?: number
    marginBottomPt?: number
    marginLeftPt?: number
    headerText?: string | null
    footerText?: string | null
    brand?: BrandTokens | null
  } | null
}

/**
 * The proposal a public token opens, as it was sent.
 *
 * `null` for a token that names nothing and for a proposal that has never been
 * sent — a draft has no version, and a draft was never reachable here anyway.
 * That second case is asserted rather than assumed, because the old path
 * refused a draft in `proposalByToken` and this one must not quietly start
 * allowing it.
 */
export async function clientFacingProposal(
  publicToken: string,
  exec: Executor = db,
): Promise<ClientFacingProposal | null> {
  const [proposal] = await exec
    .select()
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal || proposal.status === 'draft') return null

  const [version] = await exec
    .select()
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposal.id))
    .orderBy(desc(proposalVersions.versionNumber))
    .limit(1)

  if (!version) return null

  const snapshot = (version.snapshot ?? {}) as Snapshot

  /*
    A snapshot item is usable only if it carries its id. Before Phase 188 it
    did not, so those versions fall back to the live rows — which is the old
    behaviour, and the flag says so rather than letting a caller believe it is
    looking at what was sent.
  */
  const snapshotItems = snapshot.items ?? []
  const itemsFromSnapshot =
    snapshotItems.length > 0 && snapshotItems.every((item) => typeof item.id === 'string')

  const items: SentItem[] = itemsFromSnapshot
    ? snapshotItems.map((item) => ({
        id: item.id!,
        description: item.description ?? '',
        quantityMilli: item.quantityMilli ?? 1000,
        unitPriceCents: item.unitPriceCents ?? 0,
        amountCents: item.amountCents ?? 0,
        isOptional: item.isOptional ?? false,
        isSelected: item.isSelected ?? true,
      }))
    : (
        await exec
          .select()
          .from(proposalItems)
          .where(eq(proposalItems.proposalId, proposal.id))
      ).map((item) => ({
        id: item.id,
        description: item.description,
        quantityMilli: item.quantityMilli,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
        isOptional: item.isOptional,
        isSelected: item.isSelected,
      }))

  const document = snapshot.document ?? null
  const documentFromSnapshot = Boolean(document)

  /*
    The same fallback for the document, and it is the one a reader should be
    most suspicious of: a version written before this phase has no blocks in
    it, so the page shows the live ones — the behaviour this phase exists to
    end. It is kept because the alternative is serving an empty page for every
    proposal sent before today, and it is flagged because a silent fallback to
    the defect is worse than the defect.
  */
  const [liveDocument] = documentFromSnapshot
    ? []
    : await exec
        .select()
        .from(designDocuments)
        .where(eq(designDocuments.proposalId, proposal.id))
        .limit(1)

  const [liveKit] = liveDocument?.brandKitId
    ? await exec.select().from(brandKits).where(eq(brandKits.id, liveDocument.brandKitId)).limit(1)
    : []

  return {
    proposalId: proposal.id,
    companyId: proposal.companyId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    sentAt: version.sentAt,
    status: proposal.status,
    items,
    totals: {
      subtotalCents: snapshot.subtotalCents ?? proposal.subtotalCents,
      discountCents: snapshot.discountCents ?? proposal.discountCents,
      taxCents: snapshot.taxCents ?? proposal.taxCents,
      totalCents: snapshot.totalCents ?? proposal.totalCents,
    },
    expiresOn: snapshot.expiresOn ?? proposal.expiresOn,
    blocks: document?.blocks ?? liveDocument?.blocks ?? [],
    brand: document?.brand ?? (liveKit ? brandTokensOf(liveKit) : null),
    setup: document
      ? {
          pageSize: document.pageSize ?? 'letter',
          orientation: document.orientation ?? 'portrait',
          marginTopPt: document.marginTopPt ?? 54,
          marginRightPt: document.marginRightPt ?? 54,
          marginBottomPt: document.marginBottomPt ?? 54,
          marginLeftPt: document.marginLeftPt ?? 54,
          headerText: document.headerText ?? null,
          footerText: document.footerText ?? null,
        }
      : liveDocument
        ? {
            pageSize: liveDocument.pageSize,
            orientation: liveDocument.orientation,
            marginTopPt: liveDocument.marginTopPt,
            marginRightPt: liveDocument.marginRightPt,
            marginBottomPt: liveDocument.marginBottomPt,
            marginLeftPt: liveDocument.marginLeftPt,
            headerText: liveDocument.headerText,
            footerText: liveDocument.footerText,
          }
        : null,
    itemsFromSnapshot,
    documentFromSnapshot,
  }
}

function brandTokensOf(kit: typeof brandKits.$inferSelect): BrandTokens & {
  logoAssetId: string | null
} {
  return {
    primaryColor: kit.primaryColor,
    accentColor: kit.accentColor,
    textColor: kit.textColor,
    mutedColor: kit.mutedColor,
    surfaceColor: kit.surfaceColor,
    headingFont: kit.headingFont,
    bodyFont: kit.bodyFont,
    baseSizePt: kit.baseSizePt,
    logoAssetId: kit.logoAssetId,
  }
}

/**
 * One entry of the version history a client may see (Phase 189, spec §7).
 *
 * `totalCents` is null for a version they never opened, which is the whole
 * rule in one field: they learn the document was revised and when, and are not
 * handed a figure they were never shown.
 */
export type ClientVersion = {
  versionNumber: number
  sentAt: Date
  isCurrent: boolean
  /** A view recorded while this version was the one the link served. */
  wasOpened: boolean
  canDownload: boolean
  totalCents: number | null
}

/**
 * The version history, as a client may see it.
 *
 * ## The decision
 *
 * §7 asks the client link for *"version history"*, and the question it leaves
 * open is what a client may see of a **superseded** version.
 *
 * Serving every earlier PDF is the obvious answer and is wrong in a specific
 * way: a company that sends a price by mistake and corrects it an hour later
 * would be handing the client the mistake, on a link the client may never have
 * opened in that hour. Serving nothing is what the page did before this phase,
 * and is what §7 asks to change.
 *
 * `proposal_views` already records **when the client opened the link**, and
 * each version is the document that link served between its `sentAt` and the
 * next one's. So the rule is evidence rather than policy:
 *
 * > A client may re-read a version they demonstrably opened.
 *
 * Every version is listed with its date, because knowing a document was
 * revised is what a version history is for and discloses no figures. One they
 * opened is also downloadable and carries its total.
 *
 * ## The window is half-open
 *
 * `sentAt <= viewedAt < nextSentAt`. Closed at both ends would let a single
 * view unlock two versions, and two sends can be milliseconds apart — which is
 * exactly when that shows.
 *
 * A view recorded **before** the first send belongs to no version. That is not
 * a corner case: it is the author's own *"Preview client view"* on a draft,
 * which Phase 188 recorded as live behaviour, and attributing it to version 1
 * would unlock a version on the strength of the seller having looked at it.
 */
export async function clientVersionHistory(
  publicToken: string,
  exec: Executor = db,
): Promise<ClientVersion[]> {
  const [proposal] = await exec
    .select({ id: proposals.id })
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal) return []

  const versions = await exec
    .select()
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposal.id))
    .orderBy(proposalVersions.versionNumber)

  if (versions.length === 0) return []

  const views = await exec
    .select({ viewedAt: proposalViews.viewedAt })
    .from(proposalViews)
    .where(eq(proposalViews.proposalId, proposal.id))

  return versions
    .map((version, index) => {
      const until = versions[index + 1]?.sentAt ?? null
      const wasOpened = views.some(
        (view) =>
          view.viewedAt >= version.sentAt && (until === null || view.viewedAt < until),
      )
      const isCurrent = index === versions.length - 1

      /*
        The current version is always readable: it is the page the client is
        looking at, and refusing its PDF because no view is recorded yet would
        refuse the very visit that is recording one.
      */
      const canDownload = isCurrent || wasOpened

      return {
        versionNumber: version.versionNumber,
        sentAt: version.sentAt,
        isCurrent,
        wasOpened,
        canDownload,
        totalCents: canDownload ? version.totalCents : null,
      }
    })
    .reverse()
}

/**
 * The version a client may read, by number, or `null`.
 *
 * The single answer to "may this client read this version", called by the
 * download route and by anything else that needs it. One reader, for the
 * reason Phase 188 exists: the page, the acceptance and the PDF each had their
 * own idea of what a client was looking at, and two of them disagreed.
 *
 * The number is a small integer a client can type, and it is resolved under
 * the proposal the token names — so guessing one reaches the asker's own
 * proposal or nothing.
 */
export async function versionForClient(
  publicToken: string,
  versionNumber: number,
  exec: Executor = db,
): Promise<{
  proposalId: string
  companyId: string
  versionId: string
  versionNumber: number
  pdfDocumentId: string | null
} | null> {
  const allowed = (await clientVersionHistory(publicToken, exec)).find(
    (entry) => entry.versionNumber === versionNumber && entry.canDownload,
  )

  if (!allowed) return null

  const [proposal] = await exec
    .select({ id: proposals.id, companyId: proposals.companyId })
    .from(proposals)
    .where(eq(proposals.publicToken, publicToken))
    .limit(1)

  if (!proposal) return null

  const [version] = await exec
    .select()
    .from(proposalVersions)
    .where(
      and(
        eq(proposalVersions.proposalId, proposal.id),
        eq(proposalVersions.versionNumber, versionNumber),
      ),
    )
    .limit(1)

  if (!version) return null

  return {
    proposalId: proposal.id,
    companyId: proposal.companyId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    pdfDocumentId: version.pdfDocumentId,
  }
}
