-- Phase 100: counting the guessing at a guarded act.
--
-- A table of its own rather than a new `login_outcome` on `login_attempts`,
-- and the reason is that the shortcut looks safe and is not.
--
-- `lockoutState` counts every row in its window that is not 'success' and not
-- 'locked_out'. A 'wrong_reauth' row would be counted as a failed sign-in, so
-- five fumbles on the security page would lock the account out of signing in —
-- handing somebody who already has a session a way to lock the real owner out
-- of their own books. The guard would become a weapon.
--
-- The two are also keyed differently. `login_attempts` is keyed on an email
-- because at sign-in time that is all anybody knows; here the person is signed
-- in and the session says exactly who they are, so this is keyed on the user
-- and on the act. Two different questions.

CREATE TABLE "guard_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,

  /* Which guarded act was attempted. A `GuardedAct` from the register in
     `reauthentication.ts`, stored as text for the reason ADR 0033 gave for
     integrity check keys: the register is code, and a foreign key to a table
     of names pointing at functions is a foreign key to something that may not
     exist. */
  "act" text NOT NULL,

  "ok" boolean NOT NULL,

  /* Truncated the way `login_attempts` truncates it, so the two say the same
     thing about a person's whereabouts. */
  "ip_address" text,

  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- The query this table exists for: one person's recent attempts at one act,
-- newest first.
CREATE INDEX "guard_attempts_user_act_idx"
  ON "guard_attempts" ("user_id", "act", "created_at" DESC);
