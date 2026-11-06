# 0189 — The versions a client opened

**Status:** accepted
**Date:** 2026-11-06
**Phase:** 189

---

## The last item of §7's client-link bullet

Phase 188 measured that bullet item by item — view tracking, acceptance,
comments/questions, version history, PDF download — after discovering the
nomination it had inherited was fourteen phases stale. Four of five were built.
This is the fifth.

The measurement stands: `proposal_versions` has held every send since Phase 21,
each with its `sentAt`, its `totalCents` and its `pdf_document_id`; the
company's own workspace has listed them with download links since then; and the
client link offered a single *Download the PDF* with no sign the document had
ever been revised. `/api/pdf/version/[id]` is company-only — it reads
`actor.companyId` — so there was no path by which a client could reach one.

## The decision: evidence, not policy

The question §7 leaves open is what a client may see of a **superseded**
version, and both obvious answers are wrong.

Serving every earlier PDF fails in a specific case: a company sends a price by
mistake, corrects it an hour later, and the page hands the client the mistake —
on a link the client may never have opened in that hour. Serving nothing is
what the page did and is what §7 asks to change.

`proposal_views` already records **when the client opened the link**, and each
version is the document that link served between its `sentAt` and the next
one's. So the rule is evidence rather than a judgement somebody has to defend:

> A client may re-read a version they demonstrably opened.

Every version is **listed** with its date, because knowing a document was
revised is what a version history is for and discloses no figures. One they
opened also carries its total and a download. One they never opened is a date
and the words *not opened*.

It is a rule the system can prove rather than a preference, and it is
symmetrical: it withholds nothing the client has already had, and offers
nothing they have not.

### Two edges that are not corners

**The window is half-open**, `sentAt <= viewedAt < nextSentAt`. Closed at both
ends would let one view unlock two versions, and two sends can be milliseconds
apart — which is exactly when that shows. A test puts a view on each edge.

**A view before the first send belongs to no version.** That is not
hypothetical: it is the author's own *"Preview client view"* on a draft, which
Phase 188 recorded as live behaviour and declined to close. Attributing it to
version 1 would unlock a version on the strength of the seller having looked
at it.

## One reader, again

`versionForClient` is the single answer to "may this client read this version",
and the download route calls it. The page's history and the route's refusal are
the same function, because Phase 188 happened when the page, the acceptance and
the PDF each had their own idea of what a client was looking at.

The download is a **query parameter on the existing route**, not a second
route. Two routes is two places to get the rule right and one of them
eventually would not — which is the same argument one level down from the one
that produced `client-link.ts`.

The refusal is a flat 404 for "no such version", "not your proposal" and "you
never opened it" alike. A distinct status for the last would confirm that a
version exists, which is the one thing withholding it is for.

## What the page shows, and when it shows nothing

A proposal sent once renders no history at all. *"Version 1 of 1"* on every
proposal is noise, and noise on a client-facing page is worse than noise
anywhere else: it is the one page where everything present is read.

An earlier version links to its **PDF**, not to a rendering of the page. A
superseded version is a document somebody read, not a state this page can be
put into — and rendering one live would need its blocks, which the snapshot has
only carried since Phase 188, so older versions would render half-right. A
half-rendered old version is the two-documents problem this whole arc is about.

## The register reported its own drift, twice running

Phase 187 moved the isolation scans into a module so `PINNED_CLAIMS` could
measure the sentence quoting their numbers, after five phases of hand
correction. Phase 188 added five reads and the test said:

> says 567 where **number 1** of this sentence should be 569.

This phase added five more and it said:

> says 929 where **number 2** of this sentence should be 934.

Two different numbers of the four, in consecutive phases, each named. Number 2
is one the old single-capture pattern could not have seen at all — it only ever
compared the first. That is the part of Phase 187 that is now paying: not that
the sentence is checked, but that all four of it are.

## What this does not do

**A client cannot read the body of an earlier version, only its PDF.** For a
version sent before Phase 188 there is no body to read — the snapshot carried
no blocks — so a page that offered one would be offering it inconsistently.
Once every live version carries a document, rendering an earlier one in the
page is a small change and a better experience than a download.

**The company cannot override the rule.** There is no "share this version with
the client anyway", and there is a real case for one: a client who lost the
email and never opened the link has no way to be given what was sent. The
honest version of that feature is a re-send, which already exists and creates a
version of its own.

**Nothing marks which version was accepted.** `proposal_acceptances` has
carried `proposalVersionId` since Phase 21 and the history does not read it, so
a decided proposal's list does not say *this is the one you signed*. That is
the obvious next thing to want from this list and it is one join; it is left
out because the acceptance panel already states the figure and the date, and
two places saying it is how they come to disagree.

## Nominated for Phase 190

**SVG import and export (§7).**

Three of ADR 0173's eight remain and all three are §7's Illustrator-class work,
which §7 itself defers — *"advanced Illustrator-class path editing can be
phased in after the core proposal workflow is stable"*. ADR 0182 already
recorded that this sentence defers **path editing** and not the rest of the
bullet, and the audit's own note says reading it as deferring both bullets is
the generous reading.

SVG is the one of the three that is not path editing. The audit measured it as
*"Nothing for designs. The only SVG in the codebase is QR output"* — and that
QR output is the thing to look at first, because it already produces SVG the
page renders and the PDF does not. An `svg` block that carried markup would
have the same shape, and the PDF question is the same question: Phase 185's
writer places text, rectangles and images, so a vector path is a new primitive
rather than a new block.

Behind it: artboard affordances and vector primitives, which §7 defers and
which are the last two.
