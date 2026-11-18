import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { RegistryError } from '@/modules/errors/registry'
import { ROLE_NAMES, ROLE_PERMISSIONS, type Permission, type Role } from '@/modules/permissions'
import { functionBody, permissionChecksIn, resolveComputedGate } from './gate-forms'
import { declaresFunction, withoutComments } from './enclosing'
import { sourceFiles } from './isolation-scan'

/**
 * Whether a gate names the **right** permission (spec §14, §13, §19).
 *
 * ## The question the last three phases do not ask
 *
 * Phase 214 asked *is there a gate?* Phase 215 asked *can the refusal say why?*
 * Phase 216 asked *did the caller establish the permission?* Here is a function
 * that answers all three yes:
 *
 * ```ts
 * export async function sendStatement(ctx: ActorContext, statementId: string) {
 *   requirePermission(ctx, 'accounting:view')
 *   …  // emails the statement to the customer
 * }
 * ```
 *
 * There is a gate. Every caller reaches it. It throws a `PermissionError` that
 * names its permission. And `readonly` holds `accounting:view`, so the one role
 * whose entire definition is that it changes nothing emailed the company's
 * customers — and `runStatements` did not fail part-way, it **completed**,
 * because `saveStatement` settled for the same permission.
 *
 * The missing question is whether the permission matches what the act does, and
 * the permission table answers it without any new vocabulary. Five permissions
 * are built from the word *view*, and one role holds nothing else:
 *
 * ```ts
 * readonly: ['bookkeeping:view', 'reconciliation:view', 'accounting:view',
 *            'reports:view', 'jobs:view'],
 * ```
 *
 * > **A permission that a view-only role holds must not be the only gate on an
 * > act that writes or sends.**
 *
 * Which roles are view-only is computed from `ROLE_PERMISSIONS` rather than
 * listed — today exactly one — so the oracle moves when the role table moves.
 * That is Phase 216's arm 2 used as a definition rather than as an implication.
 *
 * ## Why the register is of endpoints and the falsifier is of acts
 *
 * ADR 0216 proposed measuring each action against its page's guard. A page guard
 * says who may look at a screen: gating `runChases` on the `accounting:view` its
 * page guards would have satisfied that property and still let a read-only user
 * send dunning letters. So the page plays no part here. What `OPEN_ENDPOINTS`
 * records is the other half — the server actions that establish no permission at
 * all, each with the reason that is right — because an action is an HTTP endpoint
 * and nothing upstream of it is a gate.
 *
 * ## The scan was wrong four times, and that is why the counts are pinned
 *
 * `establishedBy` reads a function's own body, then follows **functions declared
 * in the same file** and **both import forms**. Each of those came from a false
 * positive:
 *
 *  - body only: `planImportAction` (gates behind `buildPlan`, a helper in the
 *    action file), `rejectSuggestion` (`decide` requires `ai:use`), and
 *    `deleteTime`/`updateTime`/`submitTime` (`loadOwnEditable` requires
 *    `users:manage` for somebody else's timesheet);
 *  - `@/modules/...` only: this codebase imports a sibling in the same module
 *    relatively — `import { transactionContext } from './retrieval'` — and a
 *    gate's commonest home is a sibling file. Reading one form moved the ungated
 *    count from 47 to 39 and cleared four acts that a draft of ADR 0217 named as
 *    defects.
 *
 * Both are ADR 0134's shape and both are false *positives*, which Phase 126 puts
 * on the worse side: a finding that overstates reads exactly like one that holds.
 * The count is asserted against this register, so a scan that regresses to one
 * import form fails rather than quietly growing it.
 *
 * Nothing here touches the database or the clock.
 */

/** Why a server action may establish no permission. */
export type OpenEndpointCategory =
  /** No actor exists yet: signing up, signing in, signing out. */
  | 'bootstrap'
  /** Authorised by a bearer token in the URL, not by a role. */
  | 'token'
  /** Acts on the caller's own account, devices or preferences. */
  | 'self'
  /** Authorised by `requirePracticeOwner`, which is not a `Permission`. */
  | 'practice'
  /** Computes on client-supplied input and reads no company data. */
  | 'pure'

export type OpenEndpoint = {
  /** File under `src/app/actions`, without the extension. */
  file: string
  /** The exported action. */
  action: string
  category: OpenEndpointCategory
  why: string
}

const SELF_ACCOUNT =
  'Acts on the caller’s own account. A role cannot be the authority here: every ' +
  'role must be able to do this for themselves and none may do it for anybody ' +
  'else, which `ctx.userId` decides and a permission cannot.'

const SELF_DEVICE =
  'Acts on the caller’s own device registration or notification preference, ' +
  'identified by `ctx.userId`. A permission would be the wrong question: the ' +
  'readonly role needs its own phone as much as the owner does.'

const PRACTICE =
  'On the practice side, authorised by `requirePracticeOwner` rather than by a ' +
  '`Permission` — a practice is not a company and its membership is not a role ' +
  'in `ROLE_PERMISSIONS` (Phase 214’s ninth gate form).'

/**
 * Every server action that establishes no permission.
 *
 * Measured, not listed: `ungatedActions()` is what says these are the 38, and
 * the falsifier compares the two. Two entries left this register by being
 * fixed — `runChasesNowAction` and `runStatementsNowAction` — and one by having
 * its act gated, `installCostCodesAction`, which is the only way an entry should
 * leave.
 */
export const OPEN_ENDPOINTS: readonly OpenEndpoint[] = [
  {
    file: 'auth',
    action: 'registerAction',
    category: 'bootstrap',
    why: 'Creates the first user and company. There is no actor to check, which is the point of it.',
  },
  {
    file: 'auth',
    action: 'loginAction',
    category: 'bootstrap',
    why:
      'Verifies a password and issues a challenge. A permission check here would ' +
      'require the session it is about to create.',
  },
  {
    file: 'auth',
    action: 'verifyMfaAction',
    category: 'bootstrap',
    why:
      'Second factor for a challenge issued by `loginAction`. Authorised by the ' +
      'challenge cookie, which is narrower than any role.',
  },
  {
    file: 'auth',
    action: 'logoutAction',
    category: 'bootstrap',
    why:
      'Destroys the caller’s own session. A refusal would leave somebody signed in ' +
      'against their wish, which no permission model should be able to do.',
  },
  {
    file: 'auth',
    action: 'requestAddressChangeAction',
    category: 'self',
    why:
      SELF_ACCOUNT +
      ' It also re-checks the current password, so the authority is the secret ' +
      'rather than the role.',
  },
  {
    file: 'mobile',
    action: 'revokeDeviceAction',
    category: 'self',
    why: SELF_DEVICE,
  },
  { file: 'mobile', action: 'renameDeviceAction', category: 'self', why: SELF_DEVICE },
  { file: 'mobile', action: 'subscribePushAction', category: 'self', why: SELF_DEVICE },
  { file: 'mobile', action: 'unsubscribePushAction', category: 'self', why: SELF_DEVICE },
  { file: 'mobile', action: 'setNotificationPreferenceAction', category: 'self', why: SELF_DEVICE },
  {
    file: 'notify',
    action: 'requestResetAction',
    category: 'token',
    why:
      'Starts a password reset for an address. Deliberately answers the same way ' +
      'whether the address exists, so there is nothing a role could gate.',
  },
  {
    file: 'notify',
    action: 'completeResetAction',
    category: 'token',
    why: 'Authorised by the reset token, which is single-use and narrower than a role.',
  },
  {
    file: 'notify',
    action: 'inviteToPracticeAction',
    category: 'practice',
    why: PRACTICE,
  },
  {
    file: 'notify',
    action: 'acceptInvitationAction',
    category: 'token',
    why:
      'Authorised by the invitation token. The caller has no membership yet — ' +
      'accepting is what creates one.',
  },
  {
    file: 'pay',
    action: 'startPaymentAction',
    category: 'token',
    why:
      'The customer’s own payment page, reached by an invoice share token. The ' +
      'payer is not a member of the company and has no role in it at all.',
  },
  {
    file: 'pay',
    action: 'canTakeCards',
    category: 'token',
    why:
      'Whether the public payment page can offer cards. Serves the same tokened ' +
      'page and discloses one boolean about configuration.',
  },
  {
    file: 'payroll',
    action: 'previewPayrollAction',
    category: 'pure',
    why:
      'Arithmetic on payslip figures the client supplied. It discards the actor ' +
      'and reads nothing: there is no company data for a permission to protect.',
  },
  {
    file: 'payroll',
    action: 'calculatePayrollAction',
    category: 'pure',
    why:
      'As `previewPayrollAction`: the provider computes from employee figures in ' +
      'the request. Saving the result is a separate, gated act.',
  },
  { file: 'practice-search', action: 'findPracticesAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'setBriefPreferenceAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'switchCompanyAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'createPracticeAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'requestEngagementAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'inviteStaffAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'removePracticeMemberAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'setPracticeActiveAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'enterClientAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'assignToEngagementAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'unassignFromEngagementAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'setEngagementStaffingAction', category: 'practice', why: PRACTICE },
  { file: 'practice', action: 'staffingForAction', category: 'practice', why: PRACTICE },
  {
    file: 'security',
    action: 'beginMfaEnrollmentAction',
    category: 'self',
    why: SELF_ACCOUNT,
  },
  { file: 'security', action: 'confirmMfaEnrollmentAction', category: 'self', why: SELF_ACCOUNT },
  { file: 'security', action: 'disableMfaAction', category: 'self', why: SELF_ACCOUNT },
  { file: 'security', action: 'regenerateRecoveryCodesAction', category: 'self', why: SELF_ACCOUNT },
  { file: 'security', action: 'changePasswordAction', category: 'self', why: SELF_ACCOUNT },
  { file: 'security', action: 'revokeDeviceAction', category: 'self', why: SELF_DEVICE },
  { file: 'security', action: 'revokeOtherDevicesAction', category: 'self', why: SELF_DEVICE },
]

const KEY = (file: string, action: string) => `${file}::${action}`

/** The declared reason an endpoint needs no permission, or a refusal naming it. */
export function openEndpoint(file: string, action: string): OpenEndpoint {
  const found = OPEN_ENDPOINTS.find((e) => e.file === file && e.action === action)
  if (found) return found

  throw new RegistryError({
    registry: 'OPEN_ENDPOINTS',
    key: KEY(file, action),
    message:
      `\`${action}\` in src/app/actions/${file}.ts establishes no permission, and no entry says ` +
      'why that is right. A server action is an HTTP endpoint: no page guard upstream of it is a ' +
      'gate, which is how `installDefaultCostCodes` came to be reachable by the readonly role. ' +
      'Gate it with the permission its own module already names for the same act, or declare it ' +
      'here with the authority that stands in for a role — a bearer token, the caller’s own ' +
      'identity, the practice side, or nothing at all because it reads nothing.',
  })
}

// --- Resolving a gate ------------------------------------------------------

/** Both import forms: `@/modules/x/y` and `./y` beside the file. */
function importsOf(file: string): Map<string, string> {
  const src = readFileSync(file, 'utf8')
  const found = new Map<string, string>()
  for (const match of src.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const spec = match[2]
    let base: string | null = null
    if (spec.startsWith('@/modules/')) base = `src/modules/${spec.slice('@/modules/'.length)}`
    else if (spec.startsWith('.')) base = normalize(join(dirname(file), spec))
    if (base === null) continue
    for (const raw of match[1].split(',')) {
      const symbol = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (symbol) found.set(symbol, base)
    }
  }
  return found
}

const moduleFile = (base: string): string | null =>
  [`${base}.ts`, `${base}/index.ts`].find((candidate) => existsSync(candidate)) ?? null

/** Permissions a body checks outright, with computed gates resolved. */
function gatesIn(body: string): Permission[] {
  const checks = permissionChecksIn(body)
  const found: Permission[] = [...checks.literal]
  for (const expression of checks.computed) {
    try {
      found.push(...resolveComputedGate(expression))
    } catch {
      // An unreadable computed gate is still a gate: Phase 214 refuses on the
      // expression elsewhere, and treating it as absent here would be the
      // false positive this module exists to stop making.
      found.push('company:manage')
    }
  }
  return [...new Set(found)]
}

/**
 * Every permission `symbol` establishes, following same-file helpers and both
 * import forms. Returns the first set found, so an act gated anywhere in its
 * chain is gated.
 */
export function establishedBy(
  file: string,
  symbol: string,
  depth = 4,
  seen: ReadonlySet<string> = new Set(),
): Permission[] {
  const key = KEY(file, symbol)
  if (seen.has(key) || depth < 0) return []
  const visited = new Set(seen)
  visited.add(key)

  const body = functionBody(file, symbol)
  if (body === null) return []

  const own = gatesIn(body)
  if (own.length > 0) return own
  if (depth === 0) return []

  const bare = withoutComments(body)
  const src = readFileSync(file, 'utf8')
  const imports = importsOf(file)

  for (const call of bare.matchAll(/(?<![.\w])(\w+)\s*\(/g)) {
    const name = call[1]

    if (name !== symbol && declaresFunction(src, name)) {
      const via = establishedBy(file, name, depth - 1, visited)
      if (via.length > 0) return via
    }

    const base = imports.get(name)
    if (!base) continue
    const target = moduleFile(base)
    if (!target) continue
    const via = establishedBy(target, name, depth - 1, visited)
    if (via.length > 0) return via
  }

  return []
}

/** Every exported server action, as `file::action`. */
export function serverActions(): string[] {
  const dir = 'src/app/actions'
  const found: string[] = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const bare = withoutComments(readFileSync(`${dir}/${name}`, 'utf8'))
    for (const match of bare.matchAll(/^export async function (\w+)/gm)) {
      found.push(KEY(name.replace(/\.ts$/, ''), match[1]))
    }
  }
  return found
}

/** Server actions that establish no permission anywhere in their chain. */
export function ungatedActions(): string[] {
  const found: string[] = []
  for (const key of serverActions()) {
    const [file, action] = key.split('::')
    if (establishedBy(`src/app/actions/${file}.ts`, action).length > 0) continue
    found.push(key)
  }
  return found.sort()
}

/** Ungated actions with no entry, and entries for actions that now gate. */
export function openEndpointDefects(): string[] {
  const measured = new Set(ungatedActions())
  const declared = new Set(OPEN_ENDPOINTS.map((e) => KEY(e.file, e.action)))

  return [
    ...[...measured].filter((key) => !declared.has(key)).map((key) => `${key} is ungated and undeclared`),
    ...[...declared].filter((key) => !measured.has(key)).map((key) => `${key} is declared and gated`),
  ].sort()
}

// --- The permission that only promises to look -----------------------------

/** Permission names that promise a read and nothing more. */
const WRITE_WORDS =
  /:(manage|journal|approve|close|perform|reopen|run|categorize|rules|import|billing|use)$/

/**
 * Roles holding nothing but reading permissions.
 *
 * Computed rather than listed, which is the whole point: today this is exactly
 * `['readonly']`, and if the role table gives that role one `:manage` the oracle
 * stops being an oracle and the falsifier below says so.
 */
export function viewOnlyRoles(): Role[] {
  return ROLE_NAMES.filter((role) =>
    (ROLE_PERMISSIONS[role] as readonly Permission[]).every(
      (permission) => !WRITE_WORDS.test(permission),
    ),
  )
}

/** Every permission a view-only role holds. */
export function viewOnlyPermissions(): Set<Permission> {
  return new Set(viewOnlyRoles().flatMap((role) => ROLE_PERMISSIONS[role] as readonly Permission[]))
}

/**
 * A body that writes or sends, read conservatively.
 *
 * Direct writes and sends in the function's own body only. It under-collects —
 * `runStatements` does neither itself — and that is the safe direction for a
 * claim of this kind: a miss leaves a defect to be found by the register, while
 * a false positive would have this module excusing a site it misread, which is
 * the mistake it was built after making four times.
 */
const WRITES =
  /\.(insert|update|delete)\s*\(|\bmintShareToken\s*\(|\bsend(Mail|Email|Push|Statement|Invoice|Remittance)\s*\(/

/**
 * Every permission an act can require, **unioned** along its chain.
 *
 * `establishedBy` answers "is it gated at all" and so returns the first set it
 * finds. That is the wrong reading for this property, and getting it wrong is
 * how `deleteTime` came to be accused: its own body checks `accounting:view`,
 * and `loadOwnEditable` — a helper in the same file — escalates to
 * `users:manage` for somebody else's timesheet. Reading only the first set makes
 * a correct self-act look like a mislabelled gate. So this unions the act's own
 * gates with those of the same-file helpers it calls, and the question becomes
 * whether *any* authority in the act is more than a promise to look.
 */
export function authorityOf(file: string, symbol: string, depth = 2): Permission[] {
  const body = functionBody(file, symbol)
  if (body === null) return []

  const found = new Set<Permission>(gatesIn(body))
  if (depth === 0) return [...found]

  const src = readFileSync(file, 'utf8')
  for (const call of withoutComments(body).matchAll(/(?<![.\w])(\w+)\s*\(/g)) {
    const name = call[1]
    if (name === symbol || !declaresFunction(src, name)) continue
    for (const permission of authorityOf(file, name, depth - 1)) found.add(permission)
  }

  return [...found]
}

/**
 * Identity as a predicate rather than as a check.
 *
 * `submitTime` requires `accounting:view` and then writes
 * `.where(and(…, eq(timeEntries.userId, ctx.userId), eq(timeEntries.status,
 * 'draft'), …))`. Its authority is not the permission and not a helper: it is
 * that the row it can touch is the caller's own. Phase 214's `self` form,
 * appearing in a WHERE clause instead of an `if`.
 *
 * The pattern is deliberately the **comparison** and not any mention of
 * `ctx.userId`, which is ADR 0134's exclusion-that-excuses in its purest form:
 * nearly every write in this codebase stores `createdBy: ctx.userId`, so the
 * loose version would have excused all seven of the acts this phase fixes.
 * Measured: the comparison occurs 14 times in `src/modules` and in none of the
 * seven.
 */
const SELF_SCOPED = /eq\(\s*\w+\.userId\s*,\s*ctx\.userId\s*\)/

/**
 * Acts whose every authority is a permission a view-only role holds, that write
 * or send.
 *
 * Must be empty. This is the property none of Phases 214–216 asserts: each of
 * them is satisfied by `requirePermission(ctx, 'accounting:view')` on a function
 * that emails a customer.
 */
export function mislabelledGates(): string[] {
  const viewOnly = viewOnlyPermissions()
  const found: string[] = []

  for (const file of sourceFiles('src/modules')) {
    const bare = withoutComments(readFileSync(file, 'utf8'))
    for (const match of bare.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const body = functionBody(file, match[1])
      if (body === null) continue
      if (!WRITES.test(body)) continue
      if (SELF_SCOPED.test(body)) continue

      const gates = authorityOf(file, match[1])
      if (gates.length === 0) continue // ungated is the register's business, not this one
      if (!gates.every((permission) => viewOnly.has(permission))) continue

      found.push(
        `${file.replace('src/modules/', '')}::${match[1]} writes behind [${gates.sort().join(' ')}]`,
      )
    }
  }

  return found.sort()
}
