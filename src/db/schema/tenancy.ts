import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  unique,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core'

/**
 * Roles from spec §14. Stored on the membership rather than the user, because a
 * single person (an outside accountant) may hold different roles at different
 * companies.
 */
export const roleEnum = pgEnum('role', [
  'owner',
  'manager',
  'bookkeeper',
  'accountant',
  'sales',
  'marketing',
  'readonly',
])

/** Industry packs from spec §5. Drives COA additions and terminology. */
export const industryEnum = pgEnum('industry', [
  'professional_services',
  'construction',
  'retail',
  'restaurant',
  'manufacturing',
  'real_estate',
  'creative',
  'healthcare',
  'nonprofit',
  'ecommerce',
  'automotive',
  'personal_care',
  'wholesale',
  'general',
])

/**
 * A tenant. Every business-domain row in this database carries `companyId`
 * (spec §16) and every query is scoped through it (spec §14, §19).
 */
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  industry: industryEnum('industry').notNull().default('general'),
  /** 1 = January. Drives period/close boundaries later. */
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  currency: text('currency').notNull().default('USD'),
  /**
   * How stock is costed (Phase 14, spec §5).
   *
   * One setting for the company, not one per item. Mixing methods within a set
   * of books makes the cost of sales figure unexplainable — an accountant
   * asked "how is this valued" has to answer "it depends which line", which is
   * not an answer. Weighted average by default: it is the simpler of the two
   * to explain, and it is what a business that has never thought about the
   * question is implicitly doing.
   */
  inventoryCostMethod: text('inventory_cost_method', {
    enum: ['fifo', 'weighted_average'],
  })
    .notNull()
    .default('weighted_average'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A person. Users are global (one login), companies are joined via membership,
 * which is what makes the accountant practice mode in spec §14 possible later.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** scrypt hash — see modules/auth/password.ts. Never a plaintext password. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: unique('users_email_unique').on(t.email),
  }),
)

/**
 * Join between a user and a company, carrying the role. Spec §14 requires each
 * professional to be invited as an individual account rather than sharing
 * owner credentials, so access is always a membership row.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    /**
     * Optional granular overrides on top of the role's defaults (spec §14).
     * Shape: { grant: Permission[], revoke: Permission[] }.
     */
    permissionOverrides: text('permission_overrides'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * The practice engagement that granted this membership (spec §14,
     * Phase 18). Null for somebody who works at the company itself.
     *
     * Named rather than inferred so that ending an engagement removes exactly
     * the memberships it created. A sweep by "everybody from that firm" would
     * also remove the bookkeeper who happens to work there *and* was hired
     * directly by the client — a real arrangement, and one where the two
     * grants are independent.
     *
     * Typed as a bare uuid with no foreign key: `practice_engagements` is
     * defined in `practice.ts`, which imports this file, and a reference the
     * other way is a cycle. The service is what keeps it honest, and the
     * engagement's own cascade would not help anyway — ending an engagement
     * keeps its row.
     */
    practiceEngagementId: uuid('practice_engagement_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyUserUnique: unique('memberships_company_user_unique').on(t.companyId, t.userId),
    userIdx: index('memberships_user_idx').on(t.userId),
    engagementIdx: index('memberships_engagement_idx').on(t.practiceEngagementId),
  }),
)

/** Platform a device reports. Advisory — used for labels, never for trust. */
export const devicePlatformEnum = pgEnum('device_platform', [
  'ios',
  'android',
  'web',
  'unknown',
])

/**
 * A signed-in device (spec §19).
 *
 * Sessions already existed; this names them. The reason is narrow and
 * practical: when a phone is lost, its owner needs to cut that one device off
 * without signing out of the laptop they are doing it from.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The company this device was last acting within, for the audit trail. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),

    /** What the person calls it. Defaults to something derived from the agent. */
    label: text('label').notNull(),
    platform: devicePlatformEnum('platform').notNull().default('unknown'),
    /** Truncated: enough to recognize a device, not enough to fingerprint one. */
    userAgent: text('user_agent'),

    /** True once the PWA reports itself installed rather than in a tab. */
    isInstalled: boolean('is_installed').notNull().default(false),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set rather than deleted: a revoked device stays in the history. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('devices_user_idx').on(t.userId, t.lastSeenAt),
  }),
)

/** Server-side session records. The cookie carries only a signed session id. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The company this session is currently acting within. */
    activeCompanyId: uuid('active_company_id').references(() => companies.id, {
      onDelete: 'cascade',
    }),
    /**
     * The device this session belongs to (spec §19, Phase 8).
     *
     * Nullable, because every session created before devices existed has no
     * device and must keep working. Revoking a device deletes its sessions,
     * which is the point: a lost phone is signed out without disturbing the
     * laptop doing the revoking.
     */
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
  }),
)
