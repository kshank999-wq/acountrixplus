/**
 * Which return a set of books feeds, and who it belongs to (Phase 158).
 *
 * Exporter spec §5's package opens with *"Client / entity information"* and
 * *"Entity type and tax classification"*, and §11 makes an incomplete client
 * profile a **red** exception — because the entity type decides which return
 * the figures feed and the fiscal year decides which year they land in.
 *
 * ## How this phase found it
 *
 * By writing the check and then measuring what could satisfy it. `companies`
 * held a name, a legal name, an industry, a fiscal year start month, a currency
 * and an inventory cost method. No entity type and no EIN — so
 * `entity_data_complete` would have fired on every company in existence.
 *
 * A red check that can only fail is worth exactly as little as Phase 121's check
 * that can only agree, and only one of the two could change. It was not going to
 * be the check: *which return do these books feed* is a real question with no
 * answer in that schema, and it is the first thing a tax preparer asks.
 *
 * ## Why not `industry`
 *
 * Because they are different questions and the nearest column is not the right
 * one (Phase 130). A restaurant can be a sole proprietorship, a partnership or
 * an S corporation. `industry` drives the chart of accounts; this drives the
 * return. Reusing one for both would mean the field a federal return is selected
 * from was chosen to avoid a migration.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { companies } from '@/db/schema'
import { Refusal } from '@/modules/errors'
import { RegistryError } from '@/modules/errors/registry'
import { requirePermission, type ActorContext } from '@/modules/tenancy/context'

/**
 * How an entity is classified for tax, and what that means (Exporter spec §5).
 *
 * Each entry carries the federal return it feeds, because that is the fact an
 * export adapter needs and the one a person choosing from a dropdown is actually
 * deciding. A list of names with no returns beside them invites somebody to pick
 * "LLC" — which is not a tax classification at all, and is why the two LLC
 * entries below name what they are *taxed as*.
 */
export type TaxClassification = {
  key: string
  label: string
  /** The federal return, as a preparer would name it. */
  filesAs: string
  because: string
}

export const TAX_CLASSIFICATIONS: readonly TaxClassification[] = [
  {
    key: 'sole_proprietor',
    label: 'Sole proprietor',
    filesAs: 'Schedule C with Form 1040',
    because:
      'No separate return: the business’s profit lands on the owner’s personal return. A package ' +
      'exported for one of these has no entity-level tax to reconcile, which changes what a tax ' +
      'program expects to receive.',
  },
  {
    key: 'single_member_llc',
    label: 'Single-member LLC (taxed as a sole proprietor)',
    filesAs: 'Schedule C with Form 1040',
    because:
      'A disregarded entity: it is an LLC in state law and a sole proprietor to the IRS unless it ' +
      'has elected otherwise. Named separately from `sole_proprietor` because the client calls ' +
      'itself an LLC and would not find itself in that list — and the election is exactly the thing ' +
      'a preparer needs told rather than inferred.',
  },
  {
    key: 'partnership',
    label: 'Partnership',
    filesAs: 'Form 1065, with K-1s to the partners',
    because:
      'An information return rather than a tax return: the entity allocates and the partners pay. ' +
      'The equity activity section of §5’s package is what a 1065 preparer reaches for first, which ' +
      'is why it is a section of its own.',
  },
  {
    key: 'multi_member_llc',
    label: 'Multi-member LLC (taxed as a partnership)',
    filesAs: 'Form 1065, with K-1s to the members',
    because: 'The same return as a partnership, and the same reason as the single-member entry for naming it.',
  },
  {
    key: 's_corporation',
    label: 'S corporation',
    filesAs: 'Form 1120-S, with K-1s to the shareholders',
    because:
      'Pass-through like a partnership and corporate in form, which is why it has to be told apart ' +
      'from both. Reasonable compensation makes the payroll summary section matter here in a way it ' +
      'does not for a partnership.',
  },
  {
    key: 'c_corporation',
    label: 'C corporation',
    filesAs: 'Form 1120',
    because:
      'The only one that pays tax at the entity level, so the only one where a tax program expects ' +
      'book-to-tax reconciliation — §7’s *"M-1 / M-2 mappings"* question is asked of these books and ' +
      'not of a Schedule C.',
  },
  {
    key: 'nonprofit',
    label: 'Nonprofit or exempt organisation',
    filesAs: 'Form 990, 990-EZ or 990-N',
    because:
      'A different return and a different chart: restricted and unrestricted funds, functional ' +
      'expense allocation, and no owner’s equity. The funds module exists for these books, and an ' +
      'export that called them a C corporation would send a preparer looking for retained earnings.',
  },
  {
    key: 'trust_or_estate',
    label: 'Trust or estate',
    filesAs: 'Form 1041',
    because:
      'Included because the property and fund modules make these books plausible here, and because ' +
      'an entity type list that does not contain the client’s own kind pushes somebody to pick the ' +
      'nearest — which is the failure this registry exists to prevent.',
  },
]

/** The classification a key names. Throws on one nobody declared. */
export function classificationFor(key: string): TaxClassification {
  const found = TAX_CLASSIFICATIONS.find((row) => row.key === key)
  if (!found) {
    throw new RegistryError({
      registry: 'TAX_CLASSIFICATIONS',
      key,
      message:
        `No tax classification is declared as "${key}". The list is the one a preparer would ` +
        'recognise, and each entry names the federal return it feeds — so a new one is an entry ' +
        'there with its return, not a free-text value on a company.',
    })
  }
  return found
}

/**
 * §5's client and entity information.
 *
 * One reader, so the readiness assessment, the export package's entity file and
 * the settings screen are all looking at the same thing. Three callers reading
 * the company row themselves is how the fiscal year end comes out differently in
 * the file and on the screen.
 */
export type CompanyProfile = {
  companyId: string
  name: string
  legalName: string | null
  industry: string
  currency: string
  /** 1 = January, as stored. */
  fiscalYearStartMonth: number
  /**
   * The month the year ends in, derived rather than stored.
   *
   * A calendar-year company starts in January and ends in December; one starting
   * in July ends in June. Derived because two columns that must agree are two
   * answers to one question, and the one a preparer asks for is the end.
   */
  fiscalYearEndMonth: number
  classification: TaxClassification | null
  /** Whether an EIN or TIN is on file. Not the number. */
  hasTaxIdentifier: boolean
}

export async function companyProfile(ctx: ActorContext): Promise<CompanyProfile> {
  // `reports:view` rather than `reports:financial`, deliberately: nothing here
  // is sensitive. The name, the industry, the fiscal year and *whether* a tax
  // identifier exists are what a client record needs, and the number itself is
  // behind `taxIdentifier` with `company:manage` on it. Putting the profile
  // behind the financial-reports permission would also mean a bookkeeper's
  // export had no client on it, which is not a package.
  requirePermission(ctx, 'reports:view')

  const [row] = await db
    .select({
      id: companies.id,
      name: companies.name,
      legalName: companies.legalName,
      industry: companies.industry,
      currency: companies.currency,
      fiscalYearStartMonth: companies.fiscalYearStartMonth,
      taxClassification: companies.taxClassification,
      taxIdentifier: companies.taxIdentifier,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))

  if (!row) {
    throw new Refusal('That company no longer exists, so there is nothing to export.')
  }

  return {
    companyId: row.id,
    name: row.name,
    legalName: row.legalName,
    industry: row.industry,
    currency: row.currency,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    fiscalYearEndMonth: ((row.fiscalYearStartMonth + 10) % 12) + 1,
    classification: row.taxClassification ? classificationFor(row.taxClassification) : null,
    hasTaxIdentifier: Boolean(row.taxIdentifier?.trim()),
  }
}

/**
 * The EIN or TIN itself, read separately and on purpose.
 *
 * `companyProfile` carries whether one exists because it is shown, logged and
 * pasted around; the number is read only by the code that writes it into a file
 * a firm is about to receive. §12: *"do not include sensitive fields that are
 * not required by the target system."* Two functions make that a decision a
 * caller takes rather than a field that travels with everything else.
 */
export async function taxIdentifier(ctx: ActorContext): Promise<string | null> {
  requirePermission(ctx, 'company:manage')

  const [row] = await db
    .select({ taxIdentifier: companies.taxIdentifier })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))

  return row?.taxIdentifier ?? null
}

export type TaxProfileInput = {
  /** A `TAX_CLASSIFICATIONS` key, or `null` to say nobody has decided. */
  classification: string | null
  /** An EIN or TIN, or `null` to remove one. Punctuation is kept as typed. */
  taxIdentifier?: string | null
}

/** Records which return these books feed. */
export async function setTaxProfile(
  ctx: ActorContext,
  input: TaxProfileInput,
): Promise<CompanyProfile> {
  requirePermission(ctx, 'company:manage')

  // Validated through the registry rather than against the database's CHECK,
  // so the refusal is a sentence rather than a constraint violation. The CHECK
  // stays as the floor under it.
  if (input.classification !== null) classificationFor(input.classification)

  const identifier = input.taxIdentifier?.trim() ?? null
  if (identifier !== null && identifier !== '' && !/^[0-9-]{9,20}$/.test(identifier)) {
    throw new Refusal(
      'An EIN or TIN is nine digits, written with or without hyphens. ' +
        `"${identifier}" is not one, and a professional system will reject the client record rather ` +
        'than the field.',
    )
  }

  await db
    .update(companies)
    .set({
      taxClassification: input.classification,
      // `undefined` leaves it alone; an explicit null or empty string removes it.
      ...(input.taxIdentifier === undefined
        ? {}
        : { taxIdentifier: identifier === '' ? null : identifier }),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, ctx.companyId))

  return companyProfile(ctx)
}
