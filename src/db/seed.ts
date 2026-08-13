/**
 * Seeds a demo company with mock bank data.
 *
 * Run with `npm run db:seed`. Everything it creates goes through the same
 * services the application uses, so the seeded state is reachable by a real
 * user rather than a special case.
 */
import { registerCompany } from '@/modules/tenancy/onboarding'
import { connectInstitution, syncConnection } from '@/modules/banking/sync'
import { createRule } from '@/modules/bookkeeping/rules-engine'
import { accountByNumber } from '@/modules/coa/service'
import type { ActorContext } from '@/modules/tenancy/context'

const DEMO_EMAIL = 'owner@ridgeline.test'
const DEMO_PASSWORD = 'correct-horse-battery'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
    process.exit(1)
  }

  console.log('Creating demo company…')
  const { company, user, accountsCreated } = await registerCompany({
    companyName: 'Ridgeline Construction',
    industry: 'construction',
    userName: 'Dana Owner',
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  })
  console.log(`  ${company.name} created with ${accountsCreated} accounts.`)

  const ctx: ActorContext = {
    userId: user.id,
    userName: user.name,
    companyId: company.id,
    role: 'owner',
  }

  // A rule created before the import, so the sync demonstrates auto-
  // categorization rather than leaving everything uncategorized.
  const fuel = await accountByNumber(company.id, '6800')
  if (fuel) {
    await createRule(ctx, {
      name: 'Fuel at Shell',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL OIL' }],
      chartAccountId: fuel.id,
      action: 'auto',
    })
    console.log('  Added an auto-categorization rule for Shell fuel.')
  }

  const rent = await accountByNumber(company.id, '6400')
  if (rent) {
    await createRule(ctx, {
      name: 'Monthly rent',
      conditions: [{ field: 'description', operator: 'contains', value: 'NORTHGATE PROP' }],
      chartAccountId: rent.id,
      action: 'suggest',
    })
    console.log('  Added a suggestion rule for rent.')
  }

  console.log('Connecting the sandbox bank feed…')
  const { connectionId, accountsCreated: bankAccounts } = await connectInstitution(ctx, {
    publicToken: 'demo',
  })
  console.log(`  Linked ${bankAccounts} bank accounts.`)

  const summary = await syncConnection(ctx, connectionId)
  console.log(
    `  Imported ${summary.imported} transactions ` +
      `(${summary.autoCategorized} auto-categorized, ${summary.suggested} suggested).`,
  )

  console.log('\nDone. Sign in with:')
  console.log(`  Email:    ${DEMO_EMAIL}`)
  console.log(`  Password: ${DEMO_PASSWORD}`)

  process.exit(0)
}

main().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
