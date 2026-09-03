import { describe, expect, it } from 'vitest'
import { eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { transactionalMessages } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import { RETENTION_POLICIES, type RetentionKind } from '@/modules/retention/policy'
import {
  ATTRIBUTIONS,
  attributionFor,
  countableFor,
  showingFor,
  type Audience,
} from '@/modules/retention/attribution'
import {
  companyColumnNames,
  retentionReport,
  sweepAll,
  sweptTableNames,
} from '@/modules/retention/sweep'

/**
 * Whose rows the retention screen is counting (Phase 102).
 *
 * `retentionReport()` took no company while the page showing it belongs to one,
 * so a `company:manage` holder at one company read how many letters, campaign
 * events, lead submissions and check runs every *other* company was holding.
 *
 * The claim that matters most is the one against the database at the bottom:
 * two companies, letters in each, and neither number containing the other.
 */

const DEPLOYMENT: Audience = { kind: 'deployment' }
const someCompany: Audience = { kind: 'company', companyId: 'c0000000-0000-0000-0000-000000000001' }

describe('what a viewer may be shown', () => {
  it('gives the deployment every count, because a total is true for it', () => {
    for (const kind of Object.keys(ATTRIBUTIONS) as RetentionKind[]) {
      expect(showingFor(ATTRIBUTIONS[kind], DEPLOYMENT)).toEqual({ counted: true, whole: true })
    }
  })

  it('gives a company the whole truth where every row has a company', () => {
    expect(showingFor(attributionFor('integrity_runs'), someCompany)).toEqual({
      counted: true,
      whole: true,
    })
  })

  it('says a count is only a share where some rows belong to a firm or a person', () => {
    const showing = showingFor(attributionFor('transactional_messages'), someCompany)

    expect(showing.counted).toBe(true)
    expect(showing.counted && showing.whole).toBe(false)
    // The caveat has to say *why*, not just that the number is partial — a
    // reader who cannot tell whether the rest is other companies' letters has
    // been told nothing useful.
    expect(showing.counted && !showing.whole && showing.caveat).toContain('morning brief')
  })

  it('refuses a count, with the reason, where no row has a company', () => {
    const showing = showingFor(attributionFor('login_attempts'), someCompany)

    expect(showing.counted).toBe(false)
    // Not a blank cell. These rows are held and swept like any others.
    expect(!showing.counted && showing.because).toContain('email address')
  })

  it('counts four of the eleven for nobody in particular', () => {
    // Sign-ins, sessions, guard attempts and shared blobs. Named as a number
    // rather than a list so that moving one across is a deliberate edit here.
    expect(countableFor(DEPLOYMENT)).toHaveLength(RETENTION_POLICIES.length)
    expect(countableFor(someCompany)).toHaveLength(RETENTION_POLICIES.length - 4)
  })

  it('makes every policy that cannot name a company argue for itself', () => {
    // Phase 70's device: prose rather than a flag, so the next person adding a
    // table has to make the case rather than copy a boolean.
    for (const kind of Object.keys(ATTRIBUTIONS) as RetentionKind[]) {
      const attribution = ATTRIBUTIONS[kind]
      if (attribution.of === 'always_a_company') continue
      expect(attribution.because.length, kind).toBeGreaterThan(60)
    }
  })
})

/**
 * The tripwire, and this one is derived.
 *
 * Phase 101 had to write its table count down by hand and said why: "grows with
 * traffic" is a fact about who writes the rows and no column says it. This is
 * different — **whether a table has a `company_id` and whether it is nullable is
 * a fact `information_schema` holds** — so the declarations are checked rather
 * than trusted, the way Phase 96 checks `PARTY_REFERENCES` against
 * `pg_constraint`.
 *
 * The direction that earns its keep is the second one. Making a column nullable
 * is a migration nobody would think to connect to a retention screen, and it
 * silently turns a complete count into a partial one.
 */
describe('every attribution matches the schema', () => {
  const columnFacts = async () => {
    const rows = (await db.execute(
      sql`select table_name, is_nullable
          from information_schema.columns
          where table_schema = 'public' and column_name = 'company_id'`,
    )) as unknown as Array<{ table_name: string; is_nullable: string }>

    return new Map(rows.map((row) => [row.table_name, row.is_nullable === 'YES']))
  }

  it('sweeps the table its policy names', () => {
    // Phase 24's safety property — no policy naming a table that holds the
    // books — is asserted against `RetentionPolicy.table`, a hand-written
    // string. A sweep pointed somewhere else would make that guarantee
    // vacuous while still reading as though it held.
    const swept = sweptTableNames()
    for (const policy of RETENTION_POLICIES) {
      expect(swept[policy.kind], policy.kind).toBe(policy.table)
    }
  })

  it('claims a company column exactly where the database has one', async () => {
    const nullableByTable = await columnFacts()
    const tables = sweptTableNames()
    const columns = companyColumnNames()

    for (const kind of Object.keys(ATTRIBUTIONS) as RetentionKind[]) {
      const hasColumn = nullableByTable.has(tables[kind])
      const declared = ATTRIBUTIONS[kind].of !== 'never_a_company'

      expect(declared, `${kind} (${tables[kind]})`).toBe(hasColumn)
      // And the sweep filters on it, or does not, to match.
      expect(columns[kind] !== null, `${kind} sweep column`).toBe(hasColumn)
    }
  })

  it('knows which company columns are nullable, and says so in the attribution', async () => {
    const nullableByTable = await columnFacts()
    const tables = sweptTableNames()

    for (const kind of Object.keys(ATTRIBUTIONS) as RetentionKind[]) {
      const attribution = ATTRIBUTIONS[kind]
      if (attribution.of === 'never_a_company') continue

      const nullable = nullableByTable.get(tables[kind])
      expect(attribution.of === 'sometimes_a_company', `${kind} (${tables[kind]})`).toBe(nullable)
    }
  })
})

describe('against the database', () => {
  const asOf = new Date('2030-01-01T00:00:00Z')

  const letterFor = (companyId: string | null, subject: string) =>
    db.insert(transactionalMessages).values({
      companyId,
      kind: 'password_reset',
      email: 'someone@example.test',
      subject,
      outcome: 'sent',
      providerKey: 'mock',
    })

  it('keeps one company’s letters out of another’s count', async () => {
    // The defect, stated as a test. Before Phase 102 both of these read 2.
    const ours = await createCompanyFixture({ name: 'Ours Retention Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Retention Co' })

    await letterFor(ours.companyId, 'Ours')
    await letterFor(theirs.companyId, 'Theirs one')
    await letterFor(theirs.companyId, 'Theirs two')

    const mine = await retentionReport({ kind: 'company', companyId: ours.companyId }, asOf)
    const letters = mine.find((row) => row.kind === 'transactional_messages')!

    expect(letters.counted && letters.held).toBe(1)
  })

  it('shows a company the policy even where it cannot show a number', async () => {
    const fixture = await createCompanyFixture({ name: 'Policy Co' })

    const mine = await retentionReport({ kind: 'company', companyId: fixture.companyId }, asOf)
    const attempts = mine.find((row) => row.kind === 'login_attempts')!

    // The half that is a published statement about the product is not tenant
    // data and is never withheld — the retention list exists so somebody can
    // be shown exactly this.
    expect(attempts.days).toBe(90)
    expect(attempts.why.length).toBeGreaterThan(40)
    expect(attempts.counted).toBe(false)
  })

  it('counts a letter that belongs to no company for the deployment only', async () => {
    // The Phase 88 morning brief goes to a firm about its clients and has no
    // company of its own. A plain `where company_id = $1` would make it
    // invisible to everybody rather than to the wrong people.
    const fixture = await createCompanyFixture({ name: 'Brief Co' })
    await letterFor(null, 'Your clients this morning')

    const mine = await retentionReport({ kind: 'company', companyId: fixture.companyId }, asOf)
    const everyone = await retentionReport(DEPLOYMENT, asOf)

    const forOne = mine.find((row) => row.kind === 'transactional_messages')!
    const forAll = everyone.find((row) => row.kind === 'transactional_messages')!

    expect(forOne.counted && forOne.held).toBe(0)
    expect(forAll.counted && forAll.held).toBe(1)

    const orphans = await db
      .select({ id: transactionalMessages.id })
      .from(transactionalMessages)
      .where(isNull(transactionalMessages.companyId))
    expect(orphans).toHaveLength(1)
  })

  it('scopes the expiring count the same way it scopes the total', async () => {
    // Reporting one company's expiring rows against every company's total
    // would be a worse number than either — which is why the filter is applied
    // in one place rather than per policy.
    const ours = await createCompanyFixture({ name: 'Expiry Ours' })
    const theirs = await createCompanyFixture({ name: 'Expiry Theirs' })

    await letterFor(ours.companyId, 'Ours')
    await letterFor(theirs.companyId, 'Theirs')

    // Everything is a year past the window at this date.
    const mine = await retentionReport({ kind: 'company', companyId: ours.companyId }, asOf)
    const letters = mine.find((row) => row.kind === 'transactional_messages')!

    expect(letters.counted && letters.expired).toBe(1)
    expect(letters.counted && letters.held).toBe(1)
  })

  it('sweeps every company however narrow the report was', async () => {
    // The asymmetry that matters. Scoping the delete the way the report is
    // scoped would mean retention only removed rows belonging to whoever last
    // loaded a page.
    const ours = await createCompanyFixture({ name: 'Sweep Ours' })
    const theirs = await createCompanyFixture({ name: 'Sweep Theirs' })

    await letterFor(ours.companyId, 'Ours')
    await letterFor(theirs.companyId, 'Theirs')
    await letterFor(null, 'Nobody in particular')

    await sweepAll(asOf)

    const left = await db.select({ n: sql<string>`count(*)` }).from(transactionalMessages)
    expect(Number(left[0].n)).toBe(0)
  })

  it('leaves another company’s rows alone when it counts, not just when it deletes', async () => {
    const ours = await createCompanyFixture({ name: 'Isolation Ours' })
    const theirs = await createCompanyFixture({ name: 'Isolation Theirs' })

    await letterFor(theirs.companyId, 'Not yours')

    const mine = await retentionReport({ kind: 'company', companyId: ours.companyId }, asOf)

    for (const row of mine) {
      if (!row.counted) continue
      expect(row.held, `${row.kind} held`).toBe(0)
      expect(row.expired, `${row.kind} expired`).toBe(0)
    }

    // And the other company's row really is there to have been leaked.
    const theirRows = await db
      .select({ id: transactionalMessages.id })
      .from(transactionalMessages)
      .where(eq(transactionalMessages.companyId, theirs.companyId))
    expect(theirRows).toHaveLength(1)
  })
})
