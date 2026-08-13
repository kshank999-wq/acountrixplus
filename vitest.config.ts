import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // Ledger/tenant tests share one Postgres database; run files serially so
    // truncation between suites cannot race.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
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
