-- Phase 96: putting two records of one business together.
--
-- The losing record is archived rather than deleted, and points at the one that
-- absorbed it. Deleting it would destroy the only record that the merge
-- happened; leaving it archived with no pointer would strand anybody following
-- a bookmark, an export, or their own memory of the old name.
--
-- Self-referencing and nullable: almost every row is null, and the ones that
-- are not name a row in the same table. ON DELETE SET NULL rather than RESTRICT
-- because a company being deleted cascades both rows away anyway, and a
-- surviving pointer to a deleted record would be worse than none.

ALTER TABLE "customers"
  ADD COLUMN "merged_into_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL;

ALTER TABLE "vendors"
  ADD COLUMN "merged_into_id" uuid REFERENCES "vendors"("id") ON DELETE SET NULL;

-- A record cannot absorb itself.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_merged_into_not_self" CHECK ("merged_into_id" <> "id");

ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_merged_into_not_self" CHECK ("merged_into_id" <> "id");

-- A merged record is always archived. Stated as a constraint rather than left
-- to the service, because a merged record that is still active would appear in
-- every picker as a live customer with no documents on it — which is precisely
-- the duplicate Phase 94 exists to report.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_merged_is_archived"
  CHECK ("merged_into_id" IS NULL OR "is_active" = false);

ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_merged_is_archived"
  CHECK ("merged_into_id" IS NULL OR "is_active" = false);
