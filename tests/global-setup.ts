import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/**
 * Runs once before the suite: points the process at the test database and
 * brings its schema up to date.
 */
export default async function globalSetup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/accountrix_test'

  // Guard against pointing the suite at a real database — every test file
  // truncates all tables.
  if (!/test/i.test(url)) {
    throw new Error(
      `Refusing to run tests against "${url}": the database name must contain "test".`,
    )
  }

  const sql = postgres(url, { max: 1 })
  try {
    await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  } finally {
    await sql.end()
  }
}
