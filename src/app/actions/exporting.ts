'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { messageFor } from '@/modules/errors'
import { exportForAccountant, readinessFor } from '@/modules/exporter/service'
import { setTaxProfile } from '@/modules/exporter/entity'

/**
 * Server actions for the professional accountant export (Phase 158).
 *
 * Exporter spec §9's workflow is a screen, and this is what the screen calls.
 * Without it the engine would be Phase 49's defect in the open: a function with
 * no caller is a feature that does not exist, and an export nobody can reach
 * is a library.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

const PATH = '/accounting/export'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.')

const request = z.object({
  destinationKey: z.string().trim().min(1),
  startDate: date,
  endDate: date,
})

/** §9's pre-flight: is this period fit to export, before anything is generated. */
export async function exportReadinessAction(
  input: unknown,
): Promise<{ ok: true; status: string; report: string } | { ok: false; error: string }> {
  try {
    const actor = await requireActor()
    const { assessment, report } = await readinessFor(actor, request.parse(input))
    return { ok: true, status: assessment.status, report }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not check the books.') }
  }
}

export type ExportedFilePayload = { name: string; content: string; rowCount: number }

/**
 * Generates the package, or refuses it with the exception report.
 *
 * Returns the files rather than a link, and the browser saves them one at a
 * time. A single archive would be better and §4 calls a ZIP *"optional"* for a
 * reason: this project has nine dependencies and no archive writer, so a ZIP is
 * either a new dependency or a file of its own. Said here rather than left for
 * somebody to discover from the download behaviour.
 */
export async function exportAccountantPackageAction(
  input: unknown,
): Promise<
  | { ok: true; files: ExportedFilePayload[]; status: string; report: string }
  | { ok: false; error: string }
> {
  try {
    const actor = await requireActor()
    const result = await exportForAccountant(actor, request.parse(input))
    revalidatePath(PATH)

    return {
      ok: true,
      files: result.files.map((file) => ({
        name: file.name,
        content: file.content,
        rowCount: file.rowCount,
      })),
      status: result.assessment.status,
      report: result.report,
    }
  } catch (error) {
    // The exception report *is* the error message when §11 holds an export —
    // `held` throws a `Refusal` carrying it, so the person sees the sentences
    // somebody wrote rather than "export failed validation" (Phase 119).
    return { ok: false, error: messageFor(error, 'Could not produce the export.') }
  }
}

/** Records which return these books feed (§5), without which §11 holds the export. */
export async function setTaxProfileAction(input: unknown): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    const parsed = z
      .object({
        classification: z.string().trim().min(1).nullable(),
        taxIdentifier: z.string().trim().nullable().optional(),
      })
      .parse(input)

    const profile = await setTaxProfile(actor, parsed)
    revalidatePath(PATH)

    return {
      ok: true,
      message: profile.classification
        ? `Recorded as ${profile.classification.label}, which files ${profile.classification.filesAs}.`
        : 'Entity type cleared.',
    }
  } catch (error) {
    return { ok: false, error: messageFor(error, 'Could not save the client profile.') }
  }
}
