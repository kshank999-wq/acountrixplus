-- Phase 171: every reference into the catalogue.
--
-- ADR 0170 converted two of 271 tenant references to composite keys and
-- nominated the next slice "by referenced table rather than by referencing one:
-- every reference into `service_items` first, since the unique index is already
-- there and the pattern is proved."
--
-- ## Measured: sixteen, two done, fourteen left, three shapes
--
-- From `pg_constraint`, the references into `service_items` from tenant-scoped
-- tables:
--
--   SET NULL, nullable column     appointments, proposal_items,
--                                 repair_order_lines, time_entries        4
--   RESTRICT, NOT NULL column     bills_of_materials, bom_components,
--                                 goods_receipt_lines, inventory_lots,
--                                 invoice_costings, purchase_order_lines,
--                                 stock_adjustments, stock_movements,
--                                 work_orders                             9
--   RESTRICT, nullable column     work_order_entries                      1
--
-- All fourteen have `company_id NOT NULL`, which is what makes every one of
-- them convertible.
--
-- Three shapes in sixteen references is the non-uniformity ADR 0170 predicted
-- when it declined to sweep all 271 mechanically, and the delete rule is where
-- it bites: only the four `SET NULL` ones need the column-list form
-- `ON DELETE SET NULL (col)`, because a bare `SET NULL` would try to null
-- `company_id` as well and fail against its `NOT NULL`. The ten `RESTRICT` ones
-- need nothing of the sort, because `RESTRICT` nulls nothing.
--
-- ## Existing mismatches are refused, not tidied away
--
-- A composite key cannot be added while a row points at an item in another
-- company, and this migration deliberately does **not** clean those up.
--
-- Phase 169's migration cleared dangling ids before adding its foreign keys,
-- and that was right: an id pointing at nothing is already meaningless. A
-- cross-tenant id is different in kind. It points at real data belonging to
-- somebody else, which is evidence of a bug and possibly of a disclosure — and
-- a migration that quietly nulled it would destroy the only record that it
-- happened.
--
-- So the check below runs first and raises with the count. A deployment that
-- fails here has learned something it needed to know.
--
-- Worth stating plainly: the test database is truncated between tests, so it
-- holds no evidence either way about production data. This check is written for
-- the database that does.
--
-- ## A side effect worth naming
--
-- Three of these constraints were still called `..._service_item_id_...`, from
-- before Phase 169 renamed the columns to `item_id`. Phase 169 renamed the
-- *index* it had created and left the constraints Postgres and Drizzle had
-- named — the same small untruth in the catalogue it had just argued against,
-- one object type over. Dropping and recreating every one of these as
-- `..._item_tenant_fk` settles it, and it is a side effect rather than the
-- point: the names were found by reading `pg_constraint` to get the DROPs
-- right, not by looking for them.

DO $$
DECLARE
  offending integer;
  report text := '';
  r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'appointments', 'proposal_items', 'repair_order_lines', 'time_entries',
      'bills_of_materials', 'bom_components', 'goods_receipt_lines',
      'inventory_lots', 'invoice_costings', 'purchase_order_lines',
      'stock_adjustments', 'stock_movements', 'work_order_entries', 'work_orders'
    ]) AS tbl,
    unnest(ARRAY[
      'item_id', 'item_id', 'item_id', 'item_id',
      'output_item_id', 'component_item_id', 'item_id',
      'item_id', 'item_id', 'item_id',
      'item_id', 'item_id', 'item_id', 'output_item_id'
    ]) AS col
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I t JOIN service_items s ON s.id = t.%I
         WHERE s.company_id <> t.company_id', r.tbl, r.col
    ) INTO offending;

    IF offending > 0 THEN
      report := report || format(E'\n  %s.%s: %s row(s)', r.tbl, r.col, offending);
    END IF;
  END LOOP;

  IF report <> '' THEN
    RAISE EXCEPTION E'Cross-tenant references into service_items found, so the composite keys cannot be added:%\n\nThese rows point at another company''s catalogue item. They are not cleaned up here on purpose: a dangling id is meaningless and safe to clear, while this is real data belonging to somebody else and the row is the only record that it happened. Investigate, then decide.', report;
  END IF;
END $$;

--------------------------------------------------------------------------------
-- Shape one: SET NULL on a nullable column.
--
-- The column list is required. `ON DELETE SET NULL` with no list nulls every
-- column of the reference, `company_id` is `NOT NULL`, and the delete would
-- fail — which would turn "deleting a catalogue entry must not be blocked by an
-- invoice raised three years ago" into exactly the block it was written against.

ALTER TABLE appointments
  DROP CONSTRAINT appointments_service_item_id_service_items_id_fk;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE SET NULL (item_id);

-- `..._fkey`, not `..._service_items_id_fk`: Phase 168 added this column with an
-- inline `references()` and let Postgres name the constraint, while the others
-- were named by Drizzle. Checked against `pg_constraint` rather than guessed.
ALTER TABLE proposal_items
  DROP CONSTRAINT proposal_items_service_item_id_fkey;
ALTER TABLE proposal_items
  ADD CONSTRAINT proposal_items_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE SET NULL (item_id);

ALTER TABLE repair_order_lines
  DROP CONSTRAINT repair_order_lines_item_id_service_items_id_fk;
ALTER TABLE repair_order_lines
  ADD CONSTRAINT repair_order_lines_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE SET NULL (item_id);

ALTER TABLE time_entries
  DROP CONSTRAINT time_entries_service_item_id_service_items_id_fk;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE SET NULL (item_id);

--------------------------------------------------------------------------------
-- Shape two: RESTRICT.
--
-- Nothing is nulled, so no column list, and the `NOT NULL` on nine of the ten
-- is irrelevant to the delete rule. `RESTRICT` is the right rule for all of
-- them for a reason that has nothing to do with tenancy: a stock movement or a
-- bill of materials that lost the item it moved would be a record of nothing.

ALTER TABLE bills_of_materials
  DROP CONSTRAINT bills_of_materials_output_item_id_service_items_id_fk;
ALTER TABLE bills_of_materials
  ADD CONSTRAINT bills_of_materials_output_item_tenant_fk
  FOREIGN KEY (company_id, output_item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE bom_components
  DROP CONSTRAINT bom_components_component_item_id_service_items_id_fk;
ALTER TABLE bom_components
  ADD CONSTRAINT bom_components_component_item_tenant_fk
  FOREIGN KEY (company_id, component_item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE goods_receipt_lines
  DROP CONSTRAINT goods_receipt_lines_item_id_service_items_id_fk;
ALTER TABLE goods_receipt_lines
  ADD CONSTRAINT goods_receipt_lines_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE inventory_lots
  DROP CONSTRAINT inventory_lots_item_id_service_items_id_fk;
ALTER TABLE inventory_lots
  ADD CONSTRAINT inventory_lots_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE invoice_costings
  DROP CONSTRAINT invoice_costings_item_id_service_items_id_fk;
ALTER TABLE invoice_costings
  ADD CONSTRAINT invoice_costings_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE purchase_order_lines
  DROP CONSTRAINT purchase_order_lines_item_id_service_items_id_fk;
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT purchase_order_lines_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE stock_adjustments
  DROP CONSTRAINT stock_adjustments_item_id_service_items_id_fk;
ALTER TABLE stock_adjustments
  ADD CONSTRAINT stock_adjustments_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE stock_movements
  DROP CONSTRAINT stock_movements_item_id_service_items_id_fk;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

ALTER TABLE work_orders
  DROP CONSTRAINT work_orders_output_item_id_service_items_id_fk;
ALTER TABLE work_orders
  ADD CONSTRAINT work_orders_output_item_tenant_fk
  FOREIGN KEY (company_id, output_item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;

--------------------------------------------------------------------------------
-- Shape three: RESTRICT on a nullable column.
--
-- One of the sixteen, and it is its own shape because the pair is unusual
-- rather than because the SQL differs: a column that may be null, whose item
-- may not be deleted while it is set. `work_order_entries.item_id` is null for
-- labour and set for a part consumed, and a part that has been consumed is not
-- deletable — which is the same argument as shape two and arrives at it from a
-- nullable column.

ALTER TABLE work_order_entries
  DROP CONSTRAINT work_order_entries_item_id_service_items_id_fk;
ALTER TABLE work_order_entries
  ADD CONSTRAINT work_order_entries_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE RESTRICT;
