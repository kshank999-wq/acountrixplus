-- Phase 57: statements sent on a schedule, rather than on an afternoon nobody
-- ever has.
--
-- Phase 55 made a statement sendable and said in its own ADR that a scheduler
-- which emails every customer without anybody deciding again is "the feature
-- that most deserves its own phase, with its own preview screen, rather than
-- being tacked onto this one". This is that phase.
--
-- Sending statements is the highest-leverage collections act a small business
-- has — most late payment is not refusal, it is an invoice that fell behind a
-- filing cabinet — and it is exactly the sort of repetitive, unurgent job that
-- never actually happens.

-- Its own table rather than more columns on `chase_settings`.
--
-- Chasing is a demand aimed at one late invoice; a statement is a summary of an
-- account, and plenty of companies want the second without ever wanting the
-- first. Folding them together would mean switching on statements switched on
-- chasing, which is not a thing anybody asked for.
CREATE TABLE IF NOT EXISTS "statement_settings" (
  "company_id" uuid PRIMARY KEY REFERENCES "companies"("id") ON DELETE CASCADE,

  -- Off, and no backfill. Every company begins silent and stays that way until
  -- a person turns it on: this sends email to *their customers* over *their*
  -- name, and a feature that starts doing that because a migration ran is one
  -- nobody consented to. The same reasoning `chase_settings` records.
  "enabled" boolean NOT NULL DEFAULT false,

  -- Constrained to a day every month actually has. "The 31st" does not exist in
  -- seven months of the year, and a schedule that silently skips February is
  -- worse than one that runs on the 28th.
  "day_of_month" integer NOT NULL DEFAULT 1,

  "kind" text NOT NULL DEFAULT 'open_item',

  -- Nothing owed below this is sent. Held credit is deliberately exempt: the
  -- floor exists to stop trivial *demands*, and money the business is holding
  -- for somebody is not a demand (Phase 54).
  "minimum_balance_cents" bigint NOT NULL DEFAULT 500,

  -- Days of quiet after the last statement went, counted from the send rather
  -- than from the last run — so one sent by hand on the 29th stops the run
  -- sending another on the 1st. Answerable only because Phase 55 finally wrote
  -- `customer_statements.sent_at`.
  "quiet_days" integer NOT NULL DEFAULT 20,

  -- A ceiling on one run, guarding the accident that happens exactly once: the
  -- feature switched on for the first time against a book of four hundred
  -- customers.
  "max_per_run" integer NOT NULL DEFAULT 200,

  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "statement_settings_day_of_month_check"
    CHECK ("day_of_month" BETWEEN 1 AND 28),
  CONSTRAINT "statement_settings_kind_check"
    CHECK ("kind" IN ('open_item', 'balance_forward')),
  CONSTRAINT "statement_settings_minimum_check"
    CHECK ("minimum_balance_cents" >= 0),
  CONSTRAINT "statement_settings_quiet_days_check"
    CHECK ("quiet_days" >= 0),
  CONSTRAINT "statement_settings_max_per_run_check"
    CHECK ("max_per_run" > 0)
);

-- What the run asks, once per customer per day: "when did this customer last
-- receive a statement?" Without this it is a sequential scan of every statement
-- ever saved, on every run.
CREATE INDEX IF NOT EXISTS "customer_statements_sent_idx"
  ON "customer_statements" ("company_id", "customer_id", "sent_at" DESC)
  WHERE "sent_at" IS NOT NULL;
