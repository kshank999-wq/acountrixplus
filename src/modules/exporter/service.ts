/**
 * Handing a client's books to professional software (Phase 158).
 *
 * Exporter spec §9's workflow, in its order:
 *
 * > Accountrix checks that the books balance. Accountrix checks for unmapped
 * > accounts and missing tax codes. [...] Accountrix generates the
 * > destination-specific package or API payload. [...] Accountrix records who
 * > exported the data, when, the destination, version, period, and validation
 * > result.
 *
 * Three things, and the order between them is the design. Validation comes
 * before generation, so a firm is never handed a file from books that do not
 * balance. The log is written either way, so *"somebody tried to send these
 * books to UltraTax in March and could not"* is a question the system can
 * answer.
 *
 * ## Validated twice, and why that is not two answers to one question
 *
 * `assess` runs before the files exist and again after they do, and the second
 * run is not a repeat of the first. `PackageFacts.rendered` is `null` the first
 * time — §11's `totals_reconcile_to_source` has nothing to compare and returns
 * no exception — and holds the figures parsed back out of the trial balance file
 * the second time.
 *
 * So the first pass asks *are these books fit to export* and the second asks
 * *did the file come out saying what the report said*. Different questions over
 * different facts. The alternative — generate, then validate once — would mean
 * building a package from books that do not balance, and the alternative to
 * *that* — validate once, before — would never check the rendering at all.
 */

import { desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { accountantExports } from '@/db/schema'
import { Refusal } from '@/modules/errors'
import { recordAudit } from '@/modules/audit'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import { mayExportTo } from './destinations'
import { assemble, type AccountantPackage, type AssembleOptions } from './package'
import { exceptionReport, type Assessment } from './readiness'
import { adapterFor, type ExportFile } from './adapter'
// Imported for its side effect: registering the universal adapter. Phase 49's
// rule from the other end — a registry nobody populates is an empty registry,
// and the import that populates it has to happen somewhere a caller reaches.
import { renderedTotals } from './universal'

export type ExportRequest = AssembleOptions

/**
 * §9's readiness check, before anything is generated.
 *
 * Its own entry point because the accountant portal asks this when the period is
 * chosen, long before anybody presses export — and because an assessment that
 * can only be obtained by attempting an export is not a pre-flight check.
 */
export async function readinessFor(
  ctx: ActorContext,
  request: ExportRequest,
): Promise<{ assessment: Assessment; report: string; pkg: AccountantPackage }> {
  const allowed = mayExportTo(request.destinationKey)
  if (!allowed.ok) throw new Refusal(allowed.why)

  const pkg = await assemble(ctx, request)
  const assessment = adapterFor(request.destinationKey).assess(pkg.facts)

  return { assessment, report: exceptionReport(assessment), pkg }
}

export type ExportResult = {
  files: ExportFile[]
  assessment: Assessment
  report: string
  /** The row written to the export log, whichever way it went. */
  logId: string
  destinationKey: string
  adapterVersion: string
}

/**
 * Generates the export, or refuses it and records the refusal.
 *
 * `reports:financial` rather than `reports:view`: this is the whole ledger
 * leaving the building in a firm's format, which is the same judgement §19's
 * portability export made about itself.
 */
export async function exportForAccountant(
  ctx: ActorContext,
  request: ExportRequest,
): Promise<ExportResult> {
  requirePermission(ctx, 'reports:financial')

  const allowed = mayExportTo(request.destinationKey)
  if (!allowed.ok) {
    // Not logged. Nothing was attempted against a client's books — the
    // destination is not one, and a log row per competitor somebody typed into
    // a URL is noise in the record that §12 asks for.
    throw new Refusal(allowed.why)
  }

  const adapter = adapterFor(request.destinationKey)
  const pkg = await assemble(ctx, request)

  const before = adapter.assess(pkg.facts)
  if (!before.mayProceed) {
    return held(ctx, request, adapter.version, before)
  }

  const files = adapter.generate(pkg)

  // The second pass, over the one fact that did not exist before: what the file
  // actually says. See this module's opening note on why this is not the same
  // question asked twice.
  const after = adapter.assess({ ...pkg.facts, rendered: renderedTotals(files) })
  if (!after.mayProceed) {
    // The files are discarded rather than returned with a warning. §15: "every
    // export is balanced and validated before release" — a file that does not
    // foot to the report it came from has not been validated, and releasing it
    // with a note attached would put the firm in the position of deciding
    // whether to trust arithmetic.
    return held(ctx, request, adapter.version, after)
  }

  const byteCount = files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0)
  const report = exceptionReport(after)

  const [row] = await db
    .insert(accountantExports)
    .values({
      companyId: ctx.companyId,
      requestedBy: ctx.userId,
      destinationKey: request.destinationKey,
      adapterVersion: adapter.version,
      periodStart: request.startDate,
      periodEnd: request.endDate,
      readiness: after.status,
      exceptionCount: after.exceptions.length,
      exceptionReport: report,
      result: 'generated',
      fileCount: files.length,
      byteCount,
    })
    .returning({ id: accountantExports.id })

  await recordAudit(ctx, {
    action: 'data.export',
    entityType: 'accountant_export',
    entityId: row.id,
    after: {
      destination: adapter.destinationKey,
      adapterVersion: adapter.version,
      period: `${request.startDate}..${request.endDate}`,
      readiness: after.status,
      files: files.length,
    },
  })

  return {
    files,
    assessment: after,
    report,
    logId: row.id,
    destinationKey: request.destinationKey,
    adapterVersion: adapter.version,
  }
}

/**
 * Records an export that did not happen, and says why.
 *
 * A row rather than a bare throw, because this is the event most worth having
 * written down. The `accountant_exports_red_is_held` constraint is what makes it
 * reliable: the database refuses a red row claiming to have produced files, so
 * a future path that skipped the validation could not record having skipped it.
 */
async function held(
  ctx: ActorContext,
  request: ExportRequest,
  adapterVersion: string,
  assessment: Assessment,
): Promise<never> {
  const report = exceptionReport(assessment)

  await db.insert(accountantExports).values({
    companyId: ctx.companyId,
    requestedBy: ctx.userId,
    destinationKey: request.destinationKey,
    adapterVersion,
    periodStart: request.startDate,
    periodEnd: request.endDate,
    readiness: assessment.status,
    exceptionCount: assessment.exceptions.length,
    exceptionReport: report,
    result: 'held',
  })

  // The report itself is the refusal. Every sentence in it was written to be
  // read by the person who hit it, which is what `Refusal` means (Phase 119) —
  // and a generic "export failed validation" beside a report they would then
  // have to go and find is the shape this project keeps removing.
  throw new Refusal(report)
}

/** The export log (§12), newest first. */
export async function exportHistory(ctx: ActorContext, limit = 50) {
  requirePermission(ctx, 'reports:financial')

  return db
    .select()
    .from(accountantExports)
    .where(eq(accountantExports.companyId, ctx.companyId))
    .orderBy(desc(accountantExports.createdAt))
    .limit(limit)
}
