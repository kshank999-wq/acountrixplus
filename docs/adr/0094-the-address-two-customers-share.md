# 0094 — The address two customers share

**Status:** accepted
**Date:** Phase 94
**Amends:** ADR 0033 (the integrity register), ADR 0093 (filing a letter against the party it was about).

## The defect

Phase 93 taught `recordOutboundMail` to **refuse** when two parties of one kind
share an address: filing on one of two is a coin flip, and an entry on the wrong
customer is evidence about the wrong party.

That refusal is right, and it is silent. `recordOutboundMail` returns null for a
stranger, for a duplicate address, and for a letter with no honest party — three
different situations, one quiet `return null`. So the application now *detects* a
real data-quality problem and tells nobody, which is precisely the shape ADR 0033
exists to fix. Its own words: **a check nobody runs is not a check.**

The lost filing is not even the worst of it. Two customers on one address means
both are chased at that inbox, both statements arrive there, and the person
reading them cannot tell which account either refers to.

## Decision 1: across the sides is business, within a side is a defect

This is Phase 93's insight inverted, and getting it backwards would be easy.

`accounts@harborview.test` being **both a customer and a supplier** is ordinary:
a firm that buys from you and sells to you, with one shared inbox. Phase 93 built
`filingFor` precisely so that arrangement works, and flagging it would raise an
alarm on every such firm — which the register's own docstring already warns
about: *an alarm that fires on ordinary business is one that gets switched off
before the day it matters.*

`accounts@harborview.test` being **two customers** is a defect.

So the grouping is by *side and address together*, in the core rather than as a
filter afterwards. Putting the rule in the grouping is what stops somebody later
"simplifying" it away.

## Decision 2: normalisation stops at case and whitespace

Case and surrounding space are typing, not intent — the same `lower(btrim(...))`
the send path has always matched on, so the check reports exactly the addresses
that would actually collide.

Plus-addressing is deliberately **not** collapsed.
`accounts+ridgeline@harborview.test` and `accounts+kestrel@harborview.test` reach
one mailbox, and that is somebody splitting their post by account on purpose.
Treating them as one would report the tidy arrangement as the mess.

## Decision 3: a position, not a fault

A parent company and its subsidiary genuinely may share an accounts inbox. So
this is reported, recorded and shown without being called a broken book — the
same classification `payables.duplicate_bills` carries, for the same reason:
reporting a suspicion as a fault is how a check gets ignored.

The finding **names** the parties rather than counting them, on the argument
Phase 85 made for the sending digest: a number with no name in it is a number
nobody can act on, and the first thing anybody would do is ask *which*.

Archived parties are excluded. Archiving is how a duplicate gets tidied up, so
counting the archived one would mean the fix never clears the finding.

## Decision 4: a check that counts things does not report money

Found in the browser rather than in a test, and worth recording as its own
decision because it was a real defect this phase would otherwise have shipped.

The operations page rendered every disagreement as
`formatCents(differenceCents) + " apart"`. With counts in those fields, two
customers on one email address displayed as **"$0.01 apart"** — not merely
unhelpful but *false*, in a register whose whole job is telling somebody the
truth about their books.

`banking.shared_ledger_accounts` has counted accounts against ledger lines since
Phase 40 and had the same problem, unnoticed. So a check now declares its
`unit`, money by default, and the page says **"worth a look"** for a counting
check and leaves the specifics to the `detail` line it already shows. Both checks
are fixed, not just the new one — adding a second instance of a display that lies
would have been the worse outcome.

## What this did not do

**It does not merge anything.** The check reports; a person decides whether two
records are one business. Merging customers is a real feature with real
consequences for the ledger, and inventing it inside a nightly reconciliation
would be the opposite of this register's design.

**It does not look at contacts.** Two CRM contacts on one address is normal —
two people at a firm sharing a shared inbox — and neither is a side of the books.

**`recordOutboundMail` is still silent.** The three reasons it files nothing
remain indistinguishable from outside. What changed is that the one that is a
standing data problem is now reported by something that runs every night, rather
than only being discoverable at the moment a letter happened to be sent.

## What the next phase might take

The finding names the duplicates and there is nothing on the customers screen
that acts on it. Somebody reading *"2 customers share accounts@cascade.test"* has
to go to another page, find both records by hand, and decide which one the
invoices should have gone to — with no view of what each has on it. The register
found the problem; the screen where it would be fixed does not know about it.
