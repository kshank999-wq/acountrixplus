-- Phase 50: a second pair of eyes on money going out.
--
-- With a single permission one person could create a supplier (Phase 45),
-- enter a bill to it (Phase 41) and pay it (Phase 49) — and nothing recorded
-- who entered the bill. That is the fictitious-supplier fraud, and it is the
-- control most small-business theft actually exploits: not a clever exploit,
-- just nobody looking.
--
-- Off by default. A sole trader is their own bookkeeper and their own
-- approver, and a system that ships this switched on has shipped a feature
-- most of its users must immediately disable.

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "entered_by" uuid;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "approved_by" uuid;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;

-- Deliberately not backfilled. A bill entered before this phase has no
-- honest answer to "who entered it", and inventing one — the owner, say —
-- would put a name against a decision that person may never have made. Null
-- means "we do not know", and the two-person rule stands aside rather than
-- refusing, so those bills stay approvable by anybody.

CREATE INDEX IF NOT EXISTS "bills_awaiting_approval_idx"
  ON "bills" ("company_id", "approved_by", "status");

CREATE TABLE IF NOT EXISTS "payables_settings" (
  "company_id" uuid PRIMARY KEY REFERENCES "companies"("id") ON DELETE CASCADE,

  -- Off unless somebody turns it on.
  "approval_enabled" boolean NOT NULL DEFAULT false,

  -- Bills at or above this need an approval. Zero means every bill.
  --
  -- A threshold rather than all-or-nothing because the point is attention,
  -- and attention is finite: a rule that stops the week for a small parking
  -- receipt is a rule somebody approves without reading, which is worse than
  -- no rule at all.
  "approval_threshold_cents" bigint NOT NULL DEFAULT 100000,

  -- Whether the approver may be the person who entered it.
  --
  -- Separate from the threshold on purpose. "Somebody must approve the big
  -- ones" and "it may not be the same somebody" are two different decisions,
  -- and a two-person business may want the first without being able to honour
  -- the second.
  "two_person_rule" boolean NOT NULL DEFAULT true,

  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
