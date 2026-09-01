-- Phase 86: give the sending reputation a memory.
--
-- Phase 84 measures the rate and Phase 85 attributes it. Both answer "how bad
-- is it now"; neither answers "is it getting better or worse", which is the
-- question a reputation metric exists for. 3% that was 1% last week is a domain
-- sliding; 3% that was 6% last week is a list somebody has already cleaned.
--
-- The counts are stored, not the rates. A rate is derived from these two
-- numbers, and storing it alongside them would be a second answer to a question
-- that already has one — the defect this project keeps finding. Anything that
-- wants a rate divides.
--
-- One row per company per day, written by the daily failure digest whether or
-- not it had anything to say. Recording only the bad days would leave the
-- record blank on exactly the days that are the baseline, which is the flaw in
-- the accidental history `background_jobs.result` already holds.
CREATE TABLE IF NOT EXISTS "sending_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  -- The day the reading was taken, not the window it covers. A date rather than
  -- a timestamp: two runs on the same day are the same reading, and the unique
  -- constraint below is what makes a retry idempotent.
  "taken_on" date NOT NULL,
  -- The window each count covers, so a later change to REPUTATION_WINDOW_DAYS
  -- cannot silently make old readings incomparable with new ones.
  "window_days" integer NOT NULL,
  "accepted" integer NOT NULL,
  "bounced" integer NOT NULL,
  "complained" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "sending_snapshots"
    ADD CONSTRAINT "sending_snapshots_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One reading per company per day. The digest is scheduled daily but a worker
-- restart can run it twice, and a second run must overwrite rather than
-- accumulate: the database arbitrates, not a read-then-write in the handler.
CREATE UNIQUE INDEX IF NOT EXISTS "sending_snapshots_company_day_unique"
  ON "sending_snapshots" ("company_id", "taken_on");

-- Reading a trend is "this company, most recent first, a few weeks back".
CREATE INDEX IF NOT EXISTS "sending_snapshots_company_idx"
  ON "sending_snapshots" ("company_id", "taken_on" DESC);
