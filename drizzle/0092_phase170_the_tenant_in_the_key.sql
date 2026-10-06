-- Phase 170: the tenant in the key.
--
-- ADR 0169 closed a gap and left one open, and said so:
--
--   **No tenant predicate on `item_id` at insert.** The foreign key cannot
--   express "and it must be yours", and `createInvoice` does not check. The
--   scoped join keeps it out of reports, and that is containment rather than
--   prevention.
--
-- ## The foreign key *can* express it
--
-- That sentence was wrong about the database. A single-column key cannot say
-- "and it must be yours"; a **composite** one can, because the referencing
-- row's own `company_id` becomes part of the reference:
--
--   FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
--
-- A line in company A then cannot point at an item in company B, because the
-- pair (A, item-of-B) does not exist in the target. Nothing is remembered, no
-- scan has to stay green, and a writer added next year inherits it.
--
-- ## Measured before deciding: 271, and none of them
--
-- Across 167 company-scoped tables, `pg_constraint` holds **271 foreign keys
-- from one tenant-scoped table to another, every one single-column.** Not one
-- reference in this database carries the tenant.
--
-- So this is a class rather than a bug, and the right first move is a mechanism
-- demonstrated on the case that motivated it, with the other 269 counted rather
-- than waved at. `REFERENCE_ROLLOUT` carries the stages and
-- `tests/the-id-a-caller-hands-in.test.ts` asserts the measured count, so the
-- number can only move one way and says so when it does.
--
-- ## The price, stated
--
-- The target needs a unique index on `(company_id, id)` when `id` is already
-- unique by itself, which is redundant on its face. It buys a guarantee no
-- amount of application code can, it is one index per referenced table, and the
-- alternative is 271 lookups somebody has to keep writing.

ALTER TABLE service_items
  ADD CONSTRAINT service_items_company_id_key UNIQUE (company_id, id);

--------------------------------------------------------------------------------
-- `invoice_lines.item_id` and `bill_lines.item_id`, which Phase 169 made real
-- foreign keys and could not make tenant-safe.
--
-- `ON DELETE SET NULL` is kept from Phase 169 for its reason: deleting a
-- catalogue entry must not be blocked by an invoice raised three years ago, and
-- must not delete the line either.
--
-- And the delete rule has to name its column, which a single-column key never
-- had to. A bare `ON DELETE SET NULL` nulls **every** column of the reference,
-- and `company_id` is `NOT NULL` — so deleting a catalogue item would fail
-- instead of clearing the line. `ON DELETE SET NULL (item_id)` is the column
-- list form, available from PostgreSQL 15 and verified against the 16.13 this
-- runs on. It is the one thing about a composite tenant key that is not a
-- mechanical substitution, which is why `REFERENCE_ROLLOUT` says the other 269
-- cannot be done by search and replace.

ALTER TABLE invoice_lines
  DROP CONSTRAINT invoice_lines_item_id_service_items_id_fk;

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE SET NULL (item_id);

ALTER TABLE bill_lines
  DROP CONSTRAINT bill_lines_item_id_service_items_id_fk;

ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_item_tenant_fk
  FOREIGN KEY (company_id, item_id) REFERENCES service_items (company_id, id)
  ON DELETE SET NULL (item_id);
