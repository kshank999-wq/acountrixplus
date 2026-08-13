# ADR 0008 — A queue you can replay, and a PWA instead of an app store

- **Status:** Accepted
- **Date:** 2026-08-13
- **Context:** Spec §3 (mobile workflow, receipts), §18 (responsive/PWA before native, versioned contracts), §19 (idempotency, least privilege), §12 (credentials stay server-side), §22 (definition of done)
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md)

## Context

The request for this phase was "mobile apps". Two things in the spec bear on
that, and they point the same way.

Spec §18:

> …a responsive web/PWA interface **before committing to separate native mobile
> apps**.

Spec §20's Phase 8 is *Payroll/Tax/Advanced Integrations*, not mobile at all —
the spec treats mobile as a property of every phase rather than a phase of its
own, and Phase 1 already delivered "mobile-responsive review".

So this phase builds the mobile app as an installable PWA, and builds the
versioned API and the idempotency contract that a native client would consume
if one is ever written. What it does not do is start a second codebase.

The engineering problem underneath is narrower than "make it work on a phone",
because Phase 1 already did that. It is this: **a phone is sometimes offline,
and a pocket is sometimes emptied.** Everything below follows from those two
facts.

## Decisions

### 1. An operation replayed any number of times has the effect of one

This is the phase's central claim and the thing every other decision leans on.

A phone that categorizes six transactions in a lift and reconnects at the top
has six queued writes. It may also have *already* sent one and lost the
response — and from the client's side those two situations are identical:
silence. It has to retry. If retrying can double-post a journal entry, an
offline queue is a liability rather than a feature.

So every queueable mutation carries a client-generated key, and
`modules/mobile/idempotency.ts` makes replaying free. Two details are
load-bearing:

**The key row is written inside the operation's own transaction.** The naive
shape — check for the key, do the work, record the key — lets two concurrent
retries both pass the check and both post. Writing the key *first, inside the
transaction* makes the database's unique constraint the arbiter: the second
one fails to insert, its transaction rolls back, and none of its work survives.
The loser then reads the winner's stored result and returns it, which is the
correct answer.

**The request is fingerprinted.** A key reused with *different* arguments is a
client bug, not a retry, and returning the first result would silently discard
the second request. Hashing the arguments turns that into a 409 the client can
act on. Keys are sorted before hashing, so a client that serializes its queue
in a different order on retry is still retrying.

`tests/mobile.test.ts` asserts the claim directly: send the same operation six
times concurrently, get one journal entry.

### 2. The pure half of the outbox is a separate file from the browser half

`modules/mobile/outbox.ts` has no IndexedDB, no `fetch`, and no `window`. It is
ordering rules, retry policy, and the decision about which failures are worth
retrying — all as pure functions over plain data. `app/m/outbox-client.ts` is
the shell that talks to the browser.

This is not tidiness. Every part of an offline queue that goes wrong is in the
first file, and it is testable in milliseconds without a browser. The parts
that need a browser are `store.put()` and `fetch()`, which is not where the
bugs are.

Three rules are worth naming because they are easy to get wrong:

- **Superseding.** Categorizing one transaction three times offline sends the
  answer the person settled on, not all three. `receipt.attach` is deliberately
  excluded — two photos of two receipts are two attachments.
- **One operation per entity per round.** A categorize followed by a note must
  land in that order, or the note reaches a transaction the server has not
  categorized yet and the audit trail reads backwards.
- **Permanent versus retryable.** A 4xx that is not a timeout or an in-flight
  conflict means the server understood and refused; retrying is a slower way to
  fail. Those park immediately instead of after six attempts.

### 3. The mobile API is a different door, not a different building

Every operation in `modules/mobile/operations.ts` is a thin validated call into
*the same service the browser uses*. A categorization from a phone produces the
same journal entry and the same `transaction.categorize` audit event,
attributed to the same person. Nothing in the record says "from a phone",
because nothing about the accounting is different.

Four services gained an optional executor parameter to make that possible —
the convention `createJournalEntry`, `recordAudit`, and (in Phase 7)
`createInvoice` already used. The alternative was to reimplement categorization
against a transaction, which is how two code paths drift.

The endpoint is `/api/mobile/v1/sync`, with the version in the path. A header
would be silently ignorable; the client that most needs the guarantee is the
one that cannot be updated — an installed PWA with a stale service worker.
One round trip drains the outbox *and* returns fresh state, because a phone on
a train gets one window of connectivity and spending it on two round trips is
how a sync fails half-done.

Authentication is the ordinary session cookie. Same origin, same signed
httpOnly cookie, no second authentication path to get wrong.

### 4. A device is revocable on its own

Sessions existed; this names them. The reason is narrow: when a phone is lost,
its owner needs to cut *that* device off from the laptop they are doing it
from, and before this the only tool was "expire everything".

Revoking deletes the device's sessions and marks the row rather than deleting
it, so "which device did that" stays answerable after the phone is gone.
`resolveSession` checks the revocation on every request, for the same reason it
re-checks membership: a lock that waits for a session to expire is not a lock.

Revoking the device you are holding is allowed. It is odd, but a person with
one device and a stolen password has to be able to lock it out.

### 5. Nothing that changes data is ever cached

The service worker is hand-written and about a hundred and thirty lines,
because a generated one is a large amount of code nobody has read running with
the ability to intercept every request the app makes.

`/api/**` is never cached — not network-first, *never*. A sync response is one
user's live state, and a cache that served it to the next person on a shared
device would be a data leak rather than a stale page. Only GET is considered at
all; a cached POST would be a way to post a journal entry twice.

The offline fallback is a plain HTML file in `public/`, not a page in the app.
The first version was a Next.js page, and navigating offline produced
"Application error: a client-side exception has occurred" — the framework
failing to load its own error page, because the page's JavaScript chunk had
never been downloaded and so was never in the cache. The document that has to
render when nothing else can cannot depend on the framework.

### 6. Notifications default to on; AI defaults to off

ADR 0006 made "unconfigured" and "off" the same state for AI, because AI is
additive and nobody should get it by forgetting. Notifications are the reverse:
granting the browser permission *is* the opt-in, it is explicit, and it has
already happened. Making somebody opt in a second time is how a useful reminder
never arrives.

Two levels, kept apart: the device subscription, and the per-topic preference.
Collapsing them means turning off one category you dislike costs you every
notification on that device — so people turn the lot off and the feature dies.

The nudge fires on a threshold, not per transaction, because "you have one
transaction to review" is the notification that gets an app muted.

### 7. Receipts are downscaled in the browser, and have their own permission

A phone camera produces four megabytes for a photograph of till paper.
Downscaling to 1600px takes a few hundred milliseconds and produces about
200 KB that is still perfectly legible. Doing it server-side would mean
uploading the large file first, which is the expensive part. This is the one
case where client-side image processing is clearly right.

`uploadAsset` requires `company:manage` because it is the brand library — a
bookkeeper has no business replacing the logo. A bookkeeper has every business
photographing a receipt, so `uploadReceipt` is a separate entry point with
`bookkeeping:categorize`, writing into the same store. Sharing the storage and
splitting the permission is the right way round.

Attaching is idempotent by construction — attaching the same asset twice leaves
one attachment — so the guarantee holds even for a client that lost its key.

## A deadlock this phase uncovered, which predated it

Writing the concurrency test for §1 exposed a deadlock in `nextEntryNumber`
that had been there since Phase 2.

Every table has a foreign key to `companies`, so inserting an audit event takes
a `FOR KEY SHARE` lock on the company row. Journal numbering took `FOR UPDATE`
on that same row. Two concurrent postings therefore both held KEY SHARE and
each then waited for the other to release it:

```
T1: insert audit event  → KEY SHARE on companies
T2: insert audit event  → KEY SHARE on companies
T1: SELECT … FOR UPDATE → waits for T2
T2: SELECT … FOR UPDATE → waits for T1     → deadlock
```

Two people categorizing at the same moment was enough. It went unnoticed
because nothing before now posted concurrently within one company.

The fix is a transaction-scoped advisory lock, which lives in its own namespace
and cannot interact with foreign-key locks at all. There is a regression test
named after it.

## Consequences

- **No native apps.** Push works on Android and on iOS 16.4+ for *installed*
  PWAs only; iOS Safari in a tab cannot receive push at all. Background Sync is
  Chromium-only, so on Safari the queue drains on `online`, on visibility, and
  on a slow timer — which covers everything except the app being closed for the
  whole outage. If those gaps matter commercially, the API this phase built is
  what a native client would consume.
- **Receipt uploads are not queueable.** A megabyte of JPEG will not go in the
  outbox without filling the device's storage quota, so photographing offline
  fails and says so. The *attachment* is queueable, being a few bytes of JSON.
- **`rememberVendor` is disabled on the queued path.** Creating a rule writes
  outside the operation's transaction and creating the same rule twice is a
  mess to undo, so the phone offers the checkbox only when online.
- **Idempotency keys expire after 14 days.** Past that a replay is treated as a
  new operation. Long enough for a phone left in a drawer over a long weekend;
  the pruning is a function nothing calls yet, because there is still no job
  runner.
- **Nothing schedules the nudge.** `nudgeReviewQueue` works and is tested, and
  the only thing that calls it is the seed. A daily "here is what is waiting"
  needs the same background worker the campaign scheduler has been waiting for
  since ADR 0005 — now three phases.
- **The mobile review deck handles categorize and exclude, not split.** Splits
  are queueable and the API accepts them; the phone has no UI for one, because
  a two-line split on a phone screen is a worse experience than waiting for a
  laptop.
- **The device list is per user, not per company.** An owner cannot see or
  revoke their bookkeeper's phones. That is deliberate — it is a personal
  security surface — but a company that needs to cut off a departing employee
  must deactivate their membership instead, which `resolveSession` already
  honours on the next request.

## Follow-up

1. **The background worker.** It is now blocking three things: the campaign
   scheduler (ADR 0005), the WIP adjusting entry (ADR 0007), and the review
   nudge. That is enough evidence that it is the next piece of infrastructure
   rather than another feature.
2. ~~**A dependency audit.**~~ Done immediately after this ADR was written:
   `drizzle-orm` went 0.36.4 → 0.45.2 and `drizzle-kit` 0.28.1 → 0.31.10,
   clearing the SQL-injection advisory. The migrations produce a byte-identical
   schema from empty and the suite passed unchanged. The remaining `postcss`
   and `sharp` advisories are transitive through `next` and need a framework
   upgrade rather than a dependency bump.
3. **Conflict presentation.** The outbox parks an operation the server refused
   and shows the reason, which is honest but not helpful — a person who
   categorized something into a period that closed while they were offline gets
   an error, not a way to fix it. The test of whether this ADR's design was
   right is whether that repair flow can be built on the parked entry as it
   already exists.
