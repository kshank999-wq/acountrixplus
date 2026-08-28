# ADR 0046 — The payment nobody came back from

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §19, §21. Phase 44 settled a card payment when the
  customer's browser came back. It is the least reliable moment in the flow,
  and nothing found the payments where it did not happen.
- **Builds on:** [ADR 0044](0044-the-money-is-not-at-the-bank-yet.md),
  [ADR 0033](0033-books-that-check-themselves.md),
  [ADR 0043](0043-a-business-that-has-to-remember-to-chase-does-not-chase.md)

## Context

A customer opens the payment page, types their card, and the processor takes
the money. Then their phone loses signal in a tunnel, or they close the tab, or
the redirect fails. The browser never comes back.

Phase 44 settled a checkout **only** on that return trip. So when it does not
happen:

- the checkout stays `pending` and nothing posts;
- the invoice still says the money is owed;
- Phase 43 chases the customer, by email, for an invoice they have paid.

That last one is the worst thing this system can do to somebody, and it happens
on its own schedule, daily, until a person notices.

## The correction this ADR makes to ADR 0044

ADR 0044 introduced the `payments.in_transit` integrity check and said it would
catch, among other things, *"a payment the customer made that never reached
these books"*.

**It could not.** The one failure it was written for was the one it was blind
to, and the reason is worth stating rather than quietly fixing.

The check compared what the processor is holding against `1250 Payments in
Transit`. But "what the processor is holding" was computed by `heldByProcessor`,
which counts checkouts we have marked `succeeded`. A checkout stranded in
`pending` contributes **zero to both sides**: nothing on the processor side
because we never marked it succeeded, nothing on the ledger side because
nothing posted. Zero equals zero, and the check reported agreement while a
customer's money sat at the processor unrecorded.

A check that can only see the failures it has already noticed is not a check.
This was proved with a test that passed before the fix existed, which is what
made it worth a phase.

## Decision 1: ask the processor, on a schedule

`payments.sweep_checkouts` runs **hourly** and asks the processor about every
checkout still pending. Hourly rather than daily because everything else on
this schedule is money the business is *waiting for*; this is money the
business already **has** and does not know about, and every hour of not knowing
is an hour in which the chase job can ask a customer for it again.

The decision is a pure function, `sweepDecision`, with no database and no
clock. The order in it is the substance:

1. `succeeded` → **settle**, even a checkout we had already written off as
   expired. The processor holds the money; its answer beats our guess.
2. `failed` → **mark failed**, and stop asking.
3. `unknown` → **investigate**. Never resolved automatically, in either
   direction.
4. `pending`, past its window → **expire**. Nothing was taken.
5. `pending`, still in its window → **wait**.

## Decision 2: an unknown is never an abandonment

The costly wrong answer here is not leaving a payment unsettled for an hour —
that is a delay. It is **calling an unknown an abandonment**.

If the processor is having an outage, or the credentials are wrong, or the
checkout was created against a different account, expiring it writes off a
customer's money in silence and no later answer reopens it. So `unknown` is a
first-class status on `ProviderPaymentStatus`, distinct from `failed`, and the
sweep hands it to a person. That is the only correct destination for "we do not
know whether we have been paid".

`needsAttention` is true for exactly this and nothing else. A recovered payment
is the sweep working; an expired one is a customer changing their mind. Waking
somebody for either teaches them to ignore the alert that matters.

## Decision 3: the check counts what it cannot value

`payments.in_transit` now reports both halves. The money comparison is
unchanged, and beside it the check counts **unresolved checkouts** — pending,
past their window, unanswered — and refuses to report agreement while any
exist.

It deliberately does not guess at an amount. An unresolved checkout is worth
either its gross or nothing, and there is no third figure that is honest.
Adding the gross to the processor side would state a difference that may not
exist; ignoring it entirely is what Phase 44 did. Counting it says exactly what
is true: *the books and the processor agree on the money we know about, and
there are two payments neither of us can account for.*

## Decision 4: a finding that survives the run

**This came out of browser verification**, and it is the same class of failure
as the phase itself.

The sweep worked: it reported *"1 the processor cannot account for — somebody
needs to look."* The sentence lived in a toast and a job payload. On reload it
was gone, and the row it meant sat in a list headed "Started and never
finished", under copy explaining that most of these are customers who changed
their mind and were charged nothing. The one row that was genuinely alarming
looked exactly like the harmless ones, for ever, and every hourly run would say
the same thing into the same void.

So `checkouts` now carries `last_reported_status` and `last_checked_at`, written
for every answer the sweep gets including the boring ones. They are separate
from `status` because they answer a different question: `status` is what these
books have concluded, and these are what the other party reported, unresolved.

The screen splits accordingly:

- **The processor has no record of these** — red, with the provider's own
  checkout reference to paste into their dashboard, and the last date we asked.
  "Go and look" without a handle is not advice.
- **Started and never finished** — quiet, with "not yet asked" shown as itself
  rather than dressed up as an answer.

A finding nobody can see an hour later is a finding the sweep did not make.

## Consequences

- A customer who pays and closes the tab has their invoice settled within the
  hour, without anybody opening a page.
- A payment the processor cannot account for is never written off by a machine,
  is visible with the reference needed to chase it, and holds the integrity
  check open until it is answered.
- The clearing-account check now fails where Phase 44 said it would.
- `unresolvedCheckouts` uses a one-day window rather than the checkout's own
  expiry alone. Generous on purpose: waiting another day costs a delay, and
  expiring early costs a refusal to look for money that arrived.
- The mock provider returns `unknown` for a checkout it has never heard of,
  which is the answer a demo genuinely gets after a restart — so the path that
  must never write anything off is the one a demo exercises first.
