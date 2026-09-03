-- Phase 110: recording *which* checks a date put out of reach.
--
-- Phase 109 gave the run two kinds of absence — a check whose module is
-- switched off, and a check that applies but can only speak for today — and
-- then said reading a stored run back could not tell them apart:
--
--   > Reading a **stored** run back cannot tell them apart: the row records a
--   > count, not which kind.
--
-- That was true of the row as it stood and false as a statement about what a
-- row can record. The keys are known at run time; nothing was writing them
-- down. So this column writes them down.
--
-- The keys rather than a count, because the count is derivable from the keys
-- and the keys are not derivable from the count — and because the register
-- already stores a check by its key for the reason ADR 0033 gave: a foreign
-- key to a table of names pointing at functions is a foreign key to something
-- that may not exist.
--
-- `[]` for every run that already exists, which is what they were: the nightly
-- run asks about today, where nothing is out of reach.

ALTER TABLE "integrity_runs"
  ADD COLUMN "checks_out_of_reach" jsonb NOT NULL DEFAULT '[]'::jsonb;
