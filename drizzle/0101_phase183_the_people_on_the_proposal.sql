-- Phase 183: the people on the proposal.
--
-- §15's second bullet: *"Logo library, brand colors, fonts, imagery, company
-- description, service catalog, team bios, certifications, licenses, insurance
-- information."* ADR 0173 measured `team bios` as having nothing behind it, and
-- the measurement holds: `company_profiles.credentials` covers licences,
-- certifications, insurance and memberships; a bio has no column anywhere.
--
-- ## A table, not a `jsonb` array
--
-- `credentials` is a `jsonb` array on `company_profiles` and is the obvious
-- neighbour to copy. Three reasons not to, and the third is decisive.
--
-- **A document has to point at one.** §15 ends *"brand assets feed both the
-- Proposal Designer and Marketing Creative Studio"*, so a proposal names two of
-- a firm's five people. A reference into a `jsonb` array has no key — which is
-- the argument Phase 180 made one phase after Phase 179 found a cross-tenant
-- check broken for nine phases, and the argument Phase 20 made when it moved
-- receipts out of an array because *"an array cannot answer 'which of these has
-- no paperwork?'"*
--
-- **A bio has a headshot.** That is a reference to `assets`, which means a
-- composite tenant key — and a foreign key out of a `jsonb` element does not
-- exist.
--
-- **A credential is a fact about the company; a bio is a person.** A licence
-- number has no photograph, no ordering anybody argues about, and nobody asks
-- which proposals it appeared on. Copying the array because it is adjacent in
-- the specification's prose would be copying a shape chosen for a different
-- thing.
--
-- ## Not `users`
--
-- The temptation is to hang a bio off `memberships`, since the firm's people are
-- mostly its logins. It is wrong in both directions: a founding principal who
-- never signs in still goes on the capability statement, and a bookkeeper with a
-- login does not. A bio is marketing copy about a person, not an account.
--
-- `user_id` is nullable and optional, so a bio *can* name the account it
-- describes where there is one — which is what lets a future screen offer "write
-- your own bio" without making every bio an account.
--
-- ## Retired, not deleted
--
-- `is_active` rather than a delete, for the reason the clause library already
-- argues: a proposal sent last year named the people who were going to do the
-- work, and somebody leaving must not change what a client was shown. The block
-- stores member ids, so deleting the row would either break an old document or
-- silently drop a name from it.

CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,

  name text NOT NULL,
  /** "Principal", "Lead estimator" — what they do, not their login's role. */
  title text,
  /** The bio itself. Prose, because that is what goes on the page. */
  bio text,
  /**
    Letters after the name — "PE, LEED AP". Separate from
    `company_profiles.credentials`, which is the *company's* licences: a
    person's qualifications and a firm's insurance are different trust signals
    and a client reads them in different places.
  */
  qualifications text,

  email text,
  phone text,

  /*
    The headshot. A composite tenant key, so a bio cannot point at another
    company's asset and the database says so rather than a function somebody has
    to remember to call (Phase 180).

    `ON DELETE SET NULL (headshot_asset_id)` and not cascade: deleting a
    photograph must not delete the person. The column-list form is required
    because `company_id` is `NOT NULL` and cannot be nulled with it.
  */
  headshot_asset_id uuid,

  /** The account this describes, where there is one. Nullable on purpose. */
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,

  /** Somebody decides the order people appear in. A firm has a pecking order. */
  sort_order integer NOT NULL DEFAULT 0,
  /** Retired rather than deleted, so an old proposal still names them. */
  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT team_members_headshot_fkey
    FOREIGN KEY (company_id, headshot_asset_id)
    REFERENCES assets (company_id, id) ON DELETE SET NULL (headshot_asset_id),

  -- The target half for anything that references a member — the `team` block
  -- stores ids, and a future "who worked on this job" would too.
  CONSTRAINT team_members_company_id_key UNIQUE (company_id, id),

  -- A bio with no name is a row nobody can render. Trimmed, because a name of
  -- spaces passes a NOT NULL and renders as a gap in the page.
  CONSTRAINT team_members_name_present_check CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE team_members IS
  'The firm''s people, for §15 team bios. Referenced by the `team` block, so a proposal names two of five. Retired rather than deleted, so a sent proposal still names who was going to do the work.';

CREATE INDEX team_members_company_idx
  ON team_members (company_id, sort_order) WHERE is_active;

-- Phase 179's lesson, in the migration that creates the table.
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON team_members;
CREATE POLICY tenant_isolation ON team_members
  FOR ALL TO accountrix_app
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON team_members TO accountrix_app;
