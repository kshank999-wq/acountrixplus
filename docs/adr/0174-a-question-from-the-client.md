# 0174 — A question from the client

**Status:** accepted
**Date:** 2026-10-06
**Phase:** 174

---

## The nomination held

ADR 0173 nominated **comments/questions on the client link** and **asset
association** as the two findings that are *"a table and a screen rather than an
engine"*. This is the first of them, and the nomination needed no correcting —
the second in a row, after five phases where every one did.

§7 asks the client-facing link for *"view tracking, acceptance/e-signature
integration, comments/questions, version history, and PDF download"*. Four of
the five existed. A client reading a proposal could accept it or find somebody's
email address, and the second option loses the question, because an email reply
lands on neither the proposal nor the client's timeline.

## A question is a communication, not a comment

The obvious shape is `proposal_comments`. Measured against what the thing *is*,
that is wrong twice over, and both costs are things this codebase built on
purpose in earlier phases.

A question from a client is **one exchange with somebody outside the company**,
which is exactly what `communications` holds — and that table's own docstring
makes the argument:

> A communication [...] is always with a *party* — an organization, one of its
> people, and optionally the deal being discussed — and those are three foreign
> keys the database can actually enforce.

Putting it anywhere else costs:

1. **The client timeline.** `organizationTimeline` merges communications, tasks
   and opportunity activity. A separate table is invisible there, so *"what has
   happened with these people"* would omit the one thing the client said.

2. **The attention list.** `lastContactedAt` reads non-internal communications
   and drives Phase 167's `gone-quiet` ground. A client who asked nine days ago
   and got no answer is **precisely** a neglected account — and with a separate
   table that account would read as *quiet* while the question sat on it. That is
   the worst direction for that list to be wrong in, and there is a test that
   asserts asking makes `gone-quiet` stop firing.

So asking is an **inbound** communication, answering is an **outbound** one, and
two columns go on the table: `proposal_id` and `parent_id`. Both are created as
**composite tenant keys** from the start, which is Phase 172's rule applied
forward rather than retrofitted: the reference count went 271 → 273 with the
composite count going 16 → 18, so the backlog did not grow.

`parent_id` is a reply pointer rather than a tree, because §7 asks for questions
and answers. Answering an answer is refused, and the test says why: a third
message would claim a depth the column cannot express and a reader would have no
way to order it.

## Where the client's name goes, and what it is not

`actor_name` — whose own comment is *"Frozen, so an exchange keeps its author
after they leave."* A name typed into a public form is a **claim**, not a proved
identity; `contact_id` beside it carries who the business believes it is talking
to.

The fallback when nobody types one is *"The client"* rather than the contact's
name. Writing the contact's name would assert that this particular person typed
the question, and a forwarded link cannot establish that.

## Five unauthenticated write paths, and nobody knew

This is the finding the phase did not set out to make.

`intake.ts` said *"this is the only unauthenticated write path in the system"*.
Its test said the same. The acceptance route said *"the second"*. This phase's
route said *"the third"*.

So I wrote `modules/tenancy/public-writes.ts` to stop keeping the count in prose,
declared the three everybody had mentioned — and **the scan written alongside it
immediately found two more**: the per-recipient unsubscribe link and the email
delivery webhook. Neither had been written down anywhere. The answer is five.

Four stale sentences across four files, none of them wrong in a way anything
could detect. That is Phase 110's defect and Phase 135's lesson arriving
together, and the fix is not a better sentence.

**The scan also got it wrong, in the right direction.** Its first version looked
for `requireActor|requireSession` and flagged both mobile routes, which read a
session through the non-throwing `currentActor`/`currentSession`. Two false
positives out of four — and over-reporting is how a detector like this should
fail, because a person resolves a false positive and nobody ever learns of a
false negative.

One entry is listed as deciding inline: the email webhook, whose credential
check *is* its HTTP envelope. Listed as the exception rather than tidied, so the
rule for the other four — the decision lives in a module tests can drive — can
be asserted rather than weakened to "most of them".

## What stands between a stranger and this write

Stated per entry in the register, and for this one:

- **The token is the credential.** 32 random bytes, and `newPublicToken` says
  why: *"the client link must not be guessable from another."*
- **A draft takes no questions**, and nothing is recorded when one is attempted.
  A question on a draft means the token leaked rather than that a client is
  asking, and recording it would put a stranger's text on a client's timeline.
- **One sentence for every refusal.** A token that names nothing and a proposal
  that may not take questions get the same message and, in the route, the same
  404. Two different answers would restore the oracle the random token exists to
  prevent.
- **A rate limit per proposal, not per address.** A client behind a corporate
  gateway shares an address with their colleagues, so a per-address limit would
  silence the second person at the same company to ask something. The thing
  worth limiting is one link used as a message queue.
- **No honeypot**, deliberately. `intake.ts` has one because a published form is
  crawled by bots that fill every field. A proposal link is not published and is
  not discoverable, so a honeypot here would be a control with nothing to catch
  — and Phase 160's lesson is that a control which cannot fire is worse than
  none, because the register says it is there.

## The one place the internal/external line must hold absolutely

`clientThread` is read by token and excludes internal notes, which is why it is
not `threadForProposal` with a different caller. `communications` keeps notes
*about* a client on the same timeline as exchanges *with* them — that is what
`lastContactedAt` excludes `internal` for — and the page the client is looking at
is where that distinction cannot be approximate.

It filters on direction **and** channel, and the test covers the case a
direction filter alone would catch and a proposal filter alone would not: an
internal `message` filed against the proposal itself.

## What this does not do

**No notification.** A question arriving should probably reach the proposal's
owner, and `modules/notify` exists. It is left out because the question already
appears on the client timeline, on the attention list, and on a panel on the
proposals screen — and adding a fourth surface before anybody has said the first
three are insufficient would be guessing.

**No e-signature integration**, which is the other half of §7's same bullet and
a vendor decision rather than a gap to fill.

**No asset association**, the second of ADR 0173's two nominations, deliberately
left for its own phase rather than bundled.

## What is nominated next

**Asset association** (§8): `assets` carries no reference to a campaign,
contact, organization or opportunity, so there is no answer to "what have we
sent this client". A table-and-a-screen phase like this one, and it should take
its references composite from the start for the same reason this one did.

Then **the full suite**. It reached 3,142 of ~4,200 on the attempt this phase
interrupted — the furthest yet — with **zero failures and five of the six
tree-wide scans already executed**, which is the specific evidence thirteen
phases of targeted runs could not give. The remaining quarter is still
unverified and the claim here is deliberately narrow.
