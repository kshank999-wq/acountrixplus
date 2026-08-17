import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export * as schema from './schema'

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and set a PostgreSQL connection string.',
    )
  }
  return url
}

/**
 * True when the connection goes through a transaction-mode connection pooler.
 *
 * Detected from the URL rather than configured, because getting it wrong is
 * silent until it is not: the application works in development, works under
 * light load in production, and then starts throwing
 * `prepared statement "s1" already exists` once two requests happen to land on
 * the same pooled backend. That is a miserable thing to debug from an error
 * message that mentions neither pooling nor prepared statements.
 *
 * Two signals, either of which is conclusive:
 *
 *  - **Port 6543.** Supabase's transaction pooler. Its session-mode pooler is
 *    on 5432 and does support prepared statements, but it holds a backend for
 *    the life of the connection — which is the wrong trade for serverless, and
 *    a deployment that ends up there should still work.
 *  - **`pgbouncer=true`**, which several providers use as an explicit marker.
 */
function isPooled(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.port === '6543' || parsed.searchParams.get('pgbouncer') === 'true'
  } catch {
    return false
  }
}

/**
 * True when this process is a short-lived serverless invocation.
 *
 * Each one gets its own pool, so a generous `max` multiplies by the number of
 * concurrent invocations and exhausts the pooler's client slots — which fails
 * as connection timeouts under load, again some distance from the cause.
 */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

/**
 * The postgres-js client is cached on globalThis so Next.js hot reloads in
 * development reuse one pool instead of opening a new one on every edit. On a
 * serverless platform the same cache means a warm invocation reuses the
 * connection its predecessor opened, which is the difference between a fast
 * response and a fresh TLS handshake on every request.
 */
const globalForDb = globalThis as unknown as {
  __accountrixSql?: ReturnType<typeof postgres>
}

function client() {
  if (!globalForDb.__accountrixSql) {
    const url = connectionString()
    const pooled = isPooled(url)

    globalForDb.__accountrixSql = postgres(url, {
      /**
       * **Required through a transaction-mode pooler.**
       *
       * postgres-js names and caches prepared statements by default. PgBouncer
       * in transaction mode hands each transaction whatever backend is free,
       * so the statement a client believes it prepared may live on a different
       * connection — or the name may already be taken on this one.
       */
      prepare: pooled ? false : undefined,
      /**
       * One connection per serverless instance.
       *
       * The platform gives concurrency by running more instances, not by
       * giving one instance a bigger pool, so anything above 1 is contention
       * this process cannot use and slots another instance needs.
       */
      max: isServerless() ? 1 : 10,
      /** Let an idle serverless connection go rather than hold a pooler slot. */
      idle_timeout: isServerless() ? 20 : undefined,
      /**
       * Fail fast rather than hanging a request for the platform's whole
       * timeout when the pooler is out of slots.
       */
      connect_timeout: 10,
    })
  }
  return globalForDb.__accountrixSql
}

/**
 * Application database handle.
 *
 * Prefer the tenant-scoped helpers in `modules/tenancy` over reaching for this
 * directly — every business-domain query must be filtered by company id
 * (spec §19), and those helpers make that structural rather than a thing each
 * call site has to remember.
 */
export const db = drizzle(client(), { schema })

export type Database = typeof db
/** A `db` handle or an open transaction — services accept either. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]
