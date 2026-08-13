'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireActor } from '@/lib/current-user'
import { setModuleEnabled } from '@/modules/industry/modules'
import { INDUSTRY_MODULES } from '@/modules/coa/industry'
import { createCostCode, installDefaultCostCodes, updateCostCode } from '@/modules/jobs/cost-codes'
import {
  approveChangeOrder,
  createChangeOrder,
  rejectChangeOrder,
  setJobBudget,
} from '@/modules/jobs/budgets'
import {
  createProgressBilling,
  releaseRetainage,
  setScheduleOfValues,
} from '@/modules/jobs/billing'
import {
  createSubcontractor,
  recordComplianceDocument,
  updateSubcontractor,
} from '@/modules/jobs/compliance'

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string }

async function run(
  path: string | string[],
  fn: () => Promise<string | void>,
): Promise<ActionResult> {
  try {
    const message = await fn()
    for (const entry of Array.isArray(path) ? path : [path]) revalidatePath(entry)
    return { ok: true, message: message ?? undefined }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Something went wrong.',
    }
  }
}

const moduleKeySchema = z.enum(INDUSTRY_MODULES)
const cents = z.number().int()

// --- Modules ---------------------------------------------------------------

export async function toggleModuleAction(
  moduleKey: string,
  enabled: boolean,
): Promise<ActionResult> {
  // Every workspace, because switching job costing off has to remove the
  // construction navigation everywhere it appears.
  return run(['/', '/settings/modules', '/jobs'], async () => {
    const actor = await requireActor()
    const key = moduleKeySchema.parse(moduleKey)
    await setModuleEnabled(actor, key, enabled)
    return enabled ? 'Module switched on.' : 'Module switched off.'
  })
}

// --- Cost codes ------------------------------------------------------------

export async function installCostCodesAction(): Promise<ActionResult> {
  return run('/jobs/cost-codes', async () => {
    const actor = await requireActor()
    const created = await installDefaultCostCodes(actor)
    return created === 0
      ? 'Every starter cost code is already in the library.'
      : `${created} cost codes added.`
  })
}

const costCodeSchema = z.object({
  code: z.string().trim().min(1, 'A cost code needs a code.'),
  name: z.string().trim().min(1, 'A cost code needs a name.'),
  division: z.string().trim().optional(),
  costType: z.enum(['labor', 'material', 'subcontract', 'equipment', 'other']),
  defaultChartAccountId: z.string().uuid().nullish(),
})

export async function createCostCodeAction(
  input: z.input<typeof costCodeSchema>,
): Promise<ActionResult> {
  return run('/jobs/cost-codes', async () => {
    const actor = await requireActor()
    const parsed = costCodeSchema.parse(input)
    const created = await createCostCode(actor, parsed)
    return `Cost code ${created.code} added.`
  })
}

export async function setCostCodeActiveAction(
  costCodeId: string,
  isActive: boolean,
): Promise<ActionResult> {
  return run('/jobs/cost-codes', async () => {
    const actor = await requireActor()
    await updateCostCode(actor, costCodeId, { isActive })
    return isActive ? 'Cost code reactivated.' : 'Cost code retired.'
  })
}

// --- Budgets and change orders --------------------------------------------

const budgetSchema = z.object({
  projectId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        costCodeId: z.string().uuid(),
        description: z.string().trim().optional(),
        originalAmountCents: cents,
      }),
    )
    .min(1, 'A budget needs at least one line.'),
})

export async function setJobBudgetAction(
  input: z.input<typeof budgetSchema>,
): Promise<ActionResult> {
  const parsed = budgetSchema.parse(input)
  return run(`/jobs/${parsed.projectId}`, async () => {
    const actor = await requireActor()
    await setJobBudget(actor, parsed.projectId, parsed.lines)
    return 'Budget saved.'
  })
}

const changeOrderSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1, 'A change order needs a title.'),
  description: z.string().trim().optional(),
  contractAmountCents: cents,
  scheduleDays: z.number().int().optional(),
  lines: z
    .array(
      z.object({
        costCodeId: z.string().uuid(),
        description: z.string().trim().optional(),
        amountCents: cents,
      }),
    )
    .optional(),
})

export async function createChangeOrderAction(
  input: z.input<typeof changeOrderSchema>,
): Promise<ActionResult> {
  const parsed = changeOrderSchema.parse(input)
  return run(`/jobs/${parsed.projectId}`, async () => {
    const actor = await requireActor()
    const order = await createChangeOrder(actor, parsed)
    return `Change order ${order.number} raised.`
  })
}

export async function approveChangeOrderAction(
  changeOrderId: string,
  projectId: string,
  notes?: string,
): Promise<ActionResult> {
  return run([`/jobs/${projectId}`, '/jobs'], async () => {
    const actor = await requireActor()
    await approveChangeOrder(actor, changeOrderId, { notes })
    return 'Change order approved. The contract value and budget are revised; nothing was posted to the ledger.'
  })
}

export async function rejectChangeOrderAction(
  changeOrderId: string,
  projectId: string,
  notes?: string,
): Promise<ActionResult> {
  return run(`/jobs/${projectId}`, async () => {
    const actor = await requireActor()
    await rejectChangeOrder(actor, changeOrderId, { notes })
    return 'Change order rejected.'
  })
}

// --- Progress billing ------------------------------------------------------

const sovSchema = z.object({
  projectId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        itemNumber: z.string().trim().min(1),
        description: z.string().trim().min(1),
        scheduledValueCents: cents.nonnegative(),
        chartAccountId: z.string().uuid(),
        costCodeId: z.string().uuid().nullish(),
      }),
    )
    .min(1, 'A schedule of values needs at least one item.'),
})

export async function setScheduleOfValuesAction(
  input: z.input<typeof sovSchema>,
): Promise<ActionResult> {
  const parsed = sovSchema.parse(input)
  return run(`/jobs/${parsed.projectId}`, async () => {
    const actor = await requireActor()
    await setScheduleOfValues(actor, parsed.projectId, parsed.lines)
    return 'Schedule of values saved.'
  })
}

const applicationSchema = z.object({
  projectId: z.string().uuid(),
  customerId: z.string().uuid(),
  periodEnd: z.string(),
  billingDate: z.string(),
  retainagePercentBp: z.number().int().min(0).max(10_000),
  memo: z.string().trim().optional(),
  lines: z
    .array(
      z.object({
        scheduleOfValuesId: z.string().uuid(),
        percentCompleteBp: z.number().int().min(0).max(10_000),
      }),
    )
    .min(1),
})

export async function createProgressBillingAction(
  input: z.input<typeof applicationSchema>,
): Promise<ActionResult> {
  const parsed = applicationSchema.parse(input)
  return run([`/jobs/${parsed.projectId}`, '/jobs', '/accounting'], async () => {
    const actor = await requireActor()
    const { invoice, billing } = await createProgressBilling(actor, parsed)
    return `Application ${billing.applicationNumber} issued as invoice ${invoice.number}. ${
      invoice.retainageCents > 0
        ? `${(invoice.retainageCents / 100).toFixed(2)} retained.`
        : ''
    }`.trim()
  })
}

export async function releaseRetainageAction(
  input: { projectId: string; customerId: string; billingDate: string; amountCents?: number },
): Promise<ActionResult> {
  return run([`/jobs/${input.projectId}`, '/jobs', '/accounting'], async () => {
    const actor = await requireActor()
    const { invoice } = await releaseRetainage(actor, input)
    return `Retainage released on invoice ${invoice.number}.`
  })
}

// --- Subcontractor compliance ---------------------------------------------

const subcontractorSchema = z.object({
  vendorId: z.string().uuid(),
  trade: z.string().trim().optional(),
  licenseNumber: z.string().trim().optional(),
  defaultRetainageBp: z.number().int().min(0).max(10_000).optional(),
})

export async function createSubcontractorAction(
  input: z.input<typeof subcontractorSchema>,
): Promise<ActionResult> {
  return run('/jobs/subcontractors', async () => {
    const actor = await requireActor()
    await createSubcontractor(actor, subcontractorSchema.parse(input))
    return 'Subcontractor added.'
  })
}

export async function setPaymentHoldAction(
  subcontractorId: string,
  holdPayments: boolean,
): Promise<ActionResult> {
  return run('/jobs/subcontractors', async () => {
    const actor = await requireActor()
    await updateSubcontractor(actor, subcontractorId, { holdPayments })
    return holdPayments ? 'Payments put on hold.' : 'Payment hold lifted.'
  })
}

const documentSchema = z.object({
  subcontractorId: z.string().uuid(),
  kind: z.enum([
    'general_liability',
    'workers_comp',
    'auto_liability',
    'w9',
    'license',
    'lien_waiver',
    'other',
  ]),
  reference: z.string().trim().optional(),
  carrier: z.string().trim().optional(),
  coverageAmountCents: cents.nonnegative().optional(),
  issuedOn: z.string().optional(),
  expiresOn: z.string().nullish(),
})

export async function recordComplianceDocumentAction(
  input: z.input<typeof documentSchema>,
): Promise<ActionResult> {
  return run('/jobs/subcontractors', async () => {
    const actor = await requireActor()
    await recordComplianceDocument(actor, documentSchema.parse(input))
    return 'Document recorded.'
  })
}
