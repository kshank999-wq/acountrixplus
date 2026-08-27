# ADR 0038 — Two adapters, or the interface is a guess

- **Status:** Accepted
- **Date:** 2026-08-27
- **Context:** Spec §19, §14. Phase 19 built the transactional channel, its
  message type, its rate limit and its mock. It never built anything that could
  put a letter on the internet.
- **Builds on:** [ADR 0019](0019-a-reset-is-not-marketing-and-an-invitation-carries-no-password.md),
  [ADR 0024](0024-nothing-grows-for-ever-and-nothing-waits-for-somebody-to-look.md),
  [ADR 0010](0010-at-least-once-and-who-decides.md)

## Context

`TransactionalProvider` has existed since Phase 19 with exactly one
implementation, and that implementation always succeeds. The consequence
surfaced in production this week: a deployment with real users had no way to
send a password reset, and the honest advice was *write the password down,
because losing it means editing the database.*

Everything downstream was already built and waiting. Failures are recorded in
`transactional_messages`. Phase 22 files them on the customer's timeline. Phase
24 surfaces them on `/settings/operations` and in the digest. The only missing
piece was something that could fail in the first place.

Four claims, asserted in `tests/notify-providers.test.ts` (20 tests) and
`tests/notify.test.ts`:

1. **Mail leaves over HTTP, not SMTP.**
2. **`retryable` means something**, and it is derived rather than guessed.
3. **Two adapters**, because one is a guess about what varies.
4. **A delivery failure does not change what the requester is told.**

## Decision 1: HTTP, and therefore no new dependency

The application runs on short-lived serverless invocations. SMTP is a stateful
conversation over a long-lived socket — EHLO, STARTTLS, AUTH, MAIL FROM, RCPT
TO, DATA — that wants a connection pool a function which may be frozen
mid-send does not have.

Every provider worth using offers a JSON endpoint. One request is what this
runtime is good at, and `fetch` is already in it. The dependency list stays at
nine.

## Decision 2: `retryable` is derived from the status

The field has been in the interface since Phase 19 and has never carried a
meaningful value, because the mock always succeeds. It is the only interesting
part of a failure, and the line is between *the provider could not take it just
now* and *the provider understood and said no*:

- **429, 408, 5xx** — transient. The message was never judged.
- **every other 4xx** — a bad key, a malformed address, an unverified sending
  domain. None of these improve by asking again, and retrying them is how a
  queue fills with mail that will never send.
- **a thrown `fetch`** — DNS, TLS, reset, or our own 10-second timeout.
  Transient by construction: nothing about the message was rejected, because
  nothing about the message was read.

Classification lives in `providers/http.ts` rather than in each vendor, because
the same mistake copied twice is the same mistake twice.

## Decision 3: two adapters, and Postmark is why

An interface with one implementation is a guess about what varies. Writing the
second one is what turns it into evidence, and Postmark disagreed with the
conventional shape in a way that would otherwise have been a production
incident:

> **Postmark can answer `200` and mean no.** A rejection — an inactive
> recipient, an unverified sender — arrives as HTTP 200 with a non-zero
> `ErrorCode` in the body.

Written against Resend alone, "2xx means sent" is correct and obvious. It would
have recorded rejected messages as delivered, on the one channel where a
message that did not arrive locks somebody out of their own books. The branch
exists because a second vendor was written, not because anybody predicted it.

Postmark also wants a header token rather than a bearer, capitalised body
fields, and a message stream — and sending transactional mail down a broadcast
stream is a deliverability mistake rather than an error, so nothing would have
complained.

## Decision 4: the failure is not a second enumeration channel

`/forgot` says the same sentence whether the address exists, does not exist, or
exists and bounced. Now that mail can genuinely fail, the temptation is to be
helpful — *we could not send to that address* — which also confirms the address
has an account.

The requester learns nothing. The operator learns everything, through the
machinery Phase 24 already built. This is the same split ADR 0024 made for a
different failure, and it is the reason that phase's work was worth doing
before this one.

## Decision 5: a missing key throws at construction

Providers are built on demand and validate their configuration in the
constructor, so a deployment naming `postmark` with no token fails when it is
selected rather than the first time somebody is locked out.

Built lazily rather than registered eagerly, which is where this departs from
the bank registry: instantiating every adapter at import would fail a
Postmark deployment for want of a Resend key it does not use.

## The bug the tests caught

`TRANSACTIONAL_EMAIL_PROVIDER=""` is not unset. `?? 'mock'` does not fire on an
empty string, so a blank variable — which every hosting panel lets you save —
resolved to a provider named `""` and threw on every send, with an error about
an unknown provider rather than doing the obvious thing. It is `|| 'mock'` now.

## The bug browser verification caught

Worse, and invisible to every test that existed.

Running the real adapter against an unreachable provider, the reset was
correctly recorded as failed with the provider's own words — and then did not
appear on `/settings/operations`, where this ADR and the deploy guide both said
it would.

`failedDeliveries` filters on `company_id = $1`. **A password reset has no
company**: it is a pre-authentication act, the requester is not signed in, and
nothing has chosen a tenant. So the row was written with `company_id = NULL`,
`= $1` never matches NULL, and every failed reset was invisible to every
operator on every company.

The one letter whose loss locks somebody out of their own books was the one
nobody could be told about. It had been latent since Phase 19 and could not
surface until this phase, because until this phase the only provider always
succeeded.

The reset is now attributed to the recipient's oldest company membership. That
leaks nothing — the operator can already see that address on the member list —
and it is deliberately *not* the other available fix, showing tenant-less rows
to everybody, which is what Phase 10 chose for dead jobs. A dead job carries no
personal data. A bounced reset carries an email address, and publishing "this
address asked for a reset" to every tenant would be a worse bug than the one
being fixed.

## Consequences

- **Nothing retries yet.** `retryable` is now correct and nothing acts on it.
  Wiring it to Phase 10's queue is the obvious next step and was deliberately
  not taken here, because retrying a password reset means persisting a rendered
  message containing a live link — undoing the reason the token is hashed at
  rest. That is a decision, not an oversight, and it wants its own phase.
- **A bounce is recorded, not learned from.** A permanently failing address
  stays in the contact record. Phase 5 has a suppression list; transactional
  mail deliberately does not consult it, and nothing writes back to it either.
- **No webhook.** Providers report asynchronous bounces by callback; this only
  knows what the send request said. A message accepted and then rejected an
  hour later is recorded as sent.
- **Two vendors is not every vendor.** SES, Mailgun and SendGrid each want
  another adapter. The seam is now proven, which is the point — the next one is
  a file, not a redesign.
- **The sending domain must be verified**, and that failure is permanent. The
  deploy guide says so because the error is one people otherwise retry.
- **A reset for somebody in no company is still invisible.** The attribution
  above needs a membership, and registration always creates one, so this is a
  state the application does not currently produce — but nothing enforces that.
- **The answer is constant; the latency is not.** `/forgot` returns in about
  90 ms for an address with no account and about 750 ms for one that exists,
  because the send is attempted inline. The wording no longer distinguishes
  them and the timing does, which is a weaker oracle than the one that was
  closed but not nothing. Sending off the request path would fix it, and is the
  same work as the retry follow-up below.

## Follow-up

1. **Retry the retryable**, through Phase 10's queue, once the live-link
   problem above has an answer — most likely re-minting the token on retry and
   accepting that the first link dies.
2. **Consume provider webhooks**, so an asynchronous bounce updates the message
   it belongs to.
3. **Feed hard bounces into suppression**, so the tenth invitation to a
   mistyped address is not sent.
4. **A send-test button** in operations, so configuration is verified from a
   screen rather than by asking for a password reset.
