import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies, companyModules } from '@/db/schema'
import { recordAudit } from '@/modules/audit'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'
import {
  INDUSTRY_MODULES,
  industryPack,
  type Industry,
  type IndustryModule,
} from '@/modules/coa/industry'
import { DomainError } from '@/modules/errors'
import { missing } from '@/modules/errors/missing'

/**
 * Which optional modules a company has switched on (spec §5, §20, §23).
 *
 * Phase 0 declared `INDUSTRY_MODULES` and the per-pack `terminology` map and
 * then used neither. This file is where they start meaning something.
 *
 * Resolution is: **the industry pack's list, adjusted by the company's own
 * overrides.** Two consequences follow, and both are the reason it is not a
 * plain list of enabled keys on the company row:
 *
 *  - A contractor gets job costing without configuring anything, because the
 *    construction pack asks for it.
 *  - A landscaper on the "general" pack can still switch job costing on, and a
 *    contractor who does not want it can switch it off. Industry is a starting
 *    point, not a cage.
 *
 * What a module never does is change the accounting. Spec §23 requires
 * industry customization to extend the common platform rather than create
 * separate products, so a module gates workspaces and adds dimensions — it
 * does not fork the ledger.
 */

export type ModuleState = {
  key: IndustryModule
  /** True when the industry pack switches this on by default. */
  packDefault: boolean
  enabled: boolean
  /** True when the company has overridden the pack's default either way. */
  overridden: boolean
}

/** Human labels, so a settings page does not print `pos_import`. */
export const MODULE_LABELS: Record<IndustryModule, string> = {
  job_costing: 'Job costing',
  inventory: 'Inventory',
  projects: 'Projects and jobs',
  time_billing: 'Time and billing',
  pos_import: 'Point-of-sale import',
  properties: 'Properties and units',
  funds: 'Fund accounting',
  appointments: 'Appointments',
  vehicles: 'Vehicles and equipment',
  manufacturing: 'Manufacturing',
  cash_drawer: 'Cash drawers',
}

/** One-line descriptions for the settings page. */
export const MODULE_DESCRIPTIONS: Record<IndustryModule, string> = {
  job_costing:
    'Cost codes, job budgets, change orders, progress billing with retainage, WIP, and subcontractor compliance.',
  inventory:
    'Stock quantities and valuation, purchase orders and receiving, cost of goods sold on sale, and counts.',
  projects: 'Jobs as an accounting dimension, so revenue and cost can be reported per job.',
  time_billing:
    'Timesheets with approval, reimbursable expenses, retainers, and invoices built from unbilled work.',
  pos_import: 'Daily sales summaries imported from a point-of-sale system.',
  properties:
    'Properties and units, tenancies, a monthly rent run, and security deposits held as a liability.',
  funds: 'Restricted and unrestricted fund tracking for nonprofits.',
  appointments: 'A diary, practitioner splits, and gift cards held as a liability.',
  vehicles: 'Customer vehicles, repair orders, and the estimate nobody may bill past.',
  manufacturing: 'Bills of materials and work orders.',
  cash_drawer:
    'Tills opened with a float and closed by somebody counting them, with over and short posted rather than absorbed.',
}

/**
 * Modules with workflows behind them.
 *
 * `inventory` joined in Phase 14, and it is the one that carries five industry
 * packs: retail, restaurant, manufacturing, e-commerce, and wholesale all name
 * stock first. They are not five features — a restaurant's food cost and a
 * wholesaler's warehouse are the same perpetual inventory with different words
 * on the screen, which is what the terminology map is for.
 *
 * As of Phase 30 there is no "rest": all ten are implemented, and the settings
 * page's "Not built yet" section is empty. It is kept rather than deleted,
 * because the next module declared will need it — and a module that is
 * silently absent is worse than one that says so.
 */
export const IMPLEMENTED_MODULES: IndustryModule[] = [
  'job_costing',
  'projects',
  'inventory',
  'time_billing',
  // Phase 23. Properties, units, leases, the rent run and security deposits —
  // and no per-property report, because a property is a dimension and Phase 16
  // already reports on those.
  'properties',
  // Phase 26. Funds, contributions, pledges and the release run — and, for the
  // same reason, no per-fund profit and loss.
  'funds',
  // Phase 27. Bills of materials and work orders, moving cost from raw
  // materials through work in process into finished goods — on Phase 14's
  // costing engine rather than a second one.
  'manufacturing',
  // Phase 28. Daily sales summaries for a till, a marketplace or a processor —
  // one module for two industry rows, because they are the same shape.
  'pos_import',
  // Phase 29. A diary a double-booking cannot get into, revenue recognised when
  // the service is delivered rather than when it is booked, the practitioner's
  // share of it, and gift cards as the liability they are. Two more industry
  // rows: healthcare and personal care.
  'appointments',
  // Phase 30, and the tenth of ten. A customer's vehicle, a repair order
  // against it, and the rule that nobody bills past what was authorised.
  'vehicles',
  // Phase 34. The eleventh, and the first added since the "Not built yet"
  // section was kept empty against exactly this. A drawer opened with a float,
  // counted at the end of a shift, with the difference posted.
  'cash_drawer',
]

type CompanyRow = { id: string; industry: Industry }

async function companyRow(companyId: string): Promise<CompanyRow> {
  const [row] = await db
    .select({ id: companies.id, industry: companies.industry })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)

  if (!row) throw missing('company')
  return row
}

/**
 * The full module picture for a company: what the pack asks for, what the
 * company decided, and the resolved answer.
 */
export async function moduleStates(companyId: string): Promise<ModuleState[]> {
  const company = await companyRow(companyId)
  const packModules = new Set<IndustryModule>(industryPack(company.industry).modules)

  const overrides = await db
    .select()
    .from(companyModules)
    .where(eq(companyModules.companyId, companyId))

  const overrideMap = new Map(overrides.map((row) => [row.moduleKey, row.enabled]))

  return INDUSTRY_MODULES.map((key) => {
    const packDefault = packModules.has(key)
    const override = overrideMap.get(key)

    return {
      key,
      packDefault,
      enabled: override ?? packDefault,
      overridden: override !== undefined && override !== packDefault,
    }
  })
}

/** The set of modules currently on, for gating. */
export async function enabledModules(companyId: string): Promise<Set<IndustryModule>> {
  const states = await moduleStates(companyId)
  return new Set(states.filter((state) => state.enabled).map((state) => state.key))
}

/**
 * Whether one module is on.
 *
 * The gate every construction service and page calls first. It reads the
 * company's configuration rather than its industry, so a company that switched
 * job costing on gets it whatever its pack says.
 */
export async function moduleEnabled(
  companyId: string,
  module: IndustryModule,
): Promise<boolean> {
  return (await enabledModules(companyId)).has(module)
}

/** Raised when a workflow is used while its module is switched off. */
export class ModuleDisabledError extends DomainError {
  readonly status = 409
  constructor(readonly module: IndustryModule) {
    super(
      `The ${MODULE_LABELS[module] ?? module} module is not switched on for this company. ` +
        'Enable it in company settings first.',
    )
    this.name = 'ModuleDisabledError'
  }
}

/** Throws unless the module is on. Called at the top of every job service. */
export async function requireModule(
  ctx: ActorContext,
  module: IndustryModule,
): Promise<void> {
  if (!(await moduleEnabled(ctx.companyId, module))) {
    throw new ModuleDisabledError(module)
  }
}

/**
 * Switches a module on or off for a company.
 *
 * Setting it back to the pack's own default deletes the override rather than
 * storing a redundant row, so "has this company departed from its industry
 * defaults" stays answerable by looking at whether any rows exist.
 */
export async function setModuleEnabled(
  ctx: ActorContext,
  module: IndustryModule,
  enabled: boolean,
): Promise<ModuleState[]> {
  requirePermission(ctx, 'company:manage')

  if (!(INDUSTRY_MODULES as readonly string[]).includes(module)) {
    throw new Error(`Unknown module: ${module}`)
  }

  const company = await companyRow(ctx.companyId)
  const packDefault = industryPack(company.industry).modules.includes(module)

  await db.transaction(async (tx) => {
    if (enabled === packDefault) {
      await tx
        .delete(companyModules)
        .where(
          and(
            eq(companyModules.companyId, ctx.companyId),
            eq(companyModules.moduleKey, module),
          ),
        )
    } else {
      await tx
        .insert(companyModules)
        .values({
          companyId: ctx.companyId,
          moduleKey: module,
          enabled,
          updatedBy: ctx.userId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [companyModules.companyId, companyModules.moduleKey],
          set: { enabled, updatedBy: ctx.userId, updatedAt: new Date() },
        })
    }

    await recordAudit(
      ctx,
      {
        action: 'module.toggle',
        entityType: 'company_module',
        entityId: null,
        before: { module, enabled: !enabled },
        after: { module, enabled, packDefault },
      },
      tx,
    )
  })

  return moduleStates(ctx.companyId)
}

/**
 * The vocabulary a company's industry uses (spec §5 terminology overrides).
 *
 * A record type never changes: a "Job" is still a `projects` row and a
 * "Tenant" is still an `organizations` row. Only the words on screen change,
 * which is the whole reason this is a display concern and not a schema one.
 */
export type Terminology = {
  customer: string
  job: string
  invoice: string
}

const DEFAULT_TERMS: Terminology = {
  customer: 'Customer',
  job: 'Job',
  invoice: 'Invoice',
}

export function terminologyFor(industry: Industry): Terminology {
  return { ...DEFAULT_TERMS, ...(industryPack(industry).terminology ?? {}) }
}

export async function companyTerminology(companyId: string): Promise<Terminology> {
  const company = await companyRow(companyId)
  return terminologyFor(company.industry)
}
