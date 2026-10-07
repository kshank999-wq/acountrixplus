/**
 * Whether a deployment is configured to do the things it will otherwise fail at
 * quietly (Phase 175).
 *
 * ## Why this exists
 *
 * Every adapter in this codebase falls back to a mock when its variable is
 * unset, and that default is right: it is what lets the demo, the seed and
 * 4,200 tests run with no credentials and no network.
 *
 * It is also the exact shape Phase 160 found in `devices` and
 * `security_policies` and called the dangerous one — **it degrades silently.**
 * A deployment with no `TRANSACTIONAL_EMAIL_PROVIDER` does not refuse to send a
 * password reset. It writes the link to a console log, returns
 * `{ ok: true, providerMessageId: 'mock-…' }`, and the person waiting for the
 * email concludes the account is broken.
 *
 * `getTransactionalProvider` already throws for a provider that is *named* and
 * misconfigured, and its comment says why: *"a deployment that thinks it
 * configured a real sender and is actually dropping every password reset."*
 * That covers the typo and not the omission. This covers the omission.
 *
 * ## Why a check and not a refusal to boot
 *
 * Tempting, and wrong in two directions. A preview deployment with no mail
 * provider is useful and should start. And a check that prevents boot cannot be
 * read — the operator sees a crash loop rather than a list of what to set.
 *
 * So this is pure: no database, no clock, no `process.env`. It takes the
 * environment as an argument, which is what makes it testable without mutating
 * globals and what lets the same function answer for a *remote* deployment's
 * environment rather than only the one it is running in.
 *
 * ## What it deliberately does not check
 *
 * Whether the credentials *work*. Proving `POSTMARK_SERVER_TOKEN` is live means
 * sending mail, and a readiness check with a side effect is a readiness check
 * nobody runs twice. This answers "is it set", which is the failure that
 * actually happens.
 */

import { RegistryError } from '@/modules/errors/registry'

/** How bad it is to ship without this. */
export type Severity =
  /**
   * Something a person will try and find broken, with no error to go on.
   *
   * The bar is deliberately high: it is not "a feature is off", it is "a
   * feature reports success and does nothing".
   */
  | 'silent-failure'
  /** The deployment will not work at all, loudly. */
  | 'broken'
  /** A capability is off and says so when used. */
  | 'degraded'
  /** Worth knowing, nothing is wrong. */
  | 'note'

export type CheckResult = {
  key: string
  severity: Severity
  /** True when the deployment is configured for this. */
  ok: boolean
  /** What a person reads. Present whether or not it passed. */
  detail: string
}

export type Check = {
  key: string
  severity: Severity
  /** Why this one is on the list, argued. */
  because: string
  /** `null` when configured; otherwise what is wrong, in a sentence. */
  detect: (env: Environment) => string | null
}

/**
 * An environment, as a bag of strings.
 *
 * Deliberately not `NodeJS.ProcessEnv`, which this project's config requires to
 * carry `NODE_ENV` — and requiring that would make the module's own claim false:
 * it is supposed to be able to answer for an environment that is not the one it
 * is running in, including a partial one read back from somewhere else.
 *
 * The typecheck caught this; the tests did not, because a test that builds a
 * full environment object satisfies either type.
 */
export type Environment = Readonly<Record<string, string | undefined>>

/** A variable set to the empty string is not set. Every hosting panel allows it. */
function value(env: Environment, name: string): string | null {
  const raw = env[name]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

export const DEPLOY_CHECKS: readonly Check[] = [
  {
    key: 'database-url',
    severity: 'broken',
    because:
      'Nothing works without it, and it is the one failure on this list that cannot be silent — ' +
      'every page returns an error. Listed anyway so a readiness report that says nothing is ' +
      'wrong has actually looked at the database.',
    detect: (env) => (value(env, 'DATABASE_URL') ? null : 'DATABASE_URL is not set.'),
  },
  {
    key: 'database-url-not-session-pooler',
    severity: 'note',
    because:
      'Supabase hands out two connection strings that differ by one digit. Port 5432 is the ' +
      'session pooler and is correct for migrations; 6543 is the transaction pooler and is what ' +
      'the deployed application wants. Running the app through 5432 works and holds a backend per ' +
      'request, which on a serverless platform exhausts the pool under load — so this is a note ' +
      'rather than a fault, because it is wrong only at a scale a first deployment will not reach.',
    detect: (env) => {
      const url = value(env, 'DATABASE_URL')
      if (!url) return null

      try {
        const port = new URL(url).port
        if (port === '5432' && url.includes('pooler.supabase.com')) {
          return 'DATABASE_URL is on port 5432, the session pooler. The deployed application wants 6543.'
        }
      } catch {
        return null
      }
      return null
    },
  },
  {
    key: 'session-secret',
    severity: 'broken',
    because:
      'Sessions are signed cookies, so with no secret nobody can stay logged in. It is also the ' +
      'one secret that cannot be rotated casually: a new value signs every existing session out, ' +
      'which is a thing to do deliberately rather than discover.',
    detect: (env) => (value(env, 'SESSION_SECRET') ? null : 'SESSION_SECRET is not set.'),
  },
  {
    key: 'encryption-key',
    severity: 'silent-failure',
    because:
      'It encrypts stored secrets — TOTP seeds among them. The reason this is a silent failure ' +
      'rather than a loud one is rotation: a *new* key does not break a login attempt with an ' +
      'error about keys, it makes every stored second factor undecryptable, so people are locked ' +
      'out of their own accounts by a change nobody connects to it. Generate once, keep it.',
    detect: (env) => (value(env, 'ENCRYPTION_KEY') ? null : 'ENCRYPTION_KEY is not set.'),
  },
  {
    key: 'cron-secret',
    severity: 'silent-failure',
    because:
      'The worker is a cron hitting `/api/cron/worker`, and that route refuses every request when ' +
      '`CRON_SECRET` is unset — which is the right default and means the queue simply never ' +
      'drains. Nothing errors. Recurring invoices do not go out, retention does not sweep, ' +
      'statements are not sent, and the only symptom is work that quietly never happens.',
    detect: (env) => (value(env, 'CRON_SECRET') ? null : 'CRON_SECRET is not set, so the worker never runs.'),
  },
  {
    key: 'public-base-url',
    severity: 'silent-failure',
    because:
      'Every link the application mails — password reset, a proposal, an invoice — is built from ' +
      'it. Unset or stale, the mail sends successfully and the links point somewhere else, which ' +
      'is a failure the sender cannot see and only the recipient experiences.',
    detect: (env) => (value(env, 'PUBLIC_BASE_URL') ? null : 'PUBLIC_BASE_URL is not set, so emailed links will point at the wrong host.'),
  },
  {
    key: 'transactional-email',
    severity: 'silent-failure',
    because:
      'The headline case for this whole module. With the variable unset the mock provider logs to ' +
      'the console and returns success, so a password reset is "sent" and never arrives. ' +
      '`getTransactionalProvider` throws for a provider that is named and misconfigured — the ' +
      'typo — and defaults to the mock for the omission, which is the half this catches.',
    detect: (env) => {
      const provider = value(env, 'TRANSACTIONAL_EMAIL_PROVIDER')
      if (!provider || provider === 'mock') {
        return 'No real email provider is configured, so password resets and sent documents go to a log instead of a person.'
      }
      if (!value(env, 'TRANSACTIONAL_FROM_EMAIL')) {
        return `TRANSACTIONAL_EMAIL_PROVIDER is "${provider}" but TRANSACTIONAL_FROM_EMAIL is not set.`
      }
      return null
    },
  },
  {
    key: 'bank-provider',
    severity: 'degraded',
    because:
      'Degraded rather than a silent failure, and the distinction is the point: there is no real ' +
      'aggregator adapter in this codebase, only the mock, so a connection attempt fails where ' +
      'somebody can see it. Importing a bank CSV through Settings → Import needs no provider at ' +
      'all and is the path a real business uses until an adapter exists.',
    detect: (env) => {
      const provider = value(env, 'BANK_PROVIDER')
      return !provider || provider === 'mock'
        ? 'No bank aggregator is configured. Import statements as CSV; automatic feeds need an adapter that does not exist yet.'
        : null
    },
  },
  {
    key: 'ai-module',
    severity: 'note',
    because:
      'Spec §23 makes AI additive and §11 requires the core product to work without it, so an ' +
      'unset key is a supported configuration rather than a problem. It is on the list because ' +
      '"the assistant does nothing" is otherwise a thing somebody investigates, and the answer is ' +
      'one variable.',
    detect: (env) =>
      value(env, 'ANTHROPIC_API_KEY')
        ? null
        : 'No AI key set. Assistants fall back to the built-in heuristics, which is a supported configuration.',
  },
  {
    key: 'push-notifications',
    severity: 'note',
    because:
      'Web push needs a VAPID key pair, and without one the mobile workspace simply does not ' +
      'offer to subscribe. Nothing claims to have sent a notification that was not sent, which is ' +
      'what keeps this a note rather than a silent failure.',
    detect: (env) =>
      value(env, 'VAPID_PUBLIC_KEY') && value(env, 'VAPID_PRIVATE_KEY')
        ? null
        : 'No VAPID keys set, so push notifications are unavailable. Everything else is unaffected.',
  },
]

export function deployCheckFor(key: string): Check {
  const found = DEPLOY_CHECKS.find((check) => check.key === key)
  if (found) return found

  throw new RegistryError({
    registry: 'DEPLOY_CHECKS',
    key,
    message:
      `No deployment check is declared as "${key}". This register is the list of configuration ` +
      'a deployment can be missing while reporting success, which is why every entry argues what ' +
      `fails quietly without it. Declared: ${DEPLOY_CHECKS.map((check) => check.key).join(', ')}.`,
  })
}

export type Readiness = {
  results: CheckResult[]
  /** Anything that would make the deployment fail outright. */
  broken: CheckResult[]
  /** Anything that would report success and do nothing. */
  silent: CheckResult[]
  /**
   * Whether this deployment is safe to put real books in.
   *
   * `false` for anything broken *or* silently failing. A deployment that cannot
   * mail a password reset is not one to trust with somebody's accounts, even
   * though every page loads.
   */
  fitForRealData: boolean
}

export function assessDeployment(env: Environment): Readiness {
  const results = DEPLOY_CHECKS.map((check) => {
    const problem = check.detect(env)
    return {
      key: check.key,
      severity: check.severity,
      ok: problem === null,
      detail: problem ?? 'Configured.',
    }
  })

  const failed = results.filter((result) => !result.ok)
  const broken = failed.filter((result) => result.severity === 'broken')
  const silent = failed.filter((result) => result.severity === 'silent-failure')

  return {
    results,
    broken,
    silent,
    fitForRealData: broken.length === 0 && silent.length === 0,
  }
}

/** One line per check, for a terminal. */
export function formatReadiness(readiness: Readiness): string {
  const mark = (result: CheckResult) => {
    if (result.ok) return '  ok  '
    if (result.severity === 'broken') return ' FAIL '
    if (result.severity === 'silent-failure') return 'SILENT'
    if (result.severity === 'degraded') return ' off  '
    return ' note '
  }

  const lines = readiness.results.map(
    (result) => `[${mark(result)}] ${result.key.padEnd(34)} ${result.detail}`,
  )

  lines.push('')
  lines.push(
    readiness.fitForRealData
      ? 'Fit for real data: nothing is broken and nothing fails silently.'
      : `NOT fit for real data: ${readiness.broken.length} broken, ${readiness.silent.length} would report success and do nothing.`,
  )

  return lines.join('\n')
}

export function readinessStands(check: Check): string[] {
  const problems: string[] = []

  if (check.because.length < 180) {
    problems.push(
      `${check.key} does not argue itself — and the argument is the whole entry here, because ` +
        'the question is never "is this variable set" but "what happens if it is not".',
    )
  }

  return problems
}
