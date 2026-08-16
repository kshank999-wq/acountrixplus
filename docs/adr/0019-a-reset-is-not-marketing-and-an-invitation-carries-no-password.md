# ADR 0019 — A reset is not marketing, and an invitation carries no password

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §19 (email delivery, security), §14 ("invite each
  professional using an individual account; never share owner credentials")
- **Builds on:** [ADR 0005](0005-marketing-consent-and-engagement.md),
  [ADR 0013](0013-a-stolen-password-is-not-enough.md),
  [ADR 0018](0018-access-is-granted-never-claimed.md)

## Context

Two things had been deferred with an explicit reason, and both reasons had
expired.

**Password reset.** Phase 13's note read: *"a half-built reset flow is a bypass
for everything above it, so it is absent rather than approximate."* Everything
above it now means a password, a second factor, device sessions and lockout —
four mechanisms a reset flow has to fit under rather than around.

**Invitations.** Phase 18 shipped `addPracticeMember`, and the screen that drove
it asked an owner to type a colleague's first password and then tell them what
it was. That is §14's "never share owner credentials" in a subtler form: the
credential existed before its owner did, at least two people knew it, and
whichever of them changed it afterwards, the audit log could not say which of
them had done anything in between.

Both need one thing the application did not have: a way to send a letter that
must arrive.

## Part one: the channel

### Decision 1: transactional mail is a separate channel, and the type enforces it

Phase 5's marketing pipeline does two things before a message reaches a
provider: it checks consent, and it checks the suppression list. Both are
correct for a campaign and catastrophic for a password reset. Somebody who
unsubscribed from the newsletter in March must still be able to get back into
their own books in August.

So `TransactionalMessage` is a distinct type sent through a distinct provider
interface — and the distinction is carried by the type rather than by a comment.
`OutboundMessage` **requires** `unsubscribeUrl` and `unsubscribePostUrl`; a
`TransactionalMessage` has no field to put them in.

You cannot accidentally attach an unsubscribe link to a password reset, which
would be an offer to stop sending somebody the only mail that can let them in.
And the abuse regulators actually care about is blocked in the same stroke:
nothing marketing-shaped can be pushed down this pipe to dodge an unsubscribe,
because a `TransactionalMessage` carries no campaign, no segment, and no
recipient row to attribute engagement to.

The alternative — one sender with a `skipSuppression: true` flag — is one
argument away from a disaster in either direction, and the flag is exactly the
kind of thing that gets copied into a new call site by somebody who wanted the
rest of the options.

The tables are separate for the same reason. `transactional_messages` is not
`campaign_events`: mixing them would let a marketing report count password
resets as engagement, and would let a suppression sweep over "all mail to this
address" catch the letters that must always get through.

### Decision 2: a failed delivery here is not a suppression

When a campaign bounces, the right response is to stop mailing that address.
When a password reset bounces, the right response is that somebody is locked
out of their books and nobody has noticed. `failedDeliveries` surfaces them
rather than acting on them.

### Decision 3: the sender is the application, never the company's brand

Everything else in this product is brandable — proposals, invoices, campaigns,
the Company Studio exists for it. Transactional mail deliberately is not. A
password reset that arrives looking like it came from Ridgeline Construction is
one a person cannot distinguish from a phishing attempt made by somebody who
knows where they work.

### Decision 4: an unconfigured provider is an error, not a fallback

`getTransactionalProvider()` throws when `TRANSACTIONAL_EMAIL_PROVIDER` names an
adapter nothing registered. A deployment that believes it configured a real
sender and is in fact dropping every password reset into a process-local array
is the kind of thing discovered by a support ticket six weeks later.

In development the mock prints each letter, with its link, to the terminal.
Without that, a developer who clicks "forgot my password" on their own dev
server has genuinely locked themselves out: the link exists, is hashed at rest,
and nothing anywhere can show it to them.

## Part two: the links

### Decision 5: one token mechanism for three jobs

Password reset, company invitation and practice invitation are the same
sentence — *whoever can read this address may do this one thing, once, soon* —
so they are one table with three purposes rather than three tables that drift.

Three properties, each closing a specific failure:

- **Hashed at rest.** A reset token is a password for the hour it lives. A
  database backup or a leaked query log yields hashes, the same as Phase 1
  decided for passwords and Phase 13 for recovery codes.
- **Single use**, and the precondition lives in the write:
  `WHERE redeemed_at IS NULL ... RETURNING`, claim-count checked. This is the
  same shape as Phase 15's billed-once clause and Phase 16's depreciation index.
  A read-then-write here would let a forwarded invitation create two accounts.
- **Short-lived**, and shorter for a reset (an hour) than an invitation (a
  week). A reset answers a request somebody made a minute ago; an invitation may
  sit in an inbox over a weekend.

An eight-character prefix is stored in the clear so a lookup finds one row. The
Phase 13 approach — verify the candidate list one at a time — is right for ten
recovery codes belonging to one known user and hopeless for every live token in
the system.

Redemption happens **inside** the transaction that does the work, so a failure
downstream leaves the link usable rather than burning somebody's only chance.

### Decision 6: issuing supersedes

Asking for a reset three times leaves one working link, not three. The two
nobody used are two extra chances for whoever else can read that mailbox.

### Decision 7: the shape of a token is a database constraint

`action_tokens_purpose_shape` requires a company invitation to name a company, a
practice invitation to name a practice, and a password reset to name a user.
Three optional columns and a comment would have been the same design with none
of the enforcement — and this constraint caught two of this phase's own tests
issuing reset tokens attached to nobody.

## Part three: reset

### Decision 8: the response is identical whether or not the address exists

A form that reports "no account with that email" is a way to find out who banks
here, one address at a time. Even a rate-limit refusal is swallowed: "you have
asked five times already" tells an attacker their guess was a real address.

### Decision 9: a reset is not an MFA bypass and not a lockout bypass

Resetting does not touch enrolment. A stolen mailbox gets you a password, and a
password alone has not been enough since ADR 0013. The letter says so plainly,
because somebody with a second factor turned on should not be frightened into
thinking a reset request has walked past it.

Lockout is a consequence rather than a target: the reason for the lockout —
repeated wrong passwords — no longer applies once the password is different, and
the login history keeps every attempt either way.

### Decision 10: completing a reset ends every session

The usual reason somebody resets a password is that they think another person
has it. Leaving that person's session alive would make the whole ceremony
decorative. Every other live reset link dies too.

### Decision 11: the address is re-checked against the user's current one

A token issued to an address somebody has since changed away from stops working.
Otherwise changing your email leaves the old inbox holding a live key.

### Decision 12: it is audited into every company the person belongs to

There is no single "their" company for somebody who works at four, and a
password reset is exactly the event each of those four is entitled to see.

## Part four: invitations

### Decision 13: nothing exists until they accept

An invitation creates no user and grants no membership. Both happen in the
transaction that redeems the token. A mistyped address therefore hands a
stranger *nothing* — rather than handing them a working password to somebody
else's books, which is what the Phase 18 form did.

`addMember` and `addPracticeMember` survive for programmatic use — the seed and
the tests need them — but no screen calls them any more.

### Decision 14: an existing account is not asked for a password

Somebody who already has an account and is accepting a second invitation is
already themselves. Asking for their password on a page they reached from an
email is the exact shape of the thing everybody is told never to do, and doing
it in our own product teaches the habit that gets them phished elsewhere.

### Decision 15: accepting signs you in

Somebody who has just proved they own the address and chosen a password should
not then be shown a login form. Making them retype the password they set ten
seconds ago teaches them nothing except that the software does not trust its own
flow.

### Decision 16: a practice invitee arrives able to work

Accepting a practice invitation grants membership at every client the firm
already serves, through the *same* `grantAtLiveEngagements` helper
`addPracticeMember` uses. Two implementations of "which clients does a new
colleague reach" is how the invited route and the added-by-hand route come to
disagree, and the disagreement would be somebody quietly retaining access.

### Decision 17: an invitation to somebody already inside says so

Rather than sending a letter nobody expects, or silently doing nothing and
leaving the sender to wonder why no email arrived.

## Consequences

- **The only adapter is the mock.** Every letter goes to a process-local array
  and, in development, to the terminal. The seam is one interface and one
  variable, but nothing has been sent over SMTP or through a real provider, so
  none of the delivery problems — DKIM, bounces, complaint feedback loops,
  suppression at the provider — have been met yet.
- **Rate limiting is per address per kind per hour**, counted from the messages
  table. It bounds using this application as a way to post mail to a stranger,
  but a distributed attempt across many addresses is not bounded at all, and
  there is no per-IP limit on the request form.
- **Bounces are recorded, not surfaced.** `failedDeliveries` exists and no
  screen calls it. Nobody is told when an invitation to a mistyped address never
  arrives.
- **No email verification for a self-registered owner.** Somebody registering a
  company still proves nothing about their address; only invitees and resetters
  do. The mechanism to fix it is now sitting here.
- **No change-of-address flow.** Reset re-checks the current address, which
  means the machinery is ready, but changing your email is still a direct write
  with no confirmation to either address.
- **Tokens are pruned on demand, never on a schedule.** `pruneExpiredTokens`
  exists; the Phase 10 job queue is right there; nothing schedules it. The table
  grows with every request from the internet and an attacker sets the rate.
- **An invitation cannot be resent** without withdrawing and re-inviting, which
  issues a new token and silently kills the old link.
- **No expiry sweep in the interface.** A pending invitation disappears from the
  list when it expires rather than being shown as expired, so an owner watching
  for somebody to accept sees the row vanish with no explanation.
- **`text-success` and `text-danger` generated no CSS.** Nine screens across
  Phases 12–18 had been rendering their error and confirmation messages in body
  ink. Found while building this phase's pages, and fixed by naming the aliases
  in the Tailwind theme rather than renaming forty-six call sites to words that
  do not fit. It is the same class of defect as Phase 17's `text-${tone}`: the
  compiler cannot see a colour that was never defined, and neither could we.

## Follow-up

1. **A real provider adapter** — SMTP or an API sender — with bounce and
   complaint handling that feeds `transactional_messages` rather than the
   marketing suppression list.
2. **Surface failed deliveries** on the access screen, so a bounced invitation
   is visible to the person who sent it.
3. **Verify a self-registered owner's address**, using the machinery this phase
   built.
4. **Confirm a change of email** to both the old address and the new one.
5. **Schedule `pruneExpiredTokens`** on the Phase 10 queue.
6. **Per-IP rate limiting** on the request form, in front of the per-address
   limit that exists.
