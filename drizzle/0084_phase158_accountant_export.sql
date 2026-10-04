-- Phase 158: what a professional export needs that the books did not hold.
--
-- The Accountrix Plus Professional Accountant Export Engine specification, §5
-- and §12. Two things, and the first is the one measurement found.
--
-- ## The entity fields, and why their absence was a red check
--
-- §5's package opens with "Client / entity information" and "Entity type and tax
-- classification", and §11 makes an incomplete client profile a *red* exception:
-- the entity type decides which return the figures feed and the fiscal year
-- decides which year they land in, so a package that leaves either to be guessed
-- invites a firm to prepare an 1120-S from partnership books.
--
-- Measured against `companies`: it holds a name, a legal name, an industry, a
-- fiscal year start month, a currency and an inventory cost method. There is no
-- entity type and no EIN.
--
-- So `entity_data_complete` would have fired on every company in existence, and
-- a red check that can only fail is worth exactly as little as Phase 121's check
-- that can only agree. One of the two had to change, and it was not going to be
-- the check: "which return do these books feed" is a real question with no
-- answer in this schema.
--
-- `industry` is not it, and the distinction matters. A restaurant can be a sole
-- proprietorship, a partnership or an S corporation; the industry drives the
-- chart of accounts and the tax classification drives the return, and bending
-- the nearest existing column to mean both would be Phase 130's defect in the
-- field a federal return is selected from.

ALTER TABLE companies
  -- Null means nobody has said, which is the state every existing company is in
  -- and a different thing from a default. Defaulting this to 'sole_proprietor'
  -- would make the readiness check pass by asserting something nothing recorded
  -- (Phase 110), in the one place where being wrong is a misfiled return.
  ADD COLUMN tax_classification text,

  -- Whether an EIN or TIN is on file. The number itself, because a firm cannot
  -- open a client record without it -- but see the readiness assessment, which
  -- carries only whether one exists: an assessment is shown on screen, logged,
  -- and pasted into support tickets, and §12 says not to move sensitive fields
  -- that are not required.
  ADD COLUMN tax_identifier text,

  ADD CONSTRAINT companies_tax_classification_known CHECK (
    tax_classification IS NULL OR tax_classification IN (
      'sole_proprietor',
      'single_member_llc',
      'partnership',
      'multi_member_llc',
      's_corporation',
      'c_corporation',
      'nonprofit',
      'trust_or_estate'
    )
  ),

  -- An EIN is nine digits and a TIN is nine digits; both are written with or
  -- without punctuation. The check is on length and characters rather than on
  -- format, because this column has to hold what a person typed and the point
  -- of refusing is to catch an empty string or a pasted sentence.
  ADD CONSTRAINT companies_tax_identifier_shape CHECK (
    tax_identifier IS NULL OR (
      length(tax_identifier) BETWEEN 9 AND 20
      AND tax_identifier ~ '^[0-9-]+$'
    )
  );

--------------------------------------------------------------------------------
-- The export audit log (§12).
--
-- §12 requires that an export log "destination, user, client, period,
-- timestamp, adapter version, and result", and §15 that "every export generates
-- an audit log". `data_exports` is the §19 portability log and is not this: that
-- one records a customer taking their own data home, this one records a firm's
-- books being handed to a named professional system in that system's format.
-- Collapsing them would mean a column saying which of the two a row is, and then
-- half the columns null on half the rows.
--
-- The difference that matters: **a held export is a row here.** §11 produces a
-- red status and no file, and that is the event most worth having written down
-- -- somebody tried to send these books to UltraTax in March and could not,
-- and the reason is in `exception_report`. An audit log that only records
-- successes cannot answer "did anybody try".

CREATE TABLE accountant_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,

  -- A key from `EXPORT_DESTINATIONS`, as text. ADR 0033's rule for registry
  -- keys: the register is code, and a foreign key to a table of names pointing
  -- at code is a foreign key to something that may not exist.
  destination_key text NOT NULL,

  -- Which adapter wrote it. §6 requires each adapter to be independently
  -- versioned "so that a vendor's format or API can change without requiring
  -- major changes to the Accountrix core ledger", and a file rejected by a
  -- vendor six weeks later is explicable only if the row says which version
  -- produced it.
  adapter_version text NOT NULL,

  period_start date NOT NULL,
  period_end date NOT NULL,

  -- §11's green / yellow / red, and the report the accountant was shown. Stored
  -- rather than recomputed, for the same reason Phase 156 stored a billed
  -- amount: this describes what somebody was told on a day, and the books have
  -- moved since.
  readiness text NOT NULL,
  exception_count integer NOT NULL DEFAULT 0,
  exception_report text NOT NULL,

  -- 'generated' when files were produced, 'held' when §11 stopped it. Null file
  -- counts on a held row are the honest shape: nothing was written.
  result text NOT NULL,
  file_count integer,
  byte_count integer,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT accountant_exports_period CHECK (period_end >= period_start),
  CONSTRAINT accountant_exports_readiness CHECK (readiness IN ('green', 'yellow', 'red')),
  CONSTRAINT accountant_exports_result CHECK (result IN ('generated', 'held')),

  -- The two states, enforced rather than hoped for: a generated export has
  -- files and a held one has none. A row claiming to have written 0 files
  -- successfully, or to have been held while writing 11, is not a thing that
  -- happened.
  CONSTRAINT accountant_exports_files_match_result CHECK (
    (result = 'generated' AND file_count IS NOT NULL AND file_count > 0 AND byte_count IS NOT NULL)
    OR (result = 'held' AND file_count IS NULL AND byte_count IS NULL)
  ),

  -- A red assessment cannot have generated a file, and a generated file cannot
  -- have been red. This is the acceptance criterion from §15 -- "every export is
  -- balanced and validated before release" -- as a constraint rather than a
  -- check, which is what Phase 116 settled: the code that would skip the
  -- validation cannot write the row that records having skipped it.
  CONSTRAINT accountant_exports_red_is_held CHECK (
    (readiness = 'red') = (result = 'held')
  )
);

-- Read per company, newest first, on the portal's export history.
CREATE INDEX accountant_exports_company_idx
  ON accountant_exports (company_id, created_at DESC);
