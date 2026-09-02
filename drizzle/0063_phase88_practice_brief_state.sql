-- Phase 88: what each firm was last told about each of its clients.
--
-- Phase 24's daily digest reaches the memberships holding `company:manage`,
-- and that permission belongs to `owner` alone. A practice engagement grants
-- `accountant` by default and is capped by the client, never above it — so the
-- digest goes to the client's owner and never to the firm engaged to keep
-- those books. The person told is the one least equipped to act.
--
-- Adding practice members to the per-company digest would be worse: a firm
-- with forty clients woken forty times every morning is exactly the noise
-- failure that digest was designed to prevent. One brief a day per firm.
--
-- This table is what makes the brief news rather than state. A client that was
-- broken yesterday and is broken today is not news; one that slid a rung is.
-- The rung last *observed* is recorded for every client on every run —
-- including the ones nothing was said about — because a memory that only holds
-- bad news cannot tell a relapse from a standing problem.
--
-- No run log beside it. What was actually sent is already in
-- `transactional_messages`, and a second record of the same fact is the defect
-- this project keeps finding.
CREATE TABLE IF NOT EXISTS "practice_brief_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "practice_id" uuid NOT NULL,
  "company_id" uuid NOT NULL,
  -- One of the Phase 87 rungs. Text rather than an enum: the ladder is named
  -- data in TypeScript and giving it a second home in the database would be
  -- two places to change it and one of them would be forgotten.
  "rung" text NOT NULL,
  "seen_on" date NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "practice_brief_state"
    ADD CONSTRAINT "practice_brief_state_practice_id_practices_id_fk"
    FOREIGN KEY ("practice_id") REFERENCES "practices"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Cascades on the client too: a company that leaves takes its memory with it,
-- so re-engaging later starts fresh rather than comparing against a rung from
-- a relationship that ended.
DO $$ BEGIN
  ALTER TABLE "practice_brief_state"
    ADD CONSTRAINT "practice_brief_state_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One memory per firm per client. The database arbitrates rather than a
-- read-then-write in the handler, because the brief is scheduled and a worker
-- restart can run it twice.
CREATE UNIQUE INDEX IF NOT EXISTS "practice_brief_state_unique"
  ON "practice_brief_state" ("practice_id", "company_id");
