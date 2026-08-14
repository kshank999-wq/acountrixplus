/**
 * The worker process.
 *
 * Run with `npm run worker`. A separate process from the web app on purpose:
 * a Next.js server that also drained a queue would run one copy per instance
 * with no coordination, and scaling the website would scale the number of
 * things sending campaigns.
 *
 * Several of these can run at once. `claimJobs` uses `FOR UPDATE SKIP LOCKED`,
 * so two workers take different jobs rather than the same one or blocking on
 * each other.
 */
import { runForever } from '@/modules/worker/runner'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
    process.exit(1)
  }

  const intervalMs = Number(process.env.WORKER_POLL_MS ?? 5_000)
  const batchSize = Number(process.env.WORKER_BATCH_SIZE ?? 10)

  await runForever({ intervalMs, batchSize })
  process.exit(0)
}

main().catch((error) => {
  console.error('Worker failed to start:', error)
  process.exit(1)
})
