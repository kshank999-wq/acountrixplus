# ADR 0057 — The statement run nobody has time for

- **Status:** Accepted
- **Date:** 2026-08-29
- **Context:** Spec §13, §24. Phase 55 made a statement sendable by a person.
  Sending them all, every month, is a job a small business does on one
  afternoon or does not do at all.
- **Builds on:**
  [ADR 0043](0043-a-business-that-has-to-remember-to-chase-does-not-chase.md),
  [ADR 0054](0054-the-letter-that-asks-for-money-we-are-holding.md),
  [ADR 0055](0055-the-statement-you-could-not-send.md)

## Context

Phase 55's own ADR nominated this phase, in these words:

> It does not send statements **on a schedule**, the way Phase 43 chases
> invoices. Month-end statement runs are a real thing a business wants, and the
> machinery is now all here — but a scheduler that emails every customer without
> anybody deciding again is the feature that most deserves its own phase, with
> its own preview screen, rather than being tacked onto this one.

Sending statements is the highest-leverage collections act a small business has,
and for an unglamorous reason: **most late payment is not refusal.** It is an
invoice that fell behind a filing cabinet, or went to somebody who left, or was
never matched to a purchase order. A monthly summary of the account fixes all
three without anybody having a difficult conversation — and it is exactly the
sort of repetitive, unurgent, mildly awkward job that never actually happens.

## Decision 1: a run creates the document, then sends it

This is the real difference from Phase 43's chase run and it is worth stating
plainly. **A chase sends a document that already exists.** A statement run has
to `saveStatement` first, because saving is what freezes the figures (Phase 11),
and frozen figures are the entire point of the document (Phase 55).

The consequence: a send that fails leaves a **saved statement behind**. That is
correct rather than untidy. The saved row is the evidence of what was about to
go out, which is what `saveStatement` has existed for since Phase 11, and the
failure itself is in the delivery log where Phase 24 already looks. The
alternative — deleting the statement when the email bounces — would destroy the
only record that the business tried.

## Decision 2: a customer whose money we hold gets one too

The inclusion rule is `hasSomethingToSay`: an open balance **or** held credit.
Not "do they owe us money".

Phase 54 established that a customer who owes nothing but whose money the
business is holding has something to be told, and that it is the *more*
important half — they are owed either a refund or an application, and **only the
business knows it**. A run that skipped them would be a system that reliably
chases what it is owed and silently sits on what it owes.

For the same reason the minimum-balance floor is exempted for held credit. A
floor exists to stop trivial *demands*; money the business is holding for
somebody is not a demand, and a customer owed $6 should still be told.

## Decision 3: once per period, enforced by the send itself

A daily worker must not send thirty statements a month. The rule is Phase 37's,
in its own words: **a period is billed exactly once.**

What makes it idempotent is deliberately *not* a separate "already run this
month" flag. It is `quietDays` measured against `customer_statements.sent_at` —
the same state that records the first send. A separate flag can fall out of step
with what actually went out; this cannot. It is also a question that only became
answerable in Phase 55, which finally wrote that column.

Counting from the last **send** rather than the last **run** has a second
benefit: a statement somebody sent by hand on the 29th stops the run sending
another on the 1st.

## Decision 4: the day is capped at the 28th

"The 31st" does not exist in seven months of the year. A schedule that silently
skips February — and April, June, September and November — is worse than one
that runs on the 28th, because the failure is invisible: nobody notices the
statements that did not go.

Both the check constraint and `clampDayOfMonth` enforce it, and the settings
screen says why.

## Decision 5: the preview is asked as if it were on, and as if today were the day

Phase 43 learned this the hard way and the lesson transfers exactly. Computed
against the *real* policy, every row on a company that has not switched this on
reads "statement runs are switched off" — including under the heading promising
to show what would go out. And on the other 27 days of the month, every row
would read "not the day of the month for the run". The preview would be empty at
precisely the moment it is the whole point.

So `previewStatements` asks with `enabled` forced true and the day check
**skipped**, and hands the caller the real policy alongside. `runStatements`
reads the stored policy and never the preview's copy — the switch is still what
decides whether anything is sent.

Skipping the check is not the same as forcing `dayOfMonth` to today, which is
what this was written as first. `isRunDay` clamps the policy's day to 28, so on
the 29th, 30th and 31st a forced day can never match — and the preview showed
"not the day of the month for the run" against every row. The browser found it,
on the 29th. The day is a **scheduling** question and this screen asks an
**eligibility** one; conflating them is what produced the bug, so the option is
now named for the distinction.

## Decision 6: its own settings table

`statement_settings`, not more columns on `chase_settings`. Chasing is a demand
aimed at one late invoice; a statement is a summary of an account, and plenty of
companies want the second without ever wanting the first. Folding them together
would mean switching on statements switched on chasing.

Off by default with no backfill, for the reason `chase_settings` records at
length: this sends email to *their customers* over *their* name, and a feature
that starts doing that because a migration ran is one nobody consented to.

## What the browser found

**The bug this ADR claims to avoid, in this ADR's own code.** Opened on the
29th, the preview read *"Nobody is due a statement"* with all five customers
under *"not the day of the month for the run"* — exactly the empty-at-the-crucial
-moment failure Phase 43 taught, reintroduced by forcing the day instead of
skipping the check. Fixed, with two tests pinning the 29th specifically.

Afterwards the preview earned its place immediately: it showed Foxglove
($6,491.94) and Bremen ($2,708.75) going out, and — more usefully — that **City
Works Authority owes $9,400 and has no email address on file.** That is a real
finding about the demo books that no other screen surfaces, and it is precisely
what a preview is for.

Bremen reading **$2,708.75** rather than €2,500 is Phase 56's functional balance
flowing through, and Harborview reading *"sent a statement recently"* is the
quiet rule holding against the statement Phase 55 sent by hand.

Switching on says *"The next one goes out on the 1st."* **Run it now**, pressed
on the 29th with the run day set to the 1st, declines honestly: *"Nothing was due
today. Statements go out on the day the policy names."* The policy was switched
back off afterwards — I turned it on to verify, and the argument of the whole
phase is that nobody's customers get email without somebody consenting.

## Consequences

- `statement_settings` and the `receivables.send_statements` job, scheduled
  daily at 07:00 UTC — before the chase, so a customer getting both on one
  morning reads the summary of their account before the demand about one
  invoice.
- `statement.policy` joins the audit actions.
- A partial index on `(company_id, customer_id, sent_at)` for the question the
  run asks once per customer per day.
- **Run it now** on the settings screen goes through the same function the
  worker calls, and deliberately still obeys the policy's day — a button that
  quietly does something the schedule never would is a button that teaches the
  wrong thing.

## What this does not do

It does not attach a **PDF**, for the reason Phase 55 gave: the link renders a
page that prints, and a stored PDF would be a second copy of figures that are
already frozen.

It does not send **supplier** statements. A business receives those rather than
sending them, and the useful version is a remittance advice — what a pay run
just paid and against which bills — which belongs with Phase 49's pay runs
rather than here.
