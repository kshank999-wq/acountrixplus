-- Phase 83: telling a send failure apart from a bounce.
--
-- `sendStep` had two outcomes and called the unhappy one `bounced`, putting the
-- provider's error message into `skip_reason` — a column documented as "why a
-- recipient was skipped: no_consent, suppressed, no_email".
--
-- A provider refusing an API call is a send failure: ours, usually transient,
-- and no reason to touch the address. A bounce is the receiving server
-- rejecting the message after the provider accepted it, and a hard one means
-- the address must never be mailed again. Conflating them meant a rate limit
-- looked like a dead mailbox, and a dead mailbox was never suppressed at all.

-- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older
-- PostgreSQL, and drizzle wraps a migration file in one. `IF NOT EXISTS` makes
-- it safe to re-run; PostgreSQL 12+ allows it in a transaction so long as the
-- new value is not used in the same transaction, which it is not.
ALTER TYPE "recipient_status" ADD VALUE IF NOT EXISTS 'failed';
--> statement-breakpoint

-- What the provider said when it would not take the message. Its own column,
-- because `skip_reason` answers a different question and the two were sharing
-- a field only because there was nowhere else to put this.
ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint

-- Existing rows are not migrated. A `bounced` row written before this phase
-- might have been either a send failure or, once the callback exists, a real
-- bounce — and there is nothing in the record that says which. Guessing would
-- put a fabricated distinction into a table people read to decide whether an
-- address is dead. They stay as they are, and the distinction starts here.
--
-- The `skip_reason` values already written on those rows are left alone for
-- the same reason: they are the only evidence of what happened.
