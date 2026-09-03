-- Phase 98: changing the address you sign in with.
--
-- A fourth token purpose rather than a table of its own. `action_tokens`
-- already carries everything a claim needs: who asked (`user_id`), what they
-- asked for (`email` — here the address being *claimed*, not one already
-- proved), when it stops working, and whether it has been spent or superseded.
--
-- Reusing it also means the Phase 24 sweep that prunes expired tokens picks
-- these up with no further thought, and the single-use guarantee that Phase 19
-- built once applies here without being rebuilt.

ALTER TYPE "action_token_purpose" ADD VALUE IF NOT EXISTS 'email_change';
