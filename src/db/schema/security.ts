import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  index,
  unique,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { companies, users } from './tenancy'

/**
 * Multi-factor authentication and the sign-in record (spec §14: "MFA support,
 * session/device controls, login history, and revocation"; §19).
 *
 * Sessions and devices already exist — Phase 8 built them for the mobile app,
 * and they turned out to be the general thing rather than a mobile thing. What
 * was missing is everything about *getting* a session: a second factor, and a
 * record of who tried.
 */

/**
 * A user's second factor.
 *
 * One row per user, not per membership. A second factor protects the account,
 * and an accountant who works for four companies has one phone — asking them
 * to enrol four times would train them to skip it.
 */
export const userMfa = pgTable(
  'user_mfa',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The TOTP secret, encrypted (see `auth/secret-box.ts`).
     *
     * It cannot be hashed the way a password is, because the server has to
     * reproduce codes from it. Encryption with a key held outside the database
     * is the next best thing: a leaked dump yields ciphertext.
     */
    secretEncrypted: text('secret_encrypted').notNull(),

    /**
     * Null until a code has been verified.
     *
     * Enrolment is two steps on purpose. Enabling on generation alone locks
     * out anyone who mistyped the secret or scanned the wrong QR code, and
     * they find out at their next sign-in with no way back in.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

    /**
     * The last TOTP step successfully used.
     *
     * This is what stops a code being replayed inside its own window — read
     * over a shoulder, or captured by a phishing page a second after the
     * victim typed it. Without it a code is good for a minute, to anybody.
     */
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUnique: unique('user_mfa_user_unique').on(t.userId),
  }),
)

/**
 * Single-use codes for when the phone is gone.
 *
 * Hashed with the same function as passwords, because that is exactly what
 * they are: a stored string that grants access. A recovery code list kept in
 * plaintext is a password list.
 *
 * `usedAt` rather than deletion, so "I used four of my ten codes" is
 * answerable and a used code cannot be silently reissued.
 */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('mfa_recovery_codes_user_idx').on(t.userId, t.usedAt),
  }),
)

/**
 * How a sign-in attempt ended.
 *
 * Named outcomes rather than a boolean, because the useful questions are all
 * about *which* failure. "Twelve wrong passwords for one address" and "twelve
 * addresses that do not exist" look identical under a boolean and mean
 * completely different things.
 */
export const loginOutcomeEnum = pgEnum('login_outcome', [
  'success',
  'unknown_email',
  'wrong_password',
  'mfa_required',
  'wrong_mfa_code',
  'reused_mfa_code',
  'locked_out',
  'no_membership',
])

/**
 * Every attempt to sign in (spec §14: "login history", §19: "complete
 * auditability of privileged actions").
 *
 * Its own table rather than rows in `audit_events`, for two reasons. Audit
 * events are scoped to a company and a failed sign-in has no company — nobody
 * has proved which one they belong to. And this table is written on the
 * unauthenticated path, where an attacker controls the rate; keeping that
 * volume out of the audit log is what stops a password-spraying run from
 * burying the record of a real change.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Lower-cased. Stored even when no such user exists, because "somebody is
     * trying addresses that are not ours" is the signal that a list is being
     * worked through.
     */
    email: text('email').notNull(),
    /** Null when the address matched nothing. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    outcome: loginOutcomeEnum('outcome').notNull(),

    /**
     * Truncated to the network rather than the host — the last octet of IPv4
     * and everything below /48 of IPv6 are dropped.
     *
     * Enough to tell "the same place" from "somewhere new", which is what the
     * history is read for, without keeping a precise location log of a
     * person's movements. Spec §19 asks for privacy controls and this is the
     * one table where the tension is real.
     */
    ipPrefix: text('ip_prefix'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Drives the lockout check: attempts for this address, recently.
    emailTimeIdx: index('login_attempts_email_time_idx').on(t.email, t.createdAt),
    userTimeIdx: index('login_attempts_user_time_idx').on(t.userId, t.createdAt),
  }),
)

/**
 * A company's security policy (spec §14).
 *
 * Separate from `companies` because it is a different thing being edited by a
 * different person for a different reason, and because a policy row that does
 * not exist means "the defaults", which is exactly what a new company wants.
 */
export const securityPolicies = pgTable(
  'security_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /**
     * When true, a member without a confirmed second factor can reach nothing
     * but the enrolment page.
     *
     * This is what makes MFA a control rather than a feature. Opt-in MFA is
     * adopted by the people who were never the risk.
     */
    requireMfa: boolean('require_mfa').notNull().default(false),

    /** Failed attempts before an address is locked out, and for how long. */
    maxFailedAttempts: integer('max_failed_attempts').notNull().default(10),
    lockoutMinutes: integer('lockout_minutes').notNull().default(15),

    /** Sessions are cut this many days after they are created. */
    sessionTtlDays: integer('session_ttl_days').notNull().default(30),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    companyUnique: unique('security_policies_company_unique').on(t.companyId),
    // A lockout of zero attempts locks everybody out immediately; a TTL of
    // zero signs everybody out on arrival. Both are settings somebody could
    // type by accident and neither has a use.
    sane: check(
      'security_policies_sane',
      sql`${t.maxFailedAttempts} >= 3 AND ${t.lockoutMinutes} >= 1 AND ${t.sessionTtlDays} >= 1`,
    ),
  }),
)

/**
 * A generated export of a company's data (spec §19: "users must be able to
 * export their accounting records and key business data").
 *
 * Recorded rather than streamed and forgotten, because an export is the single
 * broadest read anybody can perform: one file with the whole ledger in it.
 * Who took one, when, and how much it contained is exactly what an audit of a
 * data-loss incident asks for.
 */
export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),

    /** Which datasets were included, so a partial export is not mistaken for all of it. */
    datasets: text('datasets').notNull(),
    rowCount: integer('row_count').notNull().default(0),
    byteCount: integer('byte_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('data_exports_company_idx').on(t.companyId, t.createdAt),
  }),
)

/**
 * A password typed at one of Phase 99's guarded acts (Phase 100).
 *
 * Its own table rather than a `login_outcome` on `login_attempts`, because
 * `lockoutState` counts every row in its window that is not 'success' and not
 * 'locked_out'. A re-authentication failure recorded there would be counted as
 * a failed sign-in, so five fumbles on the security page would lock the account
 * out of signing in — handing somebody who already holds a session a way to
 * lock the real owner out. The guard would become a weapon.
 *
 * Keyed on the user rather than an email: `login_attempts` uses an email
 * because at sign-in time that is all anybody knows, and here the session says
 * exactly who is asking.
 */
export const guardAttempts = pgTable(
  'guard_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * A `GuardedAct` from the register in `reauthentication.ts`, as text.
     *
     * ADR 0033's reasoning for integrity check keys: the register is code, and
     * a foreign key to a table of names pointing at functions is a foreign key
     * to something that may not exist.
     */
    act: text('act').notNull(),
    ok: boolean('ok').notNull(),
    /** Truncated as `login_attempts` truncates it, so the two agree. */
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('guard_attempts_user_act_idx').on(t.userId, t.act, t.createdAt)],
)
