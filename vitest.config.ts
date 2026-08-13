import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // Ledger/tenant tests share one Postgres database and `tests/setup.ts`
    // truncates every table in `beforeEach`, so files must run strictly one at
    // a time — two files in flight truncate each other's fixtures mid-test.
    //
    // `fileParallelism: false` is what guarantees that, and it is set
    // explicitly for a reason. Until Vitest 3 the old
    // `poolOptions.forks.singleFork` implied serial files; on Vitest 4 that
    // option no longer exists, and the suite went from 497 passing to 337
    // failing with deadlocks and rows vanishing mid-test. The guarantee this
    // suite depends on now has its own line rather than being a side effect of
    // a pool detail.
    fileParallelism: false,
    pool: 'forks',
    // The v4 spelling of "one worker": no second process to race the first.
    maxWorkers: 1,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
})
