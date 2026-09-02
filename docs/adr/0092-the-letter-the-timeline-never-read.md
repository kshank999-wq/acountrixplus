# 0092 — The letter the timeline never read

**Status:** accepted
**Date:** Phase 92
**Amends:** ADR 0022 (the communications log), ADR 0091 (keeping the letter's words).

## The defect

ADR 0022 built the communications log to answer the question
`transactional_messages` cannot: *what have we said to this client?* When a
letter goes to an address the CRM knows, `recordOutboundMail` files it on that
contact's timeline beside the phone calls somebody logged by hand, and stores the
row's `transactional_message_id`. **The two have been joined in the schema since
Phase 22.**

Nothing ever followed the join. Both readers use that column as a boolean —
`is not null` becomes `wasSentByTheSystem` — and the entry's own `body` is null
for a letter that *arrived* (it is written only on a bounce, to say so). So the
timeline could say "we sent them an invoice on the 3rd" and could not say what
the invoice said.

Until Phase 91 that was honest, because nobody kept the words. Phase 91 kept
them. The link has been there since Phase 22 and the text since Phase 91; this is
the phase that reads one through the other.

## Decision 1: follow the link, never copy the text

The cheap fix is to write the letter's body onto the communications row at send
time. It would work, and it is the exact defect ADR 0091 is named after: two
copies of one text, where an edit fixes one and leaves the other lying.

The foreign key is already there. So the reader follows it, as a **correlated
subquery** rather than another table in the from-clause — these readers already
`or` together three matches across two left joins, and a fourth table in that
shape is how a timeline quietly starts showing an entry twice. A subquery in the
select list cannot change the row count, and `engagement.test.ts` asserts that it
does not.

## Decision 2: two sources, never blended

An entry can carry two texts: a **note**, which is what a person at this company
wrote down, and a **letter**, which is what this company sent to somebody else.

The tempting shape is one `body` field that falls back from the first to the
second. It is wrong for a reason beyond tidiness. In a dispute — the case a
communications log exists for — *"what we told the customer"* and *"what our
salesperson wrote down about a call"* are different kinds of evidence, and only
one of them is something the customer also holds a copy of. A screen that renders
both as unlabelled body text lets one be read as the other.

So `partsOf` resolves an entry into an ordered list of **labelled parts**, and a
screen cannot render one without saying which it is.

Two consequences fall out of that rather than being decided separately:

- **A bounce shows both, note first.** Those are the only entries carrying two
  parts: the mailer's note says the letter did not arrive, and that changes what
  the letter below it means — somebody has to decide whether to resend or
  telephone.
- **A letter shows only on a system send.** An entry somebody logged by hand has
  no letter, and surfacing text from a row it merely referenced would attribute
  words to this company that it never sent.

## Decision 3: three silences, told apart

`emptyBecause` distinguishes *"no more was written down"* — a complete short
entry — from *"this letter's wording is no longer kept"*, which is a letter sent
before Phase 91 or swept by retention at a year. The same argument `explain()`
makes in `mobile/decision`: a person looking at an empty entry should not have to
guess which silence they are looking at.

## What this did not do

**No backfill and no new storage.** Nothing was written; a reader started reading
what was already there. Letters sent before Phase 91 show as not kept, because
their words are genuinely gone.

**No permission change.** The timeline is `crm:view`, as it was. A person who
could already see that a letter went, and its subject, can now see its
paragraphs — and the link it carried is not stored at all, so this widens what is
readable without widening what is reachable.

**Only the two CRM readers.** `communicationsForOrganization` and
`communicationsForOpportunity` follow the join; `lastContactedAt` and the
tasks readers have no letter to follow and are untouched.

## What the next phase might take

`recordOutboundMail` files a letter only when the address belongs to a **contact**
this company knows. An invoice sent to a customer whose email lives on the
`customers` row rather than a CRM contact — which is the normal case for a
business that bills people it never courted — lands in `transactional_messages`
and on nobody's timeline at all. The words are kept and the join now works; the
entry that would carry them is never written.
