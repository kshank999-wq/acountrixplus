-- Phase 169: one name, and two references that were not.
--
-- ADR 0168 nominated `service_item_id` on `invoice_lines`, "which turns the
-- same question on realised revenue rather than on offers".
--
-- ## That nomination was false, and it was mine
--
-- `invoice_lines.item_id` has referenced the service catalogue since **Phase
-- 14**. Its own docstring says so: "The catalogue item sold (Phase 14). Set on
-- a stocked line, which is what tells the invoice to relieve inventory."
--
-- So the column ADR 0168 asked for already existed under another name. Fourth
-- false *reason* in this lineage after §9's "geography analytics" (ADR 0164),
-- §11's "segments has strategic-account segmentation" (ADR 0167) and §9's
-- "nothing measures sent to decided" (ADR 0168) -- and the first one written by
-- the phase that had just spent four paragraphs on the cost of a claim nobody
-- re-measured.
--
-- Worse than wrong: Phase 168 added `proposal_items.service_item_id` while
-- believing the invoice side had nothing, so it **widened** a naming split it
-- had not noticed.
--
-- ## One name for one relationship
--
-- Measured across `src/db/schema`, references to `service_items`:
--
--   item_id            invoice_lines, bill_lines, six inventory tables,
--                      manufacturing, vehicles                       (9)
--   service_item_id    time_entries, appointments,
--                      proposal_items (added Phase 168)              (3)
--
-- Two names for one thing, and the split predates Phase 168 by two tables. The
-- dominant name wins -- and it is the better one anyway, because
-- `service_items` is the single catalogue of *both* services and stocked goods,
-- so a line selling a stocked product through a column called
-- `service_item_id` was already reading oddly.
--
-- A pure rename: the data moves with the column.

ALTER TABLE proposal_items RENAME COLUMN service_item_id TO item_id;
ALTER TABLE time_entries RENAME COLUMN service_item_id TO item_id;
ALTER TABLE appointments RENAME COLUMN service_item_id TO item_id;

-- The indexes and constraints Postgres auto-named after the old column keep
-- their names, which would be a lie in the catalogue. Renamed too, because an
-- index called `..._service_idx` on a column called `item_id` is the kind of
-- small untruth that costs somebody an afternoon.
ALTER INDEX proposal_items_service_idx RENAME TO proposal_items_item_idx;

--------------------------------------------------------------------------------
-- And the two that were never references at all.
--
-- `invoice_lines.item_id` and `bill_lines.item_id` are declared in the schema as
-- bare `uuid('item_id')` with no `references()`, and `pg_constraint` confirms
-- it: of the twelve places this codebase points at `service_items`, these two
-- are the **only** ones that are not foreign keys.
--
-- They are also the two that matter most. `item_id` on an invoice line is what
-- tells the invoice to relieve inventory, and it is what any report of revenue
-- by product has to group on. An id pointing at nothing -- a deleted item, a
-- value from another company, a typo in a payload -- would relieve no stock and
-- group revenue under a product that does not exist, and nothing anywhere would
-- say so. The stock path scopes its lookup by company, so a foreign id simply
-- finds nothing and the line goes through: it degrades silently, which is the
-- shape Phase 160 found in `devices` and `security_policies`.
--
-- Phase 116's rule: a constraint beats a check. There is nothing to remember
-- once the database refuses it.
--
-- `set null` rather than `restrict`, matching `vehicles.item_id` and
-- `time_entries.item_id`: deleting a catalogue entry must not be blocked by an
-- invoice raised three years ago, and must not delete the line either. The line
-- survives and says nothing about what it was, which is true -- and
-- `serviceRevenue` reports those lines under their own heading rather than
-- dropping them.

-- Any id already pointing at nothing is already meaningless, so it is cleared
-- rather than allowed to block the constraint. Measured zero in the test
-- database; written anyway, because a migration that only works on an empty
-- table is not a migration.
UPDATE invoice_lines SET item_id = NULL
 WHERE item_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM service_items s WHERE s.id = invoice_lines.item_id);

UPDATE bill_lines SET item_id = NULL
 WHERE item_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM service_items s WHERE s.id = bill_lines.item_id);

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_item_id_service_items_id_fk
  FOREIGN KEY (item_id) REFERENCES service_items(id) ON DELETE SET NULL;

ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_item_id_service_items_id_fk
  FOREIGN KEY (item_id) REFERENCES service_items(id) ON DELETE SET NULL;

-- Grouping revenue by product reads every line of a period, so the index is
-- the report's, not the constraint's.
CREATE INDEX invoice_lines_item_idx ON invoice_lines (company_id, item_id);
CREATE INDEX bill_lines_item_idx ON bill_lines (company_id, item_id);
