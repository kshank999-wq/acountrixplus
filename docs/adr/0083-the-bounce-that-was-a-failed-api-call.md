# 0083 — The bounce that was a failed API call

**Status:** accepted
**Date:** Phase 83
**Amends:** ADR 0005 (marketing), ADR 0082 (the unsubscribe headers).

## The defect

`sendStep` had two outcomes. The provider accepted the message, or it did not —
and the second set the recipient to **`bounced`**, with the provider's error
string in `skipReason`, a column whose own doc reads *"Why a recipient was
skipped: no_consent, suppressed, no_email"*.

Neither half is true. A provider refusing an API call — bad credentials, a rate
limit, a malformed address — is a **send failure**. A bounce is the receiving
mail server rejecting the message *after* the provider accepted it, hours
later, down a channel this application had no way to hear.

The difference decides what to do. A send failure is ours and usually
transient: retry it, fix the key, leave the address alone. A hard bounce means
the mailbox does not exist, and mailing it again on the next campaign is the
fastest way to lose a sending domain's reputation. Phase 82 got the headers
right to reach the inbox; **nothing here kept a sender there**, because the
real bounce never arrived at all.

## Five places already expected this

The schema was built for it in Phase 5 and the behaviour never came:

| Where | What it says |
| --- | --- |
| `campaign_recipients.provider_message_id` | *"Provider's own id, for reconciling delivery webhooks later."* |
| `recipient_status` | has `delivered` and `complained` — both unreachable |
| `campaign_events.kind` | names `"bounce"` and `"complaint"` |
| `suppressions.reason` | names `"bounce"` and `"complaint"`; only `"unsubscribe"` was written |
| `campaignStats` | reports a bounce rate |

Five anticipations and no arrival — the same shape as Phases 79 to 82, where a
comment described something nothing built. Here the *schema* was the comment.

## Decision 1: a send failure is `failed`, and says so in its own column

New enum value, new `failure_reason` column. `skipReason` goes back to
answering only the question it documents.

**Existing rows are not migrated.** A `bounced` row written before this phase
might have been either thing, and nothing in the record says which. Guessing
would put a fabricated distinction into a table people read to decide whether
an address is dead. They stay as they are and the distinction starts here.

## Decision 2: the meaning lives in a core, the parsing behind the seam

`delivery-events` decides what an outcome means; an adapter decides only what
its provider said. The judgement worth naming:

- **Hard bounce → suppress.** The mailbox does not exist.
- **Soft bounce → record, do not suppress.** A full mailbox is temporary, and
  suppressing on one silences a real customer because their inbox was full for
  an afternoon — worse than one wasted send. A provider that will not classify
  a bounce is treated as soft, because the cheap mistake is the reversible one.
- **Complaint → always suppress.** There is no defensible version of continuing
  to mail somebody who pressed "this is spam".

`advanceStatus` writes down a rule `recordOpen` has always followed informally:
webhooks arrive out of order, a `delivered` landing after a click is one slow
hop rather than a regression, and nothing moves a recipient off a terminal
fact. A complaint after a click *does* win — that is somebody who read the
message and objected, which is the more important thing to know.

## Decision 3: the endpoint fails closed

A shared secret in `Authorization: Bearer`, compared in constant time, with
**no development fallback**. With `EMAIL_WEBHOOK_SECRET` unset the endpoint
refuses everything.

The other four public entry points are safe to leave open because a token
identifies exactly one recipient and bounds what can happen. This one names any
recipient by a provider id, so an open version would hand somebody a way to
suppress addresses across a company's list. An unconfigured webhook loses bounce
handling; an unauthenticated one is worse.

It answers **200 even when nothing matched**, and swallows a single bad event
rather than failing the batch. A callback for a row retention has already swept
is expected rather than suspicious, and a provider that gets errors back
disables the webhook — which would silently return this application to the state
this phase just fixed.

## What this did not do

No real ESP adapter. The mock implements `parseDeliveryEvents` in the plainest
shape that carries the facts, so the endpoint, the tests and the demo have
something to exercise before anybody picks a provider; a real adapter maps its
vocabulary onto that and nothing else changes.

`tags` is now read — as a fallback when a provider does not echo a message id on
every event kind — which was the other half of ADR 0082's nomination.

The bounce rate's denominator changed. It was bounces over *everyone matched*,
including people the send skipped; it is now bounces over what a provider
accepted, which is what the number is normally understood to mean. `failed` rows
are excluded from that denominator because they never reached a provider at all.

## What the next phase might take

Nothing consumes a bounce except the suppression list. Phase 24 built a health
digest that tells somebody when a background job dies; a bounce rate climbing
past a few per cent is the same kind of fact — it is the signal a sending domain
is in trouble, it is now measurable for the first time, and no one is told. The
digest already exists and already knows how to say something once.
