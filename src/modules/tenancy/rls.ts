/**
 * The second layer, and the five ways it silently is not one (Phase 160).
 *
 * Spec §19 asks for tenant isolation in the database as well as in the
 * application. Phases 149 and 150 measured the application half — 110 writes
 * and 883 reads, every one guarded — and both ADRs said the same thing: row
 * level security is a *second* layer, not a substitute for the first, and it is
 * a migration nobody had written. ADRs 0157, 0158 and 0159 each re-nominated it.
 *
 * ## What measuring found before a line of it was written
 *
 * The application connects to Postgres as `postgres`. That role is a
 * **superuser** and it **owns all 181 tables**.
 *
 * Row level security does not apply to superusers at all, and does not apply to
 * a table's owner unless `FORCE ROW LEVEL SECURITY` is also set. So the obvious
 * version of this phase —
 *
 * ```sql
 * ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
 * CREATE POLICY tenant ON invoices USING (company_id = current_setting('app.company_id')::uuid);
 * ```
 *
 * — repeated across every tenant-scoped table would have produced 163 rows in
 * `pg_policies`, 163 tables reporting `relrowsecurity`, a line in the release
 * notes, and
 * **exactly no isolation**. Every policy inert. Every query unaffected. And the
 * next person to audit this database, or the next security questionnaire, would
 * read `pg_policies` and conclude the tenants were separated at the storage
 * layer.
 *
 * That is this project's oldest defect — a declaration argued from a fact that
 * is not a fact (Phases 110, 125) — in the worst possible place: a security
 * control that looks present and does nothing. It is also Phase 121's rule at
 * its most dangerous, because a policy that is never consulted is a check that
 * can only ever agree.
 *
 * So this module is not a policy generator with a hazard list attached. It is
 * the hazard list, with a policy generator attached.
 *
 * ## What is here and what is not
 *
 * Here: the predicate, the statements that install it, the register of ways it
 * does nothing, and `rlsStands`, which takes **measured** facts about a live
 * connection and says whether the policies on it can bite.
 *
 * Not here: a claim that production is isolated at the database layer. It is
 * not, and `RLS_ROLLOUT` says so. The migration installs the mechanism and
 * forces it; switching the application's connection to a role the mechanism
 * applies to is a deployment change, and until somebody makes it the first
 * layer is the only layer — exactly as it was before this phase, with the
 * difference that the second layer now exists, is proven to work against the
 * restricted role in `tests/rls-bites.test.ts`, and has a check that refuses to
 * call it on.
 */

import { RegistryError } from '@/modules/errors/registry'

/**
 * The setting a policy reads the tenant from.
 *
 * A namespaced GUC rather than a temporary table or a session role, because it
 * is the only one of the three that `SET LOCAL` scopes to a transaction — which
 * is the whole of the correctness argument below.
 */
export const RLS_GUC = 'app.company_id'

/** The column every tenant-scoped table carries. */
export const TENANT_COLUMN = 'company_id'

/** The role the application should connect as once the deployment switches. */
export const APP_ROLE = 'accountrix_app'

/**
 * The predicate, which has to fail closed.
 *
 * `current_setting(name, true)` returns `NULL` for a setting nobody has set,
 * rather than raising — and `company_id = NULL` is `NULL`, which is not `true`,
 * so the row is filtered out. **A query with no tenant set sees nothing.**
 *
 * That is the single most important property of this string and it is easy to
 * lose. Written the inviting way —
 *
 * ```sql
 * company_id = coalesce(current_setting('app.company_id', true)::uuid, company_id)
 * ```
 *
 * — a forgotten `SET LOCAL` returns **every tenant's rows**, and it does so
 * silently, on a path that was working a moment ago. The two differ by one
 * `coalesce` and they are opposites: one fails closed and one fails open.
 *
 * ## The `nullif`, which the acceptance test put there
 *
 * This function first returned the predicate without it, on the reasoning above,
 * and the reasoning was incomplete. Once a custom GUC has been set *at all* in a
 * session — including by a `SET LOCAL` that has since rolled back — Postgres
 * remembers it and `current_setting(name, true)` returns the **empty string**
 * rather than `NULL`. So the predicate became `company_id = ''::uuid`, which
 * does not filter: it raises `invalid input syntax for type uuid: ""`.
 *
 * That is still fail-closed — an error leaks nothing — but it is a 500 on a
 * pooled connection whose previous occupant happened to set a tenant, which is
 * a bug that appears under load and not in development. `nullif(…, '')` turns
 * both states back into `NULL` and both into no rows.
 *
 * Worth recording how it was found: the test asserting *"sees nothing at all
 * when no tenant is set"* failed, because it threw instead of returning zero.
 * The prose above had asserted the property confidently and the property did not
 * hold on a connection that had been used once.
 *
 * Without the `true` second argument `current_setting` raises
 * `unrecognized configuration parameter`, which also does not leak but turns
 * every unset query into a 500 rather than an empty result. Fail closed and
 * explicable beats fail closed and inexplicable.
 */
export function tenantPredicate(): string {
  return `${TENANT_COLUMN} = nullif(current_setting('${RLS_GUC}', true), '')::uuid`
}

/**
 * The statements that put one table behind the predicate.
 *
 * Four, and the second is the one this phase is about.
 *
 * `FORCE ROW LEVEL SECURITY` makes the policy apply to the table's **owner**
 * too. Without it, a connection as the owner — which is what this application
 * has always made — is exempt, so the other three statements would be
 * decoration. It does not help against a superuser; nothing does, which is why
 * `rlsStands` checks the role rather than trusting the DDL.
 *
 * `FOR ALL` with both `USING` and `WITH CHECK` because a policy needs to do two
 * different jobs: `USING` decides which existing rows a statement can see,
 * `WITH CHECK` decides which rows it may write. A policy with only `USING`
 * lets a tenant **insert** a row carrying somebody else's `company_id` — the
 * row then vanishes from their own view, which is the worst shape of bug: the
 * write succeeds, the data lands in another tenant, and the writer sees nothing
 * wrong.
 */
export function policyStatementsFor(table: string): string[] {
  const predicate = tenantPredicate()
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${table}`,
    `CREATE POLICY tenant_isolation ON ${table} FOR ALL TO ${APP_ROLE} USING (${predicate}) WITH CHECK (${predicate})`,
  ]
}

/** Why a tenant-scoped table is nonetheless left unpoliced. */
export type ExemptionGround =
  /**
   * The table is read in order to work out which tenant the caller is in.
   *
   * A policy keyed on `app.company_id` cannot protect a table the setting is
   * derived *from* — the read happens before there is anything to set. There is
   * no ordering that fixes it, which is what makes this a ground rather than a
   * sequencing problem.
   */
  | 'establishes-the-tenant'

export type Exemption = {
  table: string
  ground: ExemptionGround
  /** What policing it would actually do, which is the part that decides. */
  consequence: string
}

/**
 * Tenant-scoped tables that must **not** be policed, and what happens if they are.
 *
 * The migration's first draft protected every table carrying a `company_id` —
 * 167 of them — and `tests/rls-bites.test.ts` failed on `memberships`. Chasing
 * that found four, and they are not an oversight in the rule. They are a
 * property of what those tables are for: **each one is read in order to decide
 * who the caller is and what they may do, which is strictly before any tenant
 * can be set.**
 *
 * Two of the four would have degraded *silently*, and those are the ones worth
 * the register. A policy that breaks sign-in gets noticed in a minute. A policy
 * that makes a revoked device read as live, or a security policy read as absent,
 * is a security control weakening authentication while reporting success — which
 * is the same shape as the inert-policy problem this whole phase is about,
 * arrived at from the opposite direction.
 *
 * This is also why the migration cannot loop over `information_schema` alone.
 * "Has a `company_id`" is a good rule and it is not the whole rule, and the
 * exception list has to carry its reasons or somebody will delete it.
 */
export const RLS_EXEMPT: readonly Exemption[] = [
  {
    table: 'memberships',
    ground: 'establishes-the-tenant',
    consequence:
      'Sign-in stops working. `resolveSession` reads this table on every request to get the ' +
      'caller’s role, and the tenant it would filter by is the row it is reading. With no setting ' +
      'the read returns nothing and every request resolves as signed out; `companiesForUser` ' +
      'returns an empty company picker, so there is no way to choose a tenant either. Circular, ' +
      'and loud.',
  },
  {
    table: 'devices',
    ground: 'establishes-the-tenant',
    consequence:
      '**A revoked device reads as live.** `resolveSession` left-joins devices to check ' +
      '`deviceRevokedAt`, and a left join against an invisible row yields NULL rather than failing ' +
      '— which this code reads as "not revoked". So adding row level security would quietly undo ' +
      'device revocation, a Phase 8 security feature, in the name of security. Silent, and the ' +
      'worst of the four.',
  },
  {
    table: 'security_policies',
    ground: 'establishes-the-tenant',
    consequence:
      '**The company’s security policy reads as absent**, so lockout thresholds, session lifetime ' +
      'and any MFA requirement fall back to defaults on the authentication path that is supposed ' +
      'to enforce them. Read by `requireActor` before any domain query, and therefore before ' +
      'anything has set a tenant. Also silent.',
  },
  {
    table: 'practice_engagements',
    ground: 'establishes-the-tenant',
    consequence:
      'A practice user loses the `viaPractice` label that says they are acting through their firm ' +
      '— left-joined in the same session query, so it degrades to NULL rather than failing. The ' +
      'audit log then records the acting person without recording that they work for the client’s ' +
      'accountants, which is exactly the distinction `recordAudit` was given that field for.',
  },
]

/** The exemption for a table, or `null` when it is policed like the rest. */
export function exemptionFor(table: string): Exemption | null {
  return RLS_EXEMPT.find((row) => row.table === table) ?? null
}

/** Tables the policy is installed on: tenant-scoped, less the exemptions. */
export function policedTables(tenantTables: readonly string[]): string[] {
  return tenantTables.filter((table) => exemptionFor(table) === null)
}

/** Why a policy that exists does not apply. */
export type BypassReason =
  /** The connecting role is a superuser. */
  | 'superuser'
  /** The role owns the table and the table is not forced. */
  | 'unforced-owner'
  /** The role carries the `BYPASSRLS` attribute. */
  | 'bypassrls'
  /** A policy exists on a table whose RLS is not enabled. */
  | 'policy-without-enable'
  /** The tenant is set with `SET` rather than `SET LOCAL`, on a pooled connection. */
  | 'session-scoped-setting'

export type Bypass = {
  reason: BypassReason
  /** What it looks like from outside — the reason it is worth a register. */
  appearance: string
  /** Why it happens, in terms somebody can check. */
  because: string
  /** What makes it stop. */
  remedy: string
}

/**
 * Every way row level security can be installed and do nothing (Phase 160).
 *
 * The registry-with-prose device (Phase 101), and the reason this one exists is
 * narrower than usual: **four of these five leave the database reporting that
 * RLS is on.** `relrowsecurity` is true, `pg_policies` has rows, and the
 * isolation is absent. A register of the ways a control lies about itself is
 * worth more than the control.
 *
 * The fifth — `session-scoped-setting` — is the opposite and worse: it does not
 * silently permit everything, it silently permits *the wrong tenant*, which is
 * a cross-tenant read that looks like a correct one.
 */
export const RLS_BYPASSES: readonly Bypass[] = [
  {
    reason: 'superuser',
    appearance:
      'Perfect. `relrowsecurity` is true, the policies are listed, and every query returns every ' +
      'tenant’s rows exactly as it did before the migration — so nothing breaks and nobody looks.',
    because:
      'Postgres never applies row level security to a superuser. Not with FORCE, not with any ' +
      'policy: the check is skipped before the policy is consulted. This application connects as ' +
      '`postgres`, which is a superuser, which is how this phase found the problem.',
    remedy:
      'Connect as a role that is not a superuser. `rlsStands` refuses an observation whose role ' +
      'is one, because no DDL can compensate.',
  },
  {
    reason: 'unforced-owner',
    appearance:
      'Also perfect, and for a second reason — so fixing the superuser problem alone would leave ' +
      'this one, and the symptoms are identical.',
    because:
      'A table’s owner is exempt from its own policies unless `FORCE ROW LEVEL SECURITY` is set. ' +
      '`postgres` owns all 181 tables here, and a deployment that creates its app role as the ' +
      'migration runner would own them too.',
    remedy:
      '`ALTER TABLE … FORCE ROW LEVEL SECURITY`, which `policyStatementsFor` emits as its second ' +
      'statement, and a role that does not own the tables anyway.',
  },
  {
    reason: 'bypassrls',
    appearance:
      'Perfect, and the hardest of the five to notice, because the role is not a superuser and the ' +
      'tables are forced — everything a reviewer would check looks right.',
    because:
      'The `BYPASSRLS` role attribute does what it says. It is sometimes granted to a migration or ' +
      'backup role and then reused for the application because it already had the permissions it ' +
      'needed.',
    remedy:
      '`ALTER ROLE … NOBYPASSRLS`, and a separate role for migrations. `rlsStands` reads the ' +
      'attribute rather than assuming it.',
  },
  {
    reason: 'policy-without-enable',
    appearance:
      '`pg_policies` is full. Somebody auditing this database by listing policies — which is what ' +
      'an auditor does — reads 163 of them and concludes the tenants are separated.',
    because:
      '`CREATE POLICY` succeeds on a table whose row level security is not enabled. The policy is ' +
      'stored, listed, and never consulted. The two statements are independent and only one of ' +
      'them is the switch.',
    remedy:
      '`ALTER TABLE … ENABLE ROW LEVEL SECURITY`, and the measured check below, which compares the ' +
      'count of policies against the count of enabled tables rather than trusting either.',
  },
  {
    reason: 'session-scoped-setting',
    appearance:
      'Isolation works. It works in development, it works in tests, and it works in production ' +
      'under light load — until two requests land on the same pooled backend, and then one tenant ' +
      'reads another tenant’s books through a query that is filtering correctly on the value it ' +
      'was given.',
    because:
      'A plain `SET app.company_id` lasts for the life of the *connection*, and postgres-js keeps ' +
      'a pool of up to ten. The next request to be handed that backend inherits whatever the last ' +
      'one set, and the policy faithfully applies it. Nothing errors.',
    remedy:
      '`SET LOCAL`, inside a transaction, which Postgres scopes to the transaction and rolls back ' +
      'with it. `withTenant` is the only sanctioned way to set it, and it opens a transaction for ' +
      'exactly this reason.',
  },
]

/** The bypass a reason names. Throws on one nobody declared. */
export function bypassFor(reason: string): Bypass {
  const found = RLS_BYPASSES.find((row) => row.reason === reason)
  if (!found) {
    throw new RegistryError({
      registry: 'RLS_BYPASSES',
      key: reason,
      message:
        `No row-level-security bypass is declared as "${reason}". The register is the list of ways ` +
        'this control can be installed and do nothing, so a new one is an entry there with what it ' +
        'looks like from outside — which is the part that matters, because four of the five look ' +
        'like success.',
    })
  }
  return found
}

/**
 * What was measured about a live connection and the schema behind it.
 *
 * Every field is a fact read from the database — `pg_roles`, `pg_class`,
 * `pg_policies`, `current_setting` — rather than a configuration value somebody
 * wrote down. Phase 141's rule: declare the knowledge, measure the fact. The
 * knowledge is `RLS_BYPASSES`; these are the facts.
 */
export type RlsObservation = {
  /** `current_user` on the connection the application actually uses. */
  role: string
  isSuperuser: boolean
  canBypassRls: boolean
  /** Tables the role owns, out of those that should be protected. */
  ownedTenantTableCount: number
  /** Tenant-scoped tables, from the schema source. */
  tenantTableCount: number
  /** Of those, how many have RLS enabled. */
  enabledCount: number
  /** Of those, how many are forced. */
  forcedCount: number
  /** Policies named `tenant_isolation`. */
  policyCount: number
  /**
   * How the tenant is set on this connection.
   *
   * `transaction-local` is the only safe answer with a pool. `session` is
   * `session-scoped-setting` above; `unset` means the application has not wired
   * `withTenant` in, which fails closed and so is a liveness problem rather
   * than a leak.
   */
  settingScope: 'transaction-local' | 'session' | 'unset'
}

/**
 * Whether the policies on this connection can actually bite.
 *
 * Returns the reasons they cannot, worst first. Empty means the second layer is
 * real on this connection — which, as of this phase, is true in
 * `tests/rls-bites.test.ts` and not true in production.
 *
 * Deliberately takes an observation rather than reading the database itself, so
 * every state can be written down in a test. A security check whose failing
 * cases cannot be exercised is Phase 121's problem again.
 */
export function rlsStands(observed: RlsObservation): string[] {
  const faults: string[] = []

  if (observed.isSuperuser) {
    const bypass = bypassFor('superuser')
    faults.push(
      `${observed.role} is a superuser, so row level security is skipped before any policy is ` +
        `consulted. ${bypass.appearance} ${bypass.remedy}`,
    )
  }

  if (observed.canBypassRls) {
    faults.push(
      `${observed.role} carries BYPASSRLS. ${bypassFor('bypassrls').remedy}`,
    )
  }

  if (observed.ownedTenantTableCount > 0 && observed.forcedCount < observed.tenantTableCount) {
    faults.push(
      `${observed.role} owns ${observed.ownedTenantTableCount} of the tables it is meant to be ` +
        `restricted on, and ${observed.tenantTableCount - observed.forcedCount} are not forced. ` +
        `${bypassFor('unforced-owner').because}`,
    )
  }

  if (observed.enabledCount < observed.tenantTableCount) {
    faults.push(
      `${observed.tenantTableCount - observed.enabledCount} tenant-scoped tables do not have row ` +
        `level security enabled. ${bypassFor('policy-without-enable').appearance}`,
    )
  }

  if (observed.policyCount < observed.tenantTableCount) {
    faults.push(
      `${observed.tenantTableCount - observed.policyCount} tenant-scoped tables have no ` +
        'tenant_isolation policy. A table with RLS enabled and no policy denies every row, which ' +
        'fails closed rather than open — so this is an outage rather than a leak, and it is still ' +
        'wrong.',
    )
  }

  if (observed.settingScope === 'session') {
    const bypass = bypassFor('session-scoped-setting')
    faults.push(
      `The tenant is set for the session rather than the transaction. ${bypass.because} ` +
        `${bypass.remedy}`,
    )
  }

  return faults
}

/**
 * The statement that sets the tenant for one transaction.
 *
 * `set_config(name, value, true)` rather than `SET LOCAL app.company_id = $1`,
 * because `SET` does not take a parameter — the value has to be interpolated
 * into the SQL text, and interpolating a value into SQL is the thing this
 * codebase does not do. `set_config` is an ordinary function call and takes an
 * ordinary bind parameter.
 *
 * The third argument is `is_local`. `true` is the difference between this phase
 * and a cross-tenant leak, and it is one boolean.
 */
export const SET_TENANT_SQL = `select set_config('${RLS_GUC}', $1, true)`

/** Where the rollout has got to, per surface. */
export type RolloutState =
  /** The mechanism applies and is proven to. */
  | 'live'
  /** Installed, and bypassed because of how this surface connects. */
  | 'bypassed'

export type RolloutEntry = {
  surface: string
  state: RolloutState
  /** Why it is in that state, and what moves it. */
  because: string
}

/**
 * What the second layer actually covers, stated rather than implied.
 *
 * Phase 139's device: a staged core gets a register and an acceptance test, so
 * nobody has to guess how far it got. The honest summary is that the mechanism
 * is installed on all 163 policed tables and the application does not yet
 * connect as a
 * role it applies to — and saying that in a register beats saying it in a commit
 * message nobody re-reads.
 *
 * This register is the reason the phase can be shipped at all. Without it the
 * choice would be between shipping inert policies and calling them isolation,
 * or not shipping until a deployment change nobody here can make.
 */
export const RLS_ROLLOUT: readonly RolloutEntry[] = [
  {
    surface: 'tests/rls-bites.test.ts',
    state: 'live',
    because:
      'Opens its own connection as `accountrix_app` — not a superuser, owns nothing — and proves ' +
      'the policies separate two companies’ rows, refuse a write into another tenant, and return ' +
      'nothing at all when no tenant is set. This is the acceptance test, and it is what makes the ' +
      'mechanism a fact rather than a claim.',
  },
  {
    surface: 'tests/a-report-through-the-policies.test.ts',
    state: 'live',
    because:
      'Phase 161. Runs `trialBalance`, `accountBalances`, `arAging` and `listAccounts` — real ' +
      'service functions that take no executor and read the module-level `db` — on the restricted ' +
      'connection inside a tenant scope, and gets the same figures as the owner connection. That ' +
      'is what the scope was for: Phase 160’s `withTenant` had no caller and could not have one, ' +
      'because 903 call sites reach `db` directly and 802 service entry points have no executor ' +
      'parameter to pass. The tenant is now carried by the connection `db` resolves to, so none of ' +
      'those 903 changed.',
  },
  {
    surface: 'the application’s own connection',
    state: 'bypassed',
    because:
      'It connects as `postgres`, a superuser that owns every table, so the policies are skipped ' +
      'before they are consulted. Changing that is a deployment change — a new DATABASE_URL using ' +
      '`accountrix_app`. Phase 161 removed the other half of the obstacle: a query no longer needs ' +
      'to be rewritten to carry the tenant, because `db` resolves to the scope’s connection. What ' +
      'remains is that **something has to open a scope once per request**, and Next.js’s App Router ' +
      'has no single place that wraps a render — so that is a per-surface change rather than a ' +
      'line. Until it is done the first layer is the only layer, and `rlsStands` is what refuses ' +
      'to call it otherwise.',
  },
]

/** How far the rollout has got, as a sentence for an ADR or a status page. */
export function rolloutSummary(): string {
  const live = RLS_ROLLOUT.filter((entry) => entry.state === 'live').length
  return (
    `Row level security is installed and forced on every policed table, and applies on ${live} of ` +
    `${RLS_ROLLOUT.length} surfaces — including real service functions that were never modified ` +
    'for it. It does not yet apply to the application’s own connection, which is a superuser that ' +
    'owns the tables, and nothing opens a tenant scope per request yet. So the database layer is ' +
    'proven to work on real reports and is not yet carrying production traffic.'
  )
}
