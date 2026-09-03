# 0099 — The acts that move the way back in

**Status:** accepted
**Date:** Phase 99
**Amends:** ADR 0013 (MFA and the security settings), ADR 0098 (the address
claim), whose own "what this did not do" named this gap.

## The defect

`disableMfa` has asked for the current password since Phase 13, and said why:

> an unattended browser is the exact situation MFA is protecting against, and
> "switch off the protection" is the first thing somebody sitting at one would
> do.

`changePassword` asks too. Two acts beside them do not, and both move a route
back into an account.

**`regenerateRecoveryCodes`** has been unguarded since Phase 13 — the same phase
that wrote the argument two functions above it. Recovery codes are a way in.
Regenerating them destroys the ones the owner wrote down and hands ten fresh
ones to whoever is at the screen: the situation `disableMfa` refuses, with a
better prize.

**`requestAddressChange`** has been unguarded since Phase 98 — this codebase's
own previous phase — and ADR 0098 wrote the gap down rather than closing it:
*"Somebody who walks up to an unlocked session can start a claim."*

That is the shape worth noticing. The reasoning existed, in a docstring, in this
repository, and two later acts were written without it. A rule that lives in one
function's comment is a rule the next function does not inherit.

## Decision 1: the rule, said once and said narrowly

> **An act that changes how you get back in must prove you are still there.**

Not "acts on the security page", which is where this would have landed if the
question were asked by looking at the screen rather than at what the acts do.
Two things on that page deliberately do **not** qualify:

- **Exporting the company's data** is a read. It changes nothing about access,
  and guarding it would train people to type their password for the ordinary —
  which is how a password prompt stops being a signal.
- **Ending another device's session** *removes* access rather than granting it.
  Somebody who wants to lock a stranger out of their books should not be slowed
  down at the moment they are trying to.

What qualifies is narrow: the password, the second factor, the recovery codes,
and the address recovery is sent to. Between them they are every route back in
this application has.

## Decision 2: each act argues for itself

`ACTS` gives every entry a sentence of prose saying why it needs the guard,
rather than a boolean. That is Phase 70's `Reach` device applied again, for the
reason Phase 70 gave: *so the next one somebody adds has to answer the question
that matters rather than copy a flag from the row above it.*

It is not a hypothetical. A boolean would have let `address.claim` be added with
`false` and no argument, which is approximately what happened in Phase 98.

## Decision 3: one refusal, and it says nothing extra

`disableMfa` said *"That password is not right."*; `changePassword` said *"That
is not your current password."* Two sentences for one event, on one screen —
the defect this codebase keeps removing. There is one now:

> That is not your password. Nothing has changed.

The same sentence for a blank box, a wrong password, and an account that somehow
has none. Three different answers would tell somebody holding a borrowed session
which of those they were up against.

The guard also runs **before** anything else in `requestAddressChange`, ahead of
`claimCheck`. Refusing with *"that is already the address you sign in with"*
before asking for the password would answer a question on behalf of whoever is
holding the session — it confirms the account's current address to somebody who
has not proved they are its owner.

## Decision 4: the wrong password sends no letter

Phase 98's claim sends two letters, one of them to the address being left. If
the guard ran after the letters, a wrong password would still have posted mail —
turning a password-guessing attempt into a way to send mail at somebody. A test
asserts zero rows in `transactional_messages` after a refused claim.

## What this did not do

**It does not re-ask within a session.** Type the password once per act, every
time. A "recently authenticated" window is the usual next step and is a real
design question — how long, refreshed by what, and what happens when the window
is open on a machine somebody walked away from — that deserves its own decision
rather than a number picked here.

**It does not guard company-level settings.** Requiring a second factor of
everybody, changing the retention policy: these change what *other people* must
do rather than how the person at the keyboard gets back in. They may deserve a
guard, but not this one's argument.

**Redeeming an address claim still needs only the link.** The token went to an
inbox the claimant proved they hold, and the page is behind the session. Asking
for the password twice for one act is the training-people-to-type-it problem
again.

## What the next phase might take

Every refusal here is silent to everybody but the person typing. Somebody
guessing at an unattended laptop can try the password on four acts as often as
they like and nothing is recorded, nothing is rate limited, and the account's
owner is never told — while `login_attempts` has counted exactly this since
Phase 13 for the sign-in form one page away. The machinery exists; these four
acts are not wired to it.
