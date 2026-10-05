-- Phase 166: the document a machine laid out.
--
-- Phase 165 settled provenance on `assets` and ADR 0165 nominated the AI Design
-- Assistant next. Reading spec §11 closely before building it turned up a gap in
-- Phase 165's own work.
--
-- ## What §11 actually asks for
--
--   generate layout suggestions, brand-consistent variations,
--   background/graphic concepts, image prompts, and logo ideation;
--   preserve user control and provenance
--
-- Every one of those is **advisory**: *suggestions*, *variations*, *concepts*,
-- *prompts*, *ideation*. None of it is pixel generation, and the one bullet that
-- sounds like it -- "image prompts" -- is explicitly text for a person to take
-- elsewhere. Which fits what this platform can do: there is no image model
-- behind the gateway, and the design engine is blocks and a hand-written PDF
-- writer.
--
-- ## So Phase 165 put provenance where this assistant does not write
--
-- `assets.provenance_origin` is right, and it is right for uploads, for
-- derivation, and for a future image generator. It is not where an accepted
-- layout suggestion lands.
--
-- Measured: `disclosureForDocument` computes a document's disclosure **only**
-- from the assets its blocks reference. So a document whose entire layout came
-- from an accepted AI suggestion, illustrated with the client's own
-- photographs, would disclose **nothing** -- while being, in the sense a reader
-- cares about, a machine-laid-out document.
--
-- That is Phase 165's rule turned on Phase 165: provenance that does not cover
-- the thing that was generated is true about the parts and false about the
-- whole.
--
-- ## The same shape, one level up
--
-- Same four origins, same bidirectional CHECK, same reasoning. A machine origin
-- requires a ledger row so the claim is checkable; a human origin forbids one,
-- which is the direction that matters, because without it a document could
-- carry an AI request and be disclosed as hand-made.

ALTER TABLE design_documents
  -- `'authored'` rather than `'uploaded'`: a design document is made in the
  -- application, never supplied as a file. The backfill asserts a measured fact
  -- for the same reason Phase 165's did -- every existing document was laid out
  -- by a person, because nothing else could.
  ADD COLUMN provenance_origin text NOT NULL DEFAULT 'authored',

  ADD COLUMN ai_request_id uuid REFERENCES ai_requests(id) ON DELETE SET NULL,

  ADD CONSTRAINT design_documents_provenance_origin_known CHECK (
    provenance_origin IN ('uploaded', 'authored', 'ai-assisted', 'ai-generated')
  ),

  ADD CONSTRAINT design_documents_provenance_matches_request CHECK (
    (provenance_origin IN ('ai-assisted', 'ai-generated') AND ai_request_id IS NOT NULL)
    OR (provenance_origin IN ('uploaded', 'authored') AND ai_request_id IS NULL)
  );

--------------------------------------------------------------------------------
-- And the default goes, for Phase 165's reason.
--
-- Keeping it would mean a path that laid a document out from a suggestion and
-- forgot to record it got `'authored'` silently -- which is the false
-- declaration this migration exists to prevent, reintroduced as a convenience.
--
-- Phase 165 proved this works: dropping the default made the compiler refuse
-- `uploadAsset` until it said where the file came from, before any test ran.

ALTER TABLE design_documents ALTER COLUMN provenance_origin DROP DEFAULT;
