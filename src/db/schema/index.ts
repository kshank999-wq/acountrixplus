/**
 * Single entry point for the database schema.
 *
 * Drizzle reads this file to generate migrations, so every table must be
 * re-exported here or it will silently be left out of the migration.
 */
export * from './tenancy'
export * from './accounting'
export * from './banking'
export * from './rules'
export * from './audit'
export * from './crm'
export * from './jobs'
export * from './ledger'
export * from './receivables'
export * from './studio'
export * from './design'
export * from './marketing'
export * from './ai'
export * from './construction'
