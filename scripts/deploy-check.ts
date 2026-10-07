/**
 * Prints what this environment is missing before real data goes in (Phase 175).
 *
 * Run with `npm run deploy:check`. Reads the shell it runs in — so against a
 * local `.env.local` it tells you about your machine. To ask the *deployed*
 * environment, which is the one that matters:
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain/api/health
 *
 * Exits non-zero when the deployment is not fit for real data, so it can gate a
 * deploy step. Nothing here prints a secret's value — only whether it is set.
 */
import { assessDeployment, formatReadiness } from '../src/modules/deploy/readiness'

const readiness = assessDeployment(process.env)

console.log(formatReadiness(readiness))

process.exit(readiness.fitForRealData ? 0 : 1)
