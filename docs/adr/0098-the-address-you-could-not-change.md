# 0098 — The address you could not change

**Status:** accepted
**Date:** Phase 98
**Amends:** ADR 0019 (single-use action tokens and password reset). Corrects two
README caveats.

## The defect

The README has said since Phase 19:

> **No confirmed change of email.** Reset re-checks the current address, so the
> machinery is ready, but changing your email is still a direct write with no
> confirmation to either address.

There is no direct write. The only `update(users)` in the application sets
`passwordHash`. Nothing has ever changed `users.email`, so **nobody has ever
been able to change their sign-in address at all** — and a person who mistypes at
registration, leaves the company whose domain it is on, or changes their name is
holding an account whose only route back in, password reset, sends to an address
that no longer reaches them.

The caveat is corrected rather than quietly deleted, on Phase 91 and Phase 97's
reasoning: it would have sent somebody looking for a write to secure.

**A second caveat was also stale.** *"Bounced transactional mail is recorded, not
surfaced — `failedDeliveries` exists and no screen calls it"* was fixed by Phase
24; `health.ts` quotes that very sentence as the thing it was written to fix, and
both the digest and the operations page have called it ever since. A caveats list
nobody prunes stops being a list of what is missing and becomes a list of what
somebody once believed. Both are struck through with a note.

## Decision 1: an address is not yours until you prove it

The change is a **claim**, not a write. Nothing moves until somebody opens the
letter sent to the address being taken. Until then the old address still signs
in, still receives resets, still works.

That last part is not a detail. A half-finished change must not be able to lock
anybody out, and the person most likely to abandon one halfway is exactly the
person who mistyped the new address and never received the letter.

## Decision 2: the address being left is told, and told without a link

This is the decision the phase turns on, and it is easy to get wrong by sending
one letter instead of two.

Moving the recovery address is the first move in taking an account over.
Somebody with a session — a borrowed laptop, a shared machine, a stolen cookie —
can point recovery at an address they own, and from then on the real owner is
locked out of their own books. A confirmation sent only to the new address is a
letter sent only to the attacker.

So two letters go: the **confirmation**, to the address being claimed, carrying
the link; and the **notice**, to the address being left, carrying none. The
notice is a warning, not a second way to finish the job — a link in it would let
whoever holds the old address complete a change they never asked for, which is
the same defect wearing the other coat.

`lettersFor` returns both as a pair rather than offering two functions, because
the property that matters is a property of the pair, and a rule split across two
functions is one somebody can later satisfy half of. `ChangeLetter.url` is typed
nullable and the service builds `action` from it, so the rule is enforced by the
shape of the data rather than by a function remembering it.

When the change completes, the old address is told **again**. That second letter
is the one that matters to somebody who was not watching their inbox an hour
ago, and it carries no link for the same reason the first did not.

## Decision 3: it says the same thing whether or not the address is taken

`requestPasswordReset` settled this — *"sends a letter if the address belongs to
somebody, and says exactly the same thing either way"*. A claim on an address
somebody else holds is accepted and quietly does nothing. Answering differently
would make this the one screen in the application that confirms whether an
account exists.

## Decision 4: sessions are not ended

The opposite of `completePasswordReset`, and worth stating because the
difference is the reasoning.

A reset ends every other session because the reason somebody resets is often
that another person knows the password. Nothing here suggests the password is
known; what changed is where recovery goes. Ending sessions would sign out the
real owner — who, if this claim was somebody else's work, no longer has the
address the new links go to, and would be locked out by the very act meant to
protect them.

## What the work caught

**A second constant that had to agree with another.** A `CLAIM_TTL_MINUTES` of
60 would have had to match `TOKEN_TTL_MINUTES` for ever. `lettersFor` is handed
the number instead.

**Letters that said "to this one" and "from this address."** Several addresses
aliased into one inbox is ordinary, and that phrasing is useless in a letter
whose entire purpose is proving control of a *particular* address. Caught by a
test asserting both letters name both addresses; the letters were fixed rather
than the test weakened.

**A test that passed for the wrong reason.** The first draft read the letters out
of `transactional_messages` and asserted the notice carried no link. It did —
and so did the confirmation, because Phase 91's `keptBodyFor` strips the link
from *every* stored letter. The assertion was vacuous. The tests now read what
the provider was actually handed.

**Two tripwires fired**, both as designed: Phase 93's `KIND_CONCERNS` and the
hourly rate-limit table are exhaustive `Record<TransactionalKind, …>` maps, so a
new kind cannot be added without answering both questions.

## What this did not do

**No re-authentication before claiming.** Somebody who walks up to an unlocked
session can start a claim. What stops it mattering is the notice to the old
address, not a password prompt — but asking for the password again would be
cheap and is the obvious next guard.

**The two remaining inline copies of `trim().toLowerCase()`** in `onboarding.ts`
are left alone. `normaliseLogin` names the rule and the reset path and this one
use it; refactoring registration in a phase about something else would be the
wrong place to do it.

## What the next phase might take

A claim can be started by anyone holding a live session, and the only thing
standing between that and a stolen account is a letter the real owner has to
read in time. Asking for the current password before issuing the claim would
close it, and this application already knows how to check one — `mfa.ts` and
`completePasswordReset` both do. Whether re-authentication belongs on this act
alone or on every act in the security settings is the question that phase would
have to answer first.
