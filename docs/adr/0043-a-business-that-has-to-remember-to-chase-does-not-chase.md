# ADR 0043 — A business that has to remember to chase does not chase

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §13, §18, §24. Phase 42 got an invoice to the customer.
  Nothing asked them again.
- **Builds on:** [ADR 0042](0042-what-the-customer-opens-is-the-ledger.md),
  [ADR 0024](0024-a-job-that-announces-nothing-is-read.md),
  [ADR 0002](0002-double-entry-ledger.md)

## Context

The aging report has known who owes what since Phase 2. Phase 42 built the
send: the wording, the reminder flag, the count, the delivery record. Phase 10
built a worker with schedules. And an invoice that went out in March was still
open in July, because chasing is a job nobody has, that has to happen on a
Tuesday when something else is on fire, and that feels rude.

`engagement.chase_overdue` already existed and chases **internal tasks to
staff**. Nothing chased an invoice to the person who owed the money.

So the parts were all there and the only genuinely hard question was left
unanswered: **when**.

## Decision 1: two expensive wrong answers, and the rules that follow

**Chasing something already settled** is the worst outcome by a distance. A
customer who paid last week and gets a demand this week does not conclude that
the software is confused; they conclude these people do not know what they are
owed, and every figure the business sends afterwards is doubted. So the rule is
not *chase what is overdue*. It is *chase only what is open, unsettled, not
written off, actually sent, and not just part-paid*.

**Chasing too often** is how a sender gets blocked and how a customer learns to
ignore the address invoices come from. So there is a cadence, a ceiling, and a
per-run cap — and after the ceiling the debt becomes a person's problem, which
is where something that has survived three polite emails belongs.

Each refusal is **named** rather than phrased, so the preview can say "14 are
not due yet" instead of printing fourteen sentences. The order of the checks
puts *wrong to chase at all* ahead of *wrong to chase today*, so an invoice
that is both settled and not yet due reports `settled`.

## Decision 2: off by default, and no backfill

This is the only automatic behaviour in the system that emails somebody who is
**not a user of it**, over a company's own name, with nobody present. A feature
that starts doing that because a deployment happened is one nobody agreed to.

So `chase_settings` has one row per company, absence means off, and the
migration creates no rows at all. The column defaults describe what a company
gets *when a person switches it on*, not what happens tonight.

## Decision 3: the anchor decides which chase, the gap decides whether any

The cadence is computed from the **due date** — chase *n* is owed once
`firstAfterDays + n × everyDays` have passed — so a worker that misses Tuesday
catches up on Wednesday rather than sliding the whole schedule a day later
every time something goes wrong.

That alone is wrong, and the test suite caught it before a customer did. The
proving case is the one that matters most: a company switches chasing on with
a year of unpaid invoices behind it. Every anchored date for every stage is
already in the past, so the first run sends chase one, the next sends chase
two, and a sequence meant to take six weeks arrives in three minutes. The
scheduler's at-least-once guarantee produces the same thing on any invoice far
enough past due.

So there are two rules and they answer different questions. The anchor decides
*which* chase is owed. The gap since the last send decides whether enough
silence has passed to send anything at all.

That gap is also what makes the job idempotent, and it is worth being precise
about why: **there is no "already chased today" flag.** `sendInvoice` stamps
`sent_at`, the second run reads it and declines. The state that prevents the
repeat is the same state that records the first send, so the two can never
disagree.

## Decision 4: a chase is an ordinary send

`runChases` calls Phase 42's `sendInvoice` — the same function the button on
the invoices screen calls. A chase is therefore recorded, counted, rate
limited, logged as a communication and audited exactly like a send somebody
made by hand.

The alternative was a chase-specific send path with its own counter, and it
would have been wrong twice: the customer cannot tell the difference, and a
second counter is a second answer to *how many times have we asked*.

The actor is the worker's `systemActor`, so the audit trail says *Scheduled
task* rather than putting the owner's name on an email they did not write.

## Decision 5: the preview is the screen

Nobody switches on a thing that emails their customers on the strength of a
description. So `/settings/chasing` leads with what would go out today and,
underneath, every invoice that would not — with the reason, by name, and the
date it next becomes due one. The settings are collapsed below that, because
the decision being made is *do I trust this*, not *what numbers do I want*.

The preview calls the same `planChases` the worker does. A preview that is a
second implementation is a preview that lies eventually.

## The three defects that were caught

**The whole sequence fired at once** — Decision 3 above. Caught by the
integration test on the second identical run, invisible to the pure tests
because each of them asked about one day.

**The preview was blank at exactly the moment it mattered.** Written to plan
against the stored policy, every row on a company that had not switched chasing
on read *"chasing is switched off"* — under a heading promising to show what
would go out if they did. The screen's only job, undone by the most literal
reading of the rules. `previewChases` now plans with `enabled` forced true and
hands the caller the real policy alongside; `policy_off` remains the correct
answer to *is this being chased* and is a useless answer to *what would happen
if I turned it on*.

**Nothing in the demo had ever been sent**, so the preview's entire content was
"never sent to the customer", eleven times — and Phase 42's Sent column had
been dead on the demo since the day it was built. The seed now sends the
invoices a business would have emailed and backdates them to their issue date.
Chasing is still left **off**, because the demo should show the default; what
it shows is a populated preview under an untouched switch, which is the
decision a real business actually faces.

## Consequences

- **A manual re-send consumes a chase.** `sendCount` counts letters, not
  chases, so somebody re-sending an invoice by hand shortens the automatic
  sequence. That is the right way round — the customer received another letter
  either way — but it is worth knowing.
- **No per-customer exemption.** A client who has asked not to be emailed can
  only be left out by clearing their address or switching chasing off
  altogether. A suppression list belongs here and does not exist.
- **The wording is Phase 42's reminder email**, unchanged by stage. A third
  chase reads exactly like the first, where a real business escalates.
  `stage` is computed and carried through the plan; nothing consumes it yet.
- **A bounce still reads as sent.** ADR 0038 left provider webhooks
  unconsumed, so an address that has stopped working is chased three times and
  reported as three successes.
- **Bills are not chased**, symmetrically with Phase 42: they are received.
- **Nothing chases a customer statement**, only individual invoices. A customer
  with nine overdue invoices gets nine emails on the same morning, which is
  worse than one statement — and the per-address hourly limit of twelve is the
  only thing standing between them and more.

## Follow-up

1. **One letter per customer, not per invoice**, using Phase 11's statement.
2. **Escalating wording by stage**, which is the field the plan already carries.
3. **A do-not-chase flag on a customer**, so a relationship can be handled by
   somebody without switching the feature off for everybody.
4. **Consume delivery webhooks**, so a chase to a dead address stops rather
   than repeating politely into nothing.
