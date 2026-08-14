/**
 * One tick, then exit.
 *
 * For a deployment whose scheduler is external — a container platform's cron,
 * a systemd timer — and for looking at what the worker would do without
 * leaving a process running. `runOnce` is the same function `runForever` calls
 * in its loop and the same one the tests drive, so there is no second code
 * path that could behave differently.
 */
import { runOnce } from '@/modules/worker/runner'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
    process.exit(1)
  }

  const tick = await runOnce()

  console.log(
    `${tick.jobsRun} jobs run (${tick.jobsSucceeded} succeeded, ${tick.jobsFailed} retrying, ` +
      `${tick.jobsDead} dead), ${tick.schedulesFired} schedules fired, ` +
      `${tick.eventsRelayed} events relayed.`,
  )

  process.exit(0)
}

main().catch((error) => {
  console.error('Tick failed:', error)
  process.exit(1)
})
