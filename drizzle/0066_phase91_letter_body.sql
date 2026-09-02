-- Phase 91: the letter keeps its own words, and the decision points at it.
--
-- `sendTransactional` rendered a letter's text, handed it to the provider and
-- recorded only the subject. Phase 90 then told a person, on their own roster,
-- that a letter had been sent — leaving the obvious next question, "what did it
-- say", with no answer anywhere.
--
-- The body stored here is not the rendered text. `notify/keeping` strips the
-- action URL first, because that URL is a capability in every kind this
-- application sends — a reset token, a join token, a signed document link — and
-- a 365-day delivery log is not a place to keep live credentials.

ALTER TABLE "transactional_messages"
  ADD COLUMN IF NOT EXISTS "body" text;

-- The join Phase 90 left unmade: the log row records the decision, this names
-- the letter that decision produced. Null for a suppression, which has no
-- letter by construction, and for every push row.
--
-- ON DELETE SET NULL rather than CASCADE: retention sweeps
-- `transactional_messages` at a year and `notification_log` on its own
-- schedule, and a swept letter must not take the record of the decision with
-- it. "We told you, and the letter has since expired" is a true answer; the
-- row vanishing is not.
ALTER TABLE "notification_log"
  ADD COLUMN IF NOT EXISTS "message_id" uuid
  REFERENCES "transactional_messages"("id") ON DELETE SET NULL;
