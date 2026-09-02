# 0088 — The digest that reaches the one person who cannot act

**Status:** accepted
**Date:** Phase 88
**Amends:** ADR 0024 (the failure digest), ADR 0018 (practice mode), ADR 0087 (the triage ladder).

## The defect

Phase 24 built a daily digest that tells somebody when background work has given
up or a letter has bounced. Its recipients are the memberships holding
`company:manage` — and in the permission matrix that belongs to **`owner`
alone**. A practice engagement grants `accountant` by default and is capped by
the client, never above it.

So the digest goes to the client's owner and never to the firm. The bookkeeper
engaged to keep those books — the person who would actually retry the dead job,
clean the bounced list, or find out why a check stopped agreeing — is told
nothing at all. **The person who is told is the one least equipped to act on
it.**

Phases 84 to 87 built the ability to notice these things and to rank them across
a whole roster. The one channel that reaches out to a person still reaches only
the person who cannot use it.

## Decision 1: one brief a firm, not one per client

The obvious fix is worse than the defect. Adding practice members to the
per-company digest means a firm with forty clients is woken forty times every
morning — precisely the noise failure ADR 0024 exists to prevent, multiplied by
the roster.

So the brief is the firm's. One letter a day, naming the clients that changed.

## Decision 2: news, not state

Phase 87 can already say what most needs somebody at every client. Sending that
every morning would be a message that says the same thing every day, and a daily
message that never changes is a daily message nobody reads — the same failure
ADR 0024 named, by a slower route.

A client appears only when its rung is **worse than the last one observed**. A
client broken yesterday and broken today is not news; the firm already knows and
the roster is there when they want to look. A client that slid from `waiting` to
`stuck` to `wrong` over three days is news on each of the three, because each
step is a thing that changed.

That is Phase 33's `newlyBroken` — *"sent the night a difference appears, and not
again while it is still there"* — generalised from one company's checks to a
firm's whole roster, and it reuses Phase 87's ladder rather than inventing a
second ordering.

**The memory records every client's rung, including the ones nothing was said
about.** A memory holding only bad news cannot tell a relapse from a standing
problem: a client that recovers and breaks again would look, on the third
morning, exactly like one that had been broken all along. The browser check
walked all four nights — two clients newly in trouble, a silent night, a silent
recovery, and a relapse that spoke again — and the fourth only works because of
the third.

## Decision 3: mail, not the push topic

Phase 24's digest goes through Phase 8's push channel, and a push subscription is
keyed on `(company, user)`. An accountant has one per client, so that route would
deliver a firm's brief once per client — the forty messages this phase exists to
avoid, arriving by the back door.

The better reason is that **a roster does not fit in a push notification**. A
per-company digest is one sentence and belongs on a phone; a firm's morning list
is a list, and belongs in an inbox. Phase 19's mail channel takes a nullable
`companyId`, which is exactly the shape a firm-wide letter needs — and the letter
is filed against **no company at all**, because saying it was about one of them
would put a letter about twelve clients on one client's record.

This also closes half of a caveat standing since Phase 24: *"the failure digest
reaches phones, not inboxes… Phase 19's mail channel is right there, unused for
this."* It is used for this now. The per-company digest is still push-only.

## Decision 4: the job has no tenant

A practice is not a company. Every other scheduled job here belongs to one
company or is housekeeping across all of them; this belongs to a **firm**, which
is a third kind of owner.

It is registered `global: true` for the reason the worker schema already gives
for housekeeping: *pretending it belongs to one of them would be a lie that
`scoped()` would then enforce.* It fans out over practices itself, and every
client set it reads comes from `practiceWorkQueue`, which derives that set inside
itself and has no parameter that can widen it.

## What this did not do

**The brief is the firm's, not each person's.** The roster is read once, through
the first member, and the same letter goes to everybody who works there. Under
`assigned_only` staffing two members legitimately see different clients, so a
strictly correct version would read the roster per person — and repeat a
five-query-per-client scan for every member of the firm. This is a real
simplification, recorded here rather than hidden in the handler, and it is the
first thing to revisit if a firm complains about hearing on a client they are
not on.

It does not act, and it does not enter anybody's books. Every line is a count and
a sentence, and the accountant is in nobody's ledger until they follow the link.

And it does not tell the client that their accountant was told. That is
defensible — the firm has access to those books by an engagement the client
agreed to — but it is a decision rather than an oversight.

## What the next phase might take

Nothing in the brief can be switched off. Phase 8 gave every notification topic a
per-person subscription and a settings screen precisely because a channel nobody
can quiet is a channel that gets filtered to a folder — and this new one arrives
with no topic, no preference, and no way for a member of a firm to say "not me"
short of leaving. The machinery exists; the brief simply does not use it, which
is the shape of defect this project keeps finding one phase after it is
introduced.
