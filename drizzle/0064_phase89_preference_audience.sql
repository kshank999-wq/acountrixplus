-- Phase 89: a notification preference belongs to an audience, not to a company.
--
-- Phase 8 gave every topic a per-person on/off switch, keyed on
-- (user, company, topic) with a non-null company. That premise held for eight
-- phases because every notification this application sent belonged to a
-- company.
--
-- Phase 88 made it false. The firm's morning brief belongs to a practice — a
-- third kind of owner, neither a company nor housekeeping — so the one channel
-- that arrives unannounced in somebody's inbox is the one channel with no
-- switch, and the preference machinery cannot be pointed at it because there is
-- nowhere to put the row.
--
-- The fix is not a nullable company. "No company" would then be a missing
-- value, and two rows with a null company are *distinct* as far as an ordinary
-- unique constraint is concerned — the trap `installGlobalSchedules` already
-- documents for schedules, where it is survivable only because that runs at
-- deploy time. A preference toggle is a hot path and read-then-write is not
-- safe there.
--
-- So a row names exactly one owner, the check constraint says so, and the
-- unique index uses NULLS NOT DISTINCT so the database arbitrates.

ALTER TYPE "notification_topic" ADD VALUE IF NOT EXISTS 'practice_brief';

ALTER TABLE "notification_preferences" ALTER COLUMN "company_id" DROP NOT NULL;

ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "practice_id" uuid;

DO $$ BEGIN
  ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_practice_id_practices_id_fk"
    FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Exactly one owner. A row naming two would be read by whichever query asked
-- first; a row naming none would be read by nobody.
DO $$ BEGIN
  ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_one_owner"
    CHECK (("company_id" IS NULL) <> ("practice_id" IS NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The old constraint could not see the new column, so a person could end up
-- with two practice rows for one topic.
ALTER TABLE "notification_preferences"
  DROP CONSTRAINT IF EXISTS "notification_preferences_unique";

-- NULLS NOT DISTINCT is the whole point: without it two rows with the same
-- (user, null company, practice, topic) are unique-constraint-distinct and the
-- upsert silently becomes an insert.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_unique"
  ON "notification_preferences" ("user_id", "company_id", "practice_id", "topic")
  NULLS NOT DISTINCT;
