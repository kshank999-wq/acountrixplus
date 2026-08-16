import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  integer,
  boolean,
  jsonb,
  index,
  unique,
  pgEnum,
  customType,
} from 'drizzle-orm/pg-core'
import { companies, users } from './tenancy'
import { chartAccounts } from './accounting'

/**
 * Company Studio (spec §15).
 *
 * The single place a company's identity lives: profile, brand, reusable
 * services, and approved legal language. Spec §15 is explicit that these feed
 * *both* the Proposal Designer and the Marketing Creative Studio, so nothing
 * here knows what a proposal is.
 */

/** Raw bytes, for the database-backed asset store. */
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType: () => 'bytea',
})

/**
 * Company profile (spec §15). One row per company.
 *
 * Separate from `companies`, which holds the tenant record the whole system
 * keys off. This is presentation data that appears on documents, and it
 * changes for different reasons.
 */
export const companyProfiles = pgTable(
  'company_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    legalName: text('legal_name'),
    dba: text('dba'),
    tagline: text('tagline'),
    description: text('description'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    country: text('country'),

    phone: text('phone'),
    email: text('email'),
    website: text('website'),
    taxId: text('tax_id'),

    /** Shown on invoices and accepted proposals. */
    paymentInstructions: text('payment_instructions'),
    /** Licences, certifications, insurance — trust signals on a proposal. */
    credentials: jsonb('credentials').$type<Credential[]>().notNull().default([]),
    /** Default footer language for generated documents. */
    documentFooter: text('document_footer'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyUnique: unique('company_profiles_company_unique').on(t.companyId),
  }),
)

export type Credential = {
  kind: 'license' | 'certification' | 'insurance' | 'membership'
  label: string
  identifier?: string
  expiresOn?: string
}

/**
 * A brand kit (spec §15).
 *
 * Colours are stored as hex strings and fonts as CSS font stacks, so the
 * renderer can apply them without a lookup table. A company can hold several
 * kits — a parent brand and a sub-brand — with one marked default.
 */
export const brandKits = pgTable(
  'brand_kits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),

    primaryColor: text('primary_color').notNull().default('#0d6e60'),
    accentColor: text('accent_color').notNull().default('#0f766e'),
    textColor: text('text_color').notNull().default('#0f172a'),
    mutedColor: text('muted_color').notNull().default('#64748b'),
    surfaceColor: text('surface_color').notNull().default('#ffffff'),

    headingFont: text('heading_font').notNull().default('Georgia, serif'),
    bodyFont: text('body_font').notNull().default('system-ui, sans-serif'),
    /** Base body size in points, so print output is predictable. */
    baseSizePt: integer('base_size_pt').notNull().default(11),

    logoAssetId: uuid('logo_asset_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('brand_kits_company_idx').on(t.companyId),
  }),
)

export const assetKindEnum = pgEnum('asset_kind', ['logo', 'image', 'document'])

/**
 * Asset metadata (spec §15 logo library).
 *
 * The bytes live behind an `AssetStore` adapter — see `modules/studio/assets`.
 * `storageProvider` and `storageKey` name where they went, so moving to object
 * storage (spec §18) means writing one adapter, not migrating this table.
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    kind: assetKindEnum('kind').notNull().default('image'),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Pixel dimensions when known, so layout can reserve space. */
    width: integer('width'),
    height: integer('height'),

    storageProvider: text('storage_provider').notNull().default('database'),
    storageKey: text('storage_key').notNull(),

    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('assets_company_idx').on(t.companyId, t.kind),
    storageKeyUnique: unique('assets_storage_key_unique').on(t.storageKey),
  }),
)

/**
 * Backing store for the database asset adapter.
 *
 * Separate from `assets` on purpose: an S3 adapter writes metadata to `assets`
 * and never touches this table at all.
 */
export const assetBlobs = pgTable('asset_blobs', {
  storageKey: text('storage_key').primaryKey(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Reusable products and services (spec §15).
 *
 * Carries both the selling side (rate, default proposal copy) and the costing
 * side (cost assumption), and links to the revenue account so a won proposal
 * can become an invoice without anyone choosing an account again.
 */
export const serviceItems = pgTable(
  'service_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    code: text('code'),
    name: text('name').notNull(),
    description: text('description'),
    /** "hour", "each", "sq ft" — display only. */
    unit: text('unit').notNull().default('each'),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull().default(0),
    /** Assumed cost, for margin analysis later. Not posted anywhere yet. */
    unitCostCents: bigint('unit_cost_cents', { mode: 'number' }).notNull().default(0),
    isTaxable: boolean('is_taxable').notNull().default(false),

    /** Revenue account used when this line becomes an invoice. */
    chartAccountId: uuid('chart_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),
    /** Longer copy dropped into a proposal when this item is added. */
    defaultProposalCopy: text('default_proposal_copy'),

    // --- Stocked goods (Phase 14, spec §5) --------------------------------
    //
    // Added here rather than in a parallel `products` table. A business sells
    // a mix of services and things off a shelf, and the person building an
    // invoice does not think of them as living in two catalogues. One table
    // with a flag is what spec §23 means by extending the common platform.
    /**
     * True when this item is counted and costed.
     *
     * Off by default, so every existing item and every service stays exactly
     * what it was: a description and a price with no stock behind it.
     */
    isInventoried: boolean('is_inventoried').notNull().default(false),
    /** Where its value sits on the balance sheet. Defaults to 1400 Inventory. */
    inventoryAccountId: uuid('inventory_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),
    /** Where its cost lands when it sells. Defaults to 5000 Cost of Goods Sold. */
    cogsAccountId: uuid('cogs_account_id').references(() => chartAccounts.id, {
      onDelete: 'set null',
    }),
    /** Below this, the item appears on the reorder report. Null means never. */
    reorderPointMilli: bigint('reorder_point_milli', { mode: 'number' }),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('service_items_company_idx').on(t.companyId, t.isActive),
    codeUnique: unique('service_items_company_code_unique').on(t.companyId, t.code),
  }),
)

/**
 * A reusable legal or terms clause (spec §7, §15).
 *
 * The clause is the stable identity; its wording lives in versions. Approved
 * language on a sent proposal must never change retroactively, so a document
 * references a specific version.
 */
export const clauses = pgTable(
  'clauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** "terms", "warranty", "disclaimer", "payment", "exclusions". */
    category: text('category').notNull().default('terms'),
    /** The version currently offered to new documents. */
    currentVersionId: uuid('current_version_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('clauses_company_idx').on(t.companyId, t.category),
  }),
)

export const clauseVersions = pgTable(
  'clause_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    clauseId: uuid('clause_id')
      .notNull()
      .references(() => clauses.id, { onDelete: 'cascade' }),

    versionNumber: integer('version_number').notNull(),
    body: text('body').notNull(),
    /**
     * Whether someone with authority signed this wording off (spec §15
     * "company-approved clauses").
     */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clauseVersionUnique: unique('clause_versions_unique').on(t.clauseId, t.versionNumber),
  }),
)
