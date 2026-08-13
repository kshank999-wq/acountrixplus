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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyUserUnique: unique('memberships_company_user_unique').on(t.companyId, t.userId),
    userIdx: index('memberships_user_idx').on(t.userId),
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
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
  }),
)
