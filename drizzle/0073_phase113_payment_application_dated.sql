-- Phase 113: giving a payment application the date it happened.
--
-- `payment_applications` has carried a payment, a document and an amount since
-- Phase 2, and nothing else. No date, and no `created_at` either — so there has
-- never been any way to tell an application made when the money arrived from
-- one made months later out of held credit.
--
-- Two readers need that date and both had to invent one from
-- `payments.payment_date`:
--
--   * `cashBasisBalances` — this codebase recognises cash-basis revenue
--     *through the document a payment settles*, which is its own caveat's
--     wording, so the period an application belongs to is the period it
--     happened in. A March overpayment applied to a July invoice was reported
--     as March revenue, and re-running March **after** that application
--     returned a larger number than it had before: a closed period whose
--     profit changes because of something somebody did today.
--
--   * `settlementsAfter` (Phase 108) — the same substitution, in the machinery
--     that walks the receivables control account back to a date.
--
-- ADR 0112 said of this remedy that "those rows do not exist at all". They do.
-- They were simply undated, which is a smaller gap and a fixable one.

ALTER TABLE "payment_applications"
  ADD COLUMN "applied_on" date;

-- Backfilled to the payment's own date, deliberately and not as a best guess.
--
-- The true date of a credit applied later was never written down anywhere: the
-- journal entry `applyCredit` posts carries `source_type = 'payment'` and the
-- payment's id, exactly like the payment's own entry, so nothing distinguishes
-- them but a memo string. Inventing a date from that would silently restate
-- periods that have already been reported on.
--
-- The payment date *is* what every reader has been using, so this backfill
-- reproduces what the books have been saying rather than changing history.
-- Applications made from here on carry the truth.
UPDATE "payment_applications" pa
SET "applied_on" = p."payment_date"
FROM "payments" p
WHERE pa."payment_id" = p."id" AND pa."applied_on" IS NULL;

ALTER TABLE "payment_applications"
  ALTER COLUMN "applied_on" SET NOT NULL;

-- The query this column exists for: one company's applications up to a date.
CREATE INDEX "payment_applications_dated_idx"
  ON "payment_applications" ("company_id", "applied_on");
