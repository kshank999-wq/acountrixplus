-- Phase 180: what we sent this client.
--
-- §8's last bullet: *"Assets can be associated with campaigns, contacts,
-- companies, opportunities, or client records."* Measured in ADR 0173 as one of
-- eight capabilities with nothing behind them, and the measurement holds:
-- `assets` carries `company_id`, `kind`, `filename`, storage, provenance and
-- `derived_from_id`, and not one column naming any of the five.
--
-- The consequence is the question nobody can answer — **"what have we sent this
-- client"** — which is the question a studio exists to answer before it makes
-- the next thing.
--
-- ## Why this is not shaped like `document_links`
--
-- There is a precedent and it is good: Phase 20 moved receipts out of a `jsonb`
-- array into `document_links`, with a `subject_type` enum and a `subject_id`,
-- and `modules/evidence/subjects.ts` registers what may carry evidence. Copying
-- that shape here was the obvious move.
--
-- Its own docstring says why not:
--
--   > A polymorphic reference has no foreign key, so nothing in the database
--   > stops a link pointing at a uuid that belongs to another company — or to
--   > nothing at all. The check has to live in code, and if it lives in the
--   > *caller* then every new screen that attaches a file is a fresh chance to
--   > forget it.
--
-- That was the right trade in Phase 20 and it is the wrong one now, because
-- Phases 170–172 spent three phases putting the tenant *into keys* precisely so
-- the database would refuse what a forgotten check lets through. Writing a
-- thirteenth polymorphic subject reference one phase after Phase 179 found a
-- nine-phase-old hole in a cross-tenant check would be choosing the shape this
-- repository has been migrating away from.
--
-- So: **five nullable columns, one real composite foreign key each, and a CHECK
-- that exactly one is set.** Every consequence of the polymorphic design
-- inverts:
--
--   * A link to another company's campaign is refused by the database, not by
--     a function somebody has to remember to call.
--   * A link to a uuid that names nothing is refused the same way.
--   * Deleting a campaign takes its links with it, by `ON DELETE CASCADE`,
--     rather than leaving rows pointing at nothing.
--   * Exactly one subject per row is a constraint rather than a convention.
--
-- The price is honest and worth naming: **a sixth kind of subject is a
-- migration, not a row in a register.** §8 names five. A migration per new kind
-- is what the database doing the checking costs, and it is the same bargain
-- `retention.test.ts` states in its own words — *"that is the price of the
-- moment where somebody decides."*
--
-- `document_links` is left alone. Twelve polymorphic subject references with no
-- key is now the odd shape in this codebase rather than the precedent, and
-- converting it is its own phase with its own migration; ADR 0180 nominates it.
--
-- ## The six uniques
--
-- A composite foreign key needs a unique on exactly the columns it points at,
-- so `assets` and the five subject tables each gain `UNIQUE (company_id, id)`.
-- That is Phase 170's device, and it is the sixth, seventh, eighth, ninth,
-- tenth and eleventh table to get one.
--
-- ## And the policy, in this migration rather than the next
--
-- Phase 177 added a tenant-scoped table and did not police it; Phase 179 found
-- it, two phases and two pushes later, with the live row-level-security check
-- having reported the fault the whole time. So the policy goes in here, beside
-- the table, where forgetting it is not possible.

ALTER TABLE assets         ADD CONSTRAINT assets_company_id_key         UNIQUE (company_id, id);
ALTER TABLE campaigns      ADD CONSTRAINT campaigns_company_id_key      UNIQUE (company_id, id);
ALTER TABLE contacts       ADD CONSTRAINT contacts_company_id_key       UNIQUE (company_id, id);
ALTER TABLE organizations  ADD CONSTRAINT organizations_company_id_key  UNIQUE (company_id, id);
ALTER TABLE opportunities  ADD CONSTRAINT opportunities_company_id_key  UNIQUE (company_id, id);
ALTER TABLE customers      ADD CONSTRAINT customers_company_id_key      UNIQUE (company_id, id);

CREATE TABLE asset_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,

  asset_id uuid NOT NULL,

  -- Exactly one of these five. §8's five, in §8's order, each a real key.
  campaign_id uuid,
  contact_id uuid,
  organization_id uuid,
  opportunity_id uuid,
  customer_id uuid,

  /*
    Why this asset is on this record, when the association is not obvious from
    the filename. Optional: "the capability statement we sent them" is worth
    writing down and "logo.png on our own company record" is not.
  */
  note text,

  linked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asset_links_asset_fkey
    FOREIGN KEY (company_id, asset_id) REFERENCES assets (company_id, id) ON DELETE CASCADE,
  CONSTRAINT asset_links_campaign_fkey
    FOREIGN KEY (company_id, campaign_id) REFERENCES campaigns (company_id, id) ON DELETE CASCADE,
  CONSTRAINT asset_links_contact_fkey
    FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE,
  CONSTRAINT asset_links_organization_fkey
    FOREIGN KEY (company_id, organization_id) REFERENCES organizations (company_id, id) ON DELETE CASCADE,
  CONSTRAINT asset_links_opportunity_fkey
    FOREIGN KEY (company_id, opportunity_id) REFERENCES opportunities (company_id, id) ON DELETE CASCADE,
  CONSTRAINT asset_links_customer_fkey
    FOREIGN KEY (company_id, customer_id) REFERENCES customers (company_id, id) ON DELETE CASCADE,

  /*
    Exactly one subject. Not "at least one", which would let a row name a
    campaign *and* a contact and leave every reader guessing which association
    it is; and not "at most one", which would let a link point at nothing and
    turn the whole table into rows that mean nothing.

    Counted rather than written as a chain of `is null` pairs, because the chain
    is ten comparisons that have to stay in step and the count is one number.
  */
  CONSTRAINT asset_links_one_subject_check CHECK (
    (campaign_id IS NOT NULL)::int
    + (contact_id IS NOT NULL)::int
    + (organization_id IS NOT NULL)::int
    + (opportunity_id IS NOT NULL)::int
    + (customer_id IS NOT NULL)::int
    = 1
  )
);

COMMENT ON TABLE asset_links IS
  'What a creative asset is about (§8): exactly one of a campaign, contact, organisation, opportunity or customer, each by a composite key carrying the tenant. Answers "what have we sent this client".';

/*
  One link per asset per subject. Partial, one per column, because Postgres
  treats NULLs as distinct in a unique index: a plain UNIQUE over all five
  columns would permit (asset, campaign) twice as long as the other four were
  null, which is every row.

  The partial form also says the intent — this is a uniqueness rule about rows
  that name a campaign, not about rows in general.
*/
CREATE UNIQUE INDEX asset_links_campaign_unique
  ON asset_links (company_id, asset_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE UNIQUE INDEX asset_links_contact_unique
  ON asset_links (company_id, asset_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX asset_links_organization_unique
  ON asset_links (company_id, asset_id, organization_id) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX asset_links_opportunity_unique
  ON asset_links (company_id, asset_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX asset_links_customer_unique
  ON asset_links (company_id, asset_id, customer_id) WHERE customer_id IS NOT NULL;

-- The read §8 is actually about: given a record, what have we sent it. One
-- index per subject because each query filters on its own column.
CREATE INDEX asset_links_campaign_idx     ON asset_links (company_id, campaign_id)     WHERE campaign_id IS NOT NULL;
CREATE INDEX asset_links_contact_idx      ON asset_links (company_id, contact_id)      WHERE contact_id IS NOT NULL;
CREATE INDEX asset_links_organization_idx ON asset_links (company_id, organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX asset_links_opportunity_idx  ON asset_links (company_id, opportunity_id)  WHERE opportunity_id IS NOT NULL;
CREATE INDEX asset_links_customer_idx     ON asset_links (company_id, customer_id)     WHERE customer_id IS NOT NULL;

-- And the other direction: what is this asset on.
CREATE INDEX asset_links_asset_idx ON asset_links (company_id, asset_id);

-- Phase 179's lesson, applied in the migration that creates the table rather
-- than two phases later.
ALTER TABLE asset_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON asset_links;
CREATE POLICY tenant_isolation ON asset_links
  FOR ALL TO accountrix_app
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_links TO accountrix_app;
