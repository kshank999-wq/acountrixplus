-- Phase 90: the notification log learns that a notification names an audience.
--
-- ADR 0008 built this table so that "why did I not get told about that" has an
-- answer that is not a guess. Phase 88's firm brief is a notification by every
-- meaning except its transport, and it could not be recorded here: `company_id`
-- is NOT NULL and a firm's brief is about no single company.
--
-- Same shape as `notification_preferences` in Phase 89, and deliberately so:
-- exactly one owner, enforced by the database rather than by convention.

ALTER TABLE "notification_log" ALTER COLUMN "company_id" DROP NOT NULL;

ALTER TABLE "notification_log"
  ADD COLUMN IF NOT EXISTS "practice_id" uuid REFERENCES "practices"("id") ON DELETE CASCADE;

-- How the message was carried. Stored rather than derived from the topic,
-- because a null `body` is otherwise ambiguous: this column is what says the
-- text is in `transactional_messages` rather than that there was no text.
--
-- Backfilled to 'push' because every row that exists predates the mail channel
-- reaching this table, which is what this migration is for.
ALTER TABLE "notification_log"
  ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'push';

-- The exclusivity, so "no company" is a different owner rather than a missing
-- value. Every existing row names a company and passes unchanged.
ALTER TABLE "notification_log"
  DROP CONSTRAINT IF EXISTS "notification_log_one_owner";

ALTER TABLE "notification_log"
  ADD CONSTRAINT "notification_log_one_owner"
  CHECK (("company_id" IS NULL) <> ("practice_id" IS NULL));

-- The practice-side read: one firm's history, newest first, which is what the
-- roster screen asks for beside the switch that causes the suppressions.
CREATE INDEX IF NOT EXISTS "notification_log_practice_idx"
  ON "notification_log" ("practice_id", "created_at");
