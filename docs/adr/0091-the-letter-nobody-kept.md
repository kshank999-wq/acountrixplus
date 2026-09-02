# 0091 — The letter nobody kept

**Status:** accepted
**Date:** Phase 91
**Amends:** ADR 0019 (transactional mail), ADR 0088 (the firm's morning brief), ADR 0090 (the decision record).
**Corrects:** ADR 0090, Decision 3.

## The correction first

ADR 0090 justified storing no body on the mail side of `notification_log` like
this:

> A mail-backed notification's text is already in `transactional_messages`,
> rendered, with the address it went to.

**That was false.** `transactional_messages` held the subject, the address, the
kind, the outcome, the provider's message id and a reference. It held no body at
all. `sendTransactional` composed the text and the HTML, handed both to the
provider, and kept neither.

So for one phase this repository carried a written-down reason that named a place
that did not exist, and — worse — used it to argue for *not* storing something.
The conclusion happened to survive; the argument for it did not. A wrong reason
written down is more dangerous than no reason, because the next person builds on
it rather than checking it.

The correction is recorded here, in `mobile/decision`, in the
`notification_log.body` comment and in the README, rather than by quietly
editing the original sentence away.

The conclusion stands on a better footing: **the body belongs to the letter, not
to the decision about it.** A second copy of the same words in a second table is
still the two-answers-to-one-question defect. What was missing was the first
copy.

## The defect

For eighteen phases nobody noticed, because every question asked of
`transactional_messages` was a delivery question — *did the mail go* — which the
subject and the outcome answer.

Phase 90 made it a different question. It gave the firm's brief a decision
record and told a person, on their own roster, that a letter had been sent. The
obvious next thing anybody would do is ask what it said, and the honest answer
was that nobody knew. The words existed for the duration of one function call
and then only in somebody's inbox.

## Decision 1: the body is what was said; the link is what it granted

Keeping a letter verbatim is not free, and the reason is in `renderText` itself:
it appends `action.url` to the text. That URL is a **capability** in every kind
this application sends — a password reset's single-use token, an invitation's
join token, a signed invoice or statement link that anybody holding it can open.
Storing the rendered text would turn a table kept for a year, readable by more
people than were sent the letter, into a store of live credentials.

So `keptBodyFor` keeps the paragraphs and the footnote, drops the action URL, and
puts the action's **label** in its place — a reader can see the letter offered
them somewhere to go without being able to go there.

**Deliberately one rule rather than an allow-list of kinds that may be stored.**
An allow-list is a thing to forget: the ninth `TransactionalKind` is added by
somebody who has not read that file, and forgetting to list it either silently
loses a letter or silently stores a token. A rule that holds for every kind has
nothing to forget, and `keeping.test.ts` asserts it across the shape of all eight
at once rather than one at a time.

The stored text mirrors `renderText` paragraph for paragraph, because a kept
letter that reads differently from the delivered one is worse than no kept
letter — a person comparing the two would reasonably conclude one had been
tampered with.

## Decision 2: the decision names the letter

Phase 90 separated the decision from the transmission and then had no way to get
from one to the other; a reader had to guess by matching a subject, an address
and a date. `notification_log.message_id` makes the join real, and
`sendTransactional` returns its own row id — on the failure branch too, because a
letter that did not arrive is still the letter we tried to send.

`decisionFor` refuses a message id on a **suppression**, which composed nothing:
an id there would name somebody else's letter, and the row would look complete
while opening the wrong text.

`ON DELETE SET NULL`, not cascade. Retention sweeps letters at a year and the
record of the decision must outlive them: *"we told you, and the letter has since
expired"* is a true answer, and the row vanishing is not.

## Decision 3: the letter opens where the question is asked

A `<details>` on the roster rather than a page of its own. The brief is short,
and somebody checking what they were told is checking it against the client list
they are already looking at — sending them elsewhere to read four lines would
lose the comparison that made them ask.

## What this did not do

**No backfill.** Every letter sent before this phase has a null body, because its
words are genuinely gone. A null reads as "not kept" rather than "said nothing",
which is the truth.

**No new expiry.** Bodies inherit `transactional_messages`' existing 365-day
retention rather than getting a policy of their own. One sweep, one answer.

**The company side still cannot open its letters.** Invoices, statements and
remittances now keep their words, but only the practice roster reads a stored
body back. The communications timeline from Phase 22 shows that a letter was
sent and still links to nothing.

**HTML is not kept.** The text part only. The HTML is a rendering of the same
paragraphs, and keeping both would be the defect this ADR is named after,
committed twice.

## What the next phase might take

`recordOutboundMail` files a letter on a contact's timeline whenever there is a
company, and that timeline is the one place a person looks for *"what did we send
this customer"*. It now points at rows that finally have bodies, and shows none
of them. The words are kept and, for every company-facing kind, still unread.
