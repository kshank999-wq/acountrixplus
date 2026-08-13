# ADR 0005 — Consent is checked at send time, and a click never closes a loop by itself

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §8 (shared creative studio), §9 (lost-opportunity nurture), §10 (marketing and strategic prospecting), §14 (roles), §19 (compliance), §20 (Phase 5)
- **Builds on:** [ADR 0004](0004-document-engine-and-brand.md)

## Context

Spec §10 asks for segments, campaigns, nurture sequences, engagement tracking,
and a feedback loop back into sales. Spec §19 adds the constraint that makes
the interesting decisions: unsubscribe status must be maintained, and consent
recorded.

Marketing is the first module where the software can do something to a person
who is not a user of it, days after anybody pressed a button. That shapes
nearly every decision below.

## The test ADR 0004 set for this phase

ADR 0004 committed to a falsifiable claim: that marketing would need only new
block types, not a new engine. **It passed.** Marketing creative required three
new block types (`button`, `qrCode`, `video`), their renderer cases, their
merge-field cases, and CSS. No change to `design_documents`, to `DocumentPage`,
to merge-field resolution, or to the template infrastructure.

The stronger evidence is `render-email.ts`: a *second* renderer over the same
blocks, emitting tables with inline styles instead of React and CSS. That is
only possible because a block was never tied to coordinates.

## Decisions

### 1. A segment describes interest; consent decides contact

These are separate functions on purpose. `matchesSegment` answers "is this
person in the audience"; `isContactable` answers "may we email them". Neither
calls the other.

Mixing them would let a wide segment quietly imply permission — the failure
mode where "match everyone" becomes "email everyone". Instead a segment with no
rules deliberately matches everyone, and the send pipeline still refuses to
email anyone who has not opted in.

### 2. Consent is re-checked at send time, not at segment time

Segments are evaluated on demand rather than materialized. An audience built
three weeks ago should reflect who qualifies *today*.

`sendStep` runs in a fixed order, and the order is the decision:

1. Evaluate the segment — who are we interested in?
2. Re-check consent and the suppression list **now**.
3. Record a recipient row for everyone, including those skipped, with the
   reason.
4. Only then hand anything to a provider.

Step 3 exists because a marketer who is told only "40 sent" against a segment
of 200 will read a working consent check as a delivery bug. The campaign page
says "1 of 3 people who matched this segment were not emailed: 1 had not opted
in. That is the consent check doing its job, not a delivery failure."

No adapter is ever asked to decide *whether* someone may be emailed, so a
misconfigured provider cannot become a compliance failure.

### 3. Suppression is company-wide and keyed by address

Not by contact id. A contact record can be deleted and recreated — lead intake
does exactly that when someone fills in the form again — and an address-keyed
suppression survives it. Tested directly.

Removing a suppression lifts the hard block **only**; the contact's consent
stays `unsubscribed`. Consent is theirs to give, not ours to restore.

### 4. Four public write endpoints, all defended in the service layer

Joining lead intake and proposal acceptance: unsubscribe, open tracking, and
click tracking. All three are reached from a link in a delivered email, from a
device with no session, identified only by an unguessable per-recipient token.

| Rule | Why |
| --- | --- |
| Unsubscribe is a **POST**, not a GET | Mail clients and security scanners pre-fetch links; a GET that changed state would opt out people who never clicked |
| The click destination is **re-validated** through `safeUrl` | Otherwise a forged tracking link is an open redirect to a phishing page |
| An unknown token behaves exactly like a valid one | Probing tokens must reveal nothing about which exist |
| The open pixel never throws | Analytics must not cost a rendered email |
| Unsubscribe is idempotent | People click twice, and mail clients click for them |

A leaked token reaches exactly one recipient of one campaign step, and can read
nothing.

The RFC 8058 one-click target is the API endpoint; the footer link is the
confirmation page. `OutboundMessage` carries both.

### 5. A click raises a task; it never reopens a deal

Spec §10 wants engagement to feed back into the pipeline. It does — as a task
for whoever owns the relationship, with the deal left exactly as it was.

Reopening a lost opportunity automatically would silently rewrite the win/loss
figures spec §9 reports, and it is a judgement a salesperson makes. One open
task per organization per campaign, however many links get clicked.

### 6. Rates are quoted against the right denominator

Open rate is over messages *sent*, not over everyone the segment matched.
People skipped for consent never had the chance to open anything, and folding
them into the denominator would make a well-targeted campaign look like a
failing one. Ratios are basis points, consistent with the sales analytics.

### 7. The document's kind decides which permission governs it

A marketing role holds no proposal permissions and a sales role holds no
marketing ones, yet both edit through the same designer. `permissionFor(kind)`
resolves the check from the document itself, so a shared editor grants neither
role reach into the other's work.

## Consequences

- **Nothing is scheduled.** `scheduledFor` puts a campaign on the calendar;
  sending is still a button somebody presses, and a nurture step's `delayDays`
  is recorded but not acted upon. A background worker is the missing piece, and
  it should call the same `sendStep` this phase already enforces consent in.
- **No provider callbacks.** Bounces are recorded from the synchronous send
  result. Real ESPs report hard bounces and complaints by webhook hours later;
  that endpoint does not exist, so the suppression list will under-count until
  it does.
- **Open tracking is a pixel**, so it under-reports systematically — image
  blocking is the default in several major clients. Click rate is the more
  honest number, which is why the sales loop keys on clicks.
- **QR codes cannot render in the designer preview.** The encoder is
  server-side; the client-side preview shows a labelled placeholder naming what
  will be encoded. The sent and printed output is correct.
- **The mock email provider sends nothing.** That is the default, so the demo
  and the tests run with no credentials and no risk of a real send. Every
  message is retained for assertion.
- **A/B testing, send-time optimization, and per-recipient scheduling** are not
  built. None of them change the consent model, which is the part that would
  have been expensive to retrofit.

## Follow-up

The next phase that touches this should start with the scheduler, because it is
the one gap that changes behaviour rather than adding surface: a worker that
walks due campaign steps. If it can be written without reaching around
`sendStep` — that is, without a second path to a provider — the consent
boundary drawn here holds. If it cannot, the boundary is in the wrong place.
