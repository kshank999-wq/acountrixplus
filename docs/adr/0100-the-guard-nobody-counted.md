# 0100 — The guard nobody counted

**Status:** accepted
**Date:** Phase 100
**Amends:** ADR 0013 (login attempts and lockout), ADR 0099 (the guard), whose
"what the next phase might take" named this.

## The defect

Phase 99 made four acts ask for the password. It refuses a wrong one and does
nothing else: no record, no limit, and no word to the person whose account it
is. Its own ADR said so.

Meanwhile `login_attempts` has bounded the sign-in form at ten failures in
fifteen minutes since Phase 13, and shows them on a screen.

That is the wrong way round. Somebody typing into the sign-in form might be the
owner on a new laptop. Somebody typing into the *security page* already holds a
live session — which is a far stronger signal that something is wrong, not a
weaker one. The stronger signal was the one nobody counted.

## Decision 1: a table of its own, because the shortcut is a weapon

The obvious move is a `wrong_reauth` value on `login_outcome` and rows in
`login_attempts`. It is refused, and the reason is worth writing down because
the code makes it look safe.

`lockoutState` counts **every** row in its window that is not `success` and not
`locked_out`. A `wrong_reauth` row would therefore be counted as a failed
sign-in — so five fumbles on the security page would lock the account out of the
sign-in form. That hands somebody who already has a session, the exact person
this guard exists to stop, a way to lock the real owner out of their own books.

**A guard that locks the account is a weapon.** So a failed re-authentication
bounds the act it was for, for a cool-off, and touches signing in not at all. A
test asserts zero rows in `login_attempts` and `locked: false` after nine
failures.

The two are keyed differently as well. `login_attempts` is keyed on an email
because at sign-in time that is all anybody knows; here the person is signed in
and the session says exactly who they are, so this is keyed on the user and on
the act. Two different questions — and giving two different questions one table
is what would have produced the defect above.

## Decision 2: refused attempts are not recorded

If a blocked attempt were recorded, the oldest failure in the window would move
forward on every retry and the block would never lift. That is the bug
`lockoutState` avoids by excluding its own `locked_out` rows, met again from the
other direction, and it is worth naming because the fix looks like an omission.

The corollary is deliberate: once blocked, **the right password is refused too**.
A correct guess is still a guess, and a limit that opens for one is not a limit.

## Decision 3: each act is counted separately

Five wrong passwords at the address claim do not shut somebody out of changing
their password — which is exactly what the real owner would do next if the
warning was true. Counting per act keeps the remedy reachable while the thing
being attacked is closed.

## Decision 4: the owner is told once

A run of wrong passwords at somebody's own security page is the one signal only
they can act on. But the first is noise — people mistype — and one per failure
is a mailbox full of the same sentence, which is a mailbox nobody reads. So
`shouldWarn` is true on exactly the attempt that crosses the limit and false
above it.

The letter carries no link, on Phase 98's rule: a warning that a session may be
in the wrong hands must not also be a way to act on the account. It says what to
do instead — sign in, change the password, end the other sessions — and where
that is done.

## Decision 5: the mailer is injected, not imported

`guardAct` lives in `modules/auth` and the notify layer imports `users`, so
importing it back would close a circle. The caller passes `sendGuardWarning`;
one that has no mailer passes nothing and the letter is skipped. Better a guard
with no letter than no guard — and it also lets a test watch what would have
been sent.

## What this did not do

**The failures are not on a screen.** `recentFailuresForCompany` puts sign-in
failures on the security page and there is no equivalent here yet. The letter
reaches the one person who most needs it, which is the larger half.

**Nothing is swept.** `guard_attempts` grows and Phase 24's retention policy
does not know about it. It is bounded by how fast a human can type rather than
by anything an attacker controls remotely, so it grows slowly — but "slowly" is
not "never", and `login_attempts` was given a sweep for exactly this reason.

**The window is not configurable.** `securityPolicy` lets a company set its own
lockout threshold and minutes for signing in; these five and fifteen are fixed.
Whether a company should be able to loosen a guard on its own people's accounts
is a real question and not obviously yes.

## What the next phase might take

`guard_attempts` is the second table in this application that grows with every
request and has no retention rule, and the first one — `login_attempts` — got a
sweep in Phase 24 precisely because it grows with traffic an attacker controls.
The policy machinery, the worker schedule and the pruning shape all exist;
`pruneExpiredTokens` is twenty lines away from being the model. Whether the two
sweeps should be one job that knows about every such table, rather than a second
hand-written one, is the decision that phase would make.
