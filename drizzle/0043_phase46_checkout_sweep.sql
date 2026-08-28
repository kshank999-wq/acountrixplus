-- Phase 46: what the processor last said about a checkout, and when.
--
-- Browser verification of the sweep found the gap this closes. The hourly job
-- reported "1 the processor cannot account for — somebody needs to look", and
-- that sentence lived in a toast and a job payload. On reload it was gone, and
-- the row sat in a list whose own copy says most of these are customers who
-- changed their mind — so the one row that is genuinely alarming looked
-- exactly like the harmless ones, for ever.
--
-- Storing the answer makes the finding durable. "The processor has no record
-- of this" and "still pending at the processor" are different situations with
-- different next actions, and the screen can only tell them apart if the sweep
-- writes down what it was told.

ALTER TABLE "checkouts" ADD COLUMN IF NOT EXISTS "last_reported_status" text;
ALTER TABLE "checkouts" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone;
