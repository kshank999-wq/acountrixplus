-- Phase 210: the switch painted on.
--
-- Two `is_active` columns go away. Neither had a writer and neither had a
-- reader: `createSegment` and `updateSegment` never set `segments.is_active`
-- and no query, filter or screen consulted it; the same for
-- `vehicles.is_active`, which not even the corrected column scan reports,
-- because `listVehicles` projects its columns by name and this was never among
-- them.
--
-- A column with no writer and no reader is Phase 49's shape, and the honest
-- answer for one is removal rather than a control. Building a retire button to
-- justify a column is inventing a requirement; leaving the column is leaving a
-- promise in the schema that a segment or a vehicle can be turned off.
--
-- The other three the same measurement found — `employees.is_active`,
-- `tax_codes.is_active` and `practitioners.is_active` — are *read*, one of them
-- by a refusal in `bookAppointment` that had never been able to fire. Those got
-- writers, in the same phase, rather than being dropped.
--
-- `segments_company_idx` existed to serve a filter on the column being
-- dropped. It is rebuilt on `(company_id, name)`, which is the order the
-- register lists segments in.

DROP INDEX IF EXISTS "segments_company_idx";
--> statement-breakpoint
ALTER TABLE "segments" DROP COLUMN IF EXISTS "is_active";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "segments_company_idx" ON "segments" USING btree ("company_id","name");
--> statement-breakpoint
ALTER TABLE "vehicles" DROP COLUMN IF EXISTS "is_active";
