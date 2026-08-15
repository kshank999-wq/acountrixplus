# ADR 0013 — A stolen password is not enough

- **Status:** Accepted
- **Date:** 2026-08-15
- **Context:** Spec §14 (MFA, session/device controls, login history, revocation),
  §19 (encryption at rest, exportability, backups and a tested restore)
- **Builds on:** [ADR 0001](0001-modular-monolith-and-tenancy.md),
  [ADR 0008](0008-offline-first-and-replay-safety.md)

## Context

Every phase so far has been about what the product *does*. Spec §19 names a
security review as the gate in front of production use of "financial
integrations, payment features, payroll, tax filing, or automated financial
actions" — which is most of what Phases 8 through 12 built. This phase is the
part of that gate which is code rather than process.

What existed: tenant isolation on every query, an append-only audit log,
role-based permissions with granular overrides, and — from Phase 8, built for
the mobile app — device records and session revocation. What did not: any
second factor, any record of a failed sign-in, any way to get the data out, and
any evidence that a backup could be restored.

The claim this phase is built around: **a stolen password is not enough, and
every attempt to use one is on the record.**

## Decision 1: TOTP, written out rather than imported

Sixty lines of RFC 6238 against `node:crypto`, tested against the published
Appendix B vectors — the point of those vectors being that somebody else
computed them.

A dependency would have saved the sixty lines and added a dependency **in the
authentication path**, which is the worst place in this codebase for a
supply-chain problem. That trade is only defensible because the algorithm is
small, frozen, and has official test vectors. It would not be defensible for
password hashing or TLS.

Four details are load-bearing, and each is a way the sixty lines could be
quietly wrong:

- **Constant-time comparison.** A `===` on the code leaks, through timing, how
  many leading digits were right — turning 10⁶ guesses into about 60.
- **±1 step of drift, and no more.** Wider is the usual response to support
  tickets about phone clocks, and it multiplies the guessing surface.
- **A used code cannot be used again.** `lastUsedStep` is recorded and codes at
  or before it are refused. Without it a code stays valid for its whole window
  and a little beyond, so anybody who reads it over a shoulder — or captures it
  on a phishing page a second after the victim typed it — can sign in with it
  too. This is the one most implementations skip.
- **The counter is time ÷ 30, floored.** Off by one here works for the
  implementer and fails for everyone in a different second.

## Decision 2: enrolment is two steps

`beginEnrollment` stores the secret **unconfirmed**. `confirmEnrollment` turns
MFA on, and only after a code generated from that secret has been checked.

Enabling on generation is one fewer round trip and locks out everybody who
scanned the wrong QR code, mistyped the secret, or has a phone whose clock is
wrong — and they discover it at their next sign-in, from the outside, with no
way back in. The confirmation step is not ceremony: it is the only proof that
the thing which will be demanded tomorrow works today.

Recovery codes follow from the same reasoning. Ten single-use codes, shown once,
hashed with the same function as passwords, because that is exactly what they
are. An MFA implementation without them is one dropped phone away from a
support process consisting of switching MFA off for whoever asks, which is
worse than never having had it.

## Decision 3: the intermediate state is not a session

The shortcut is to create the session after the password and mark it "half
signed in", upgrading it when the code arrives. That puts a real session cookie
in the browser of somebody who has not finished authenticating, and every check
in the application then has to remember to ask whether this session is the
pretend kind. One place that forgets is a full sign-in with a password alone.

So there is no half-session. `challenge.ts` issues a signed assertion that
grants exactly one thing — the right to present a second factor — read by
exactly one function. It is bound to:

- **five minutes**, long enough to find a phone and short enough to be
  worthless in a browser history;
- **the password hash**, so changing the password kills every outstanding
  challenge, which is precisely what somebody who has just realised their
  password was stolen is trying to do.

It is deliberately **not** bound to an IP address. A phone switching from wifi
to cellular between the two steps would fail, and the people that hurts are the
ones doing everything right.

## Decision 4: the policy is enforced at `requireActor`

Every page and every server action already starts there. A policy checked
anywhere else has as many holes as there are routes that forgot it, and the one
that forgets is the one that matters.

`allowUnenrolled` exists for exactly two callers: the security page itself and
signing out. Without them, "require MFA" is not a requirement, it is a lockout.

**Opt-in MFA is adopted by the people who were never the risk**, which is why a
company-level `requireMfa` is what makes this a control rather than a feature.

## Decision 5: the lockout is on the address, and that is a trade

Locking an email address after N failures stops a password list being worked
through. It also hands anybody who knows an address a way to lock its owner out
— which is why the lock is temporary and short. A lock an administrator had to
lift would turn a nuisance into an outage.

Locking on IP fails the other way: an attacker has more addresses than a
business has offices, and the whole office shares one.

What fifteen minutes buys is arithmetic: ten attempts per quarter-hour is under
a thousand a day, against a six-digit code or any password worth the name.

Two smaller decisions:

- **Failures are counted since the last success**, so signing in correctly
  clears the count. A counter reset only by a timer means somebody who
  fat-fingers their password across a working day accumulates a lockout they
  did nothing to earn.
- **Outcomes are named, not boolean.** "Twelve wrong passwords for one address"
  and "twelve addresses that do not exist" are identical under a boolean and
  mean completely different things. `reused_mfa_code` is its own outcome
  because it means somebody else saw a code.

## Decision 6: a password change ends every other session

On its own, changing a password after a compromise achieves **nothing** —
sessions are not derived from the password, so the attacker stays signed in
while the victim congratulates themselves. So the sessions go with it, keeping
only the current one.

## Decision 7: the export is judged by whether the books could be rebuilt

Spec §19's exportability clause is what makes the product leaveable. An
accounting system whose books cannot be got out keeps its customers by trapping
their history rather than by being good.

So the test is not "does it produce a file" but "could an accountant rebuild
these books elsewhere from it", which forces three things: journal lines carry
their account **number and name** rather than ids; money is exported in units,
not cents; and it is CSV with real RFC 4180 quoting, because a customer called
`Smith, Jones & Co` silently shifts every following column otherwise.

## Decision 8: the restore is tested, not documented

Everybody has backups. The organisations that lose data are the ones whose
backups had never been restored. `scripts/verify-restore.sh` does the whole
round trip into a scratch database and compares row counts table by table, and
is meant to run on a schedule beside the backup itself. It reports **PASS — 93
tables and 656 rows restored identically** on this repository's own database.

`count(*)` per table, not the planner's estimate in `pg_class`: the estimate is
stale until `ANALYZE` runs and would happily report a successful restore of an
empty database.

## Two bugs the tests caught, both invisible in production

- **`NULL <> 'uuid'` is NULL, not true.** "Sign out everywhere else" deleted
  sessions with `deviceId <> current`, which silently spared every session
  having *no* device — every session created before Phase 8, and precisely the
  one an attacker would rather keep. Fixed with `IS DISTINCT FROM`. The failure
  leaves no trace: the button reports success and the attacker stays in.
- **A retry could lift its own lockout.** The row limit on the lockout query
  counted `locked_out` rows, so a burst of retries pushed the real failures out
  of the window and the count fell below the threshold. Fixed by excluding them
  in SQL rather than in the loop.

## Consequences

- **A development fallback exists for `ENCRYPTION_KEY` and `SESSION_SECRET`,
  and production refuses to start without them.** This was confirmed the hard
  way: the first browser run of the enrolment flow failed with *"ENCRYPTION_KEY
  must be set in production"*, which is the guard working.
- **Encryption at rest protects a database dump, not a compromised server.** A
  leaked backup or a misconfigured replica yields ciphertext and the key was
  never in it. An attacker running code on the server reads the key from the
  environment, and nothing at this layer could prevent that.
- **Recovery codes cost ten scrypt verifications per attempt.** Deliberate work
  on a path an attacker can drive, which the lockout is what bounds. The
  alternative — a searchable hash — would make the stored codes crackable in
  bulk.
- **There is no password reset by email.** MFA, lockout, and a password change
  are built; "I forgot my password" still needs the email provider wiring and a
  single-use token, and a half-built reset flow is a bypass for everything
  above it.
- **The lockout uses the defaults, not the company policy.** It runs before
  anybody has proved which company they belong to. The principled answer is the
  strictest policy across the user's companies, and it is not worth a second
  query on the unauthenticated path.
- **No WebAuthn or passkeys.** TOTP works with any authenticator app and no
  hardware; passkeys are phishing-resistant in a way TOTP is not, and are the
  obvious next step rather than a replacement.
- **Login attempts are never pruned.** The table grows with every failed
  sign-in on the internet, and an attacker controls that rate. A retention job
  belongs on the Phase 10 scheduler.
- **The export is built in memory and returned through a server action.** Fine
  for a small company and wrong for a large one; it needs the object store that
  §18 asks for and this repository does not have.

## Follow-up

1. **Prune `login_attempts` on a schedule**, since an attacker controls how
   fast it grows.
2. **Password reset by email**, with a single-use token — the one authentication
   path still missing.
3. **WebAuthn**, which is phishing-resistant where TOTP is not.
4. **Stream the export**, once there is somewhere to stream it to.
5. **Accountant practice mode** (§14, explicitly deferred by the spec itself):
   one accountant switching securely among client companies.
