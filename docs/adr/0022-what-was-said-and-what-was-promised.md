# ADR 0022 — What was said, and what was promised

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §16 (`Communication`, `Task` in the core data model), §6
  ("Every opportunity stores … communications, files, and activity history"),
  §10 ("engagement can create tasks"), §17 ("Notification/Task Service")
- **Builds on:** [ADR 0003](0003-crm-and-public-intake.md),
  [ADR 0019](0019-a-reset-is-not-marketing-and-an-invitation-carries-no-password.md),
  [ADR 0020](0020-one-file-stored-once-reachable-only-through-a-record.md)

## Context

§16 lists the core data model entity by entity. Every one of them existed by
Phase 21 except two: `Communication` and `Task`.

`Task` existed as half a table — written only by marketing engagement, read
only by the marketing overview, reachable from one screen nobody in sales
opens. `Communication` did not exist at all, which meant §6's requirement that
an opportunity store "communications, files, and activity history" was met on
two of three counts: files arrived in Phase 20, activity history has existed
since Phase 3, and what anybody actually *said* was nowhere.

Two claims, asserted in `tests/engagement.test.ts`:

1. **Every letter the system sends is recorded against the person it went to**,
   in the same log a hand-logged phone call goes in.
2. **A task is never silently lost** — it survives without an owner, it
   surfaces when it is late, and closing it twice closes it once.

## Part one: communications

### Decision 1: an activity is not a communication

`opportunity_activities` records what the *software* did — a stage changed, a
proposal was sent, a lead arrived. It is complete, it is generated, and nobody
writes it. A communication records what a *person said to somebody outside the
company*. It is written by hand, incomplete by nature, and it is the thing
somebody reads before picking up the phone.

They are stored separately for one practical reason: merged, the useful half —
three sentences somebody typed after a difficult call — scrolls out of sight
behind forty automatic stage changes. Same distinction Phase 20 drew between
the audit log and an accountant's note.

They are *shown* together, which is the point of the timeline. Separate
storage, one view.

### Decision 2: real foreign keys, not the Phase 20 registry

Phase 20's evidence links hang off eleven kinds of record through a subject
registry, because a receipt genuinely can belong to a bill or a payroll run or
a fixed asset. Reusing that here would have been the tempting symmetry and the
wrong call.

A communication is always with a *party*: an organization, one of its people,
and optionally the deal being discussed. Those are three columns the database
can enforce with foreign keys. The registry would have made "log a phone call
against a bank transaction" expressible, and a polymorphic reference cannot be
constrained — Phase 20 accepted that cost because it had no alternative. Here
there is one.

A CHECK requires at least one party. A row naming nobody belongs to no timeline
and appears on no screen, which is a silent way to lose what somebody wrote
down.

### Decision 3: the client is derived from the person, and from the deal

Somebody logging a call against the contact they spoke to should not also have
to name the company that contact works for. If they had to, half the log would
be missing it and the client timeline would be full of holes. `logCommunication`
fills the organization from the contact or the opportunity when it is not given.

The read side does the same job from the other end:
`communicationsForOrganization` matches exchanges filed against the client, and
against its contacts, and against its deals. A query that only matched the
direct column would show an empty page to somebody who had just written three
entries.

`createTask` derives it the same way, and for the same reason — the first
version did not, and the seed showed exactly what that costs: two promises made
on the Summit deal appeared on no client timeline and carried no name on the
board. A rule applied to one of two tables is not a rule.

### Decision 4: when it happened, not when it was typed

A call logged on Monday about Friday's conversation belongs on Friday. The form
asks for a date rather than a timestamp, because somebody recalling last week
knows the day and not the minute, and asking for the minute gets a made-up one.

### Decision 5: an internal note is not contact

`lastContactedAt` excludes `internal`. "Must remember to call these people" is
worth writing down and is not evidence of having called them — counting it
would let a team convince itself it had spoken to somebody it had not.

### Decision 6: transactional mail is recorded, campaigns are not

Phase 19 logs every send in `transactional_messages`, which answers "did the
mail go?" and knows nothing about the CRM. Phase 22 joins the two: when a
letter goes to an address belonging to a known contact, it lands on that
contact's timeline beside the calls.

Campaign sends are deliberately excluded. `campaign_recipients` already records
every marketing send per contact with opens and clicks, and mirroring those in
would put a row on every recipient's timeline for every newsletter. A log where
the quarterly mailshot outnumbers the three sentences somebody typed after a
difficult call is a log people stop reading. Transactional mail is individual,
deliberate and rare — which is what belongs on a timeline.

### Decision 7: recording a letter can never fail sending it

`recordOutboundMail` catches everything and returns null. The letter is what
matters; a missing timeline entry is not worth failing a password reset for.

Catching is only half of it. Postgres aborts a whole transaction on any failed
statement, so a swallowed exception inside the caller's transaction would leave
it holding a connection where every later statement fails too — and an
invitation would be lost to a bookkeeping row nobody asked for. The work runs in
a nested transaction, which drizzle emits as a savepoint, so a failure rolls
back to the savepoint and the caller carries on. A test writes a communication
after a deliberately-failed record, inside one transaction, to say so.
It also takes a plain `companyId` rather than an `ActorContext`, because the
sender is the system — attributing an automatic send to whoever happened to
trigger it would put their name on a letter they never wrote.

### Decision 8: no audit event for a communication

A communication *is* the record. Auditing it would file a second row saying
"somebody wrote a row". The audit log covers privileged actions, and writing
down a phone call is not one.

## Part two: tasks

### Decision 9: the existing table, not a second one

Phase 5's `tasks` gained columns rather than a successor. A follow-up raised by
a campaign and one somebody typed are the same kind of thing, and two tables is
how the first stops appearing on the list anybody reads.

### Decision 10: unassigned is a state, not an omission

"Somebody should call them back" is real, and forcing an assignee at creation
turns a note to the team into a note to whoever happened to be typing. So
`myWork` includes unclaimed work by default: a task nobody owns is everybody's
problem, and hiding it until somebody claims it is how it stops being anybody's.

### Decision 11: closing is a claim, not an update

`WHERE status = 'open' … RETURNING` — the same shape as Phase 15's billed-once
clause and Phase 19's token redemption. Two people closing the same follow-up
at once produce one completion and one honest refusal, rather than a second
`completedAt` overwriting the first and the "done this week" count quietly
gaining a row.

### Decision 12: a finished task carries a finish time, enforced

`CHECK ((status = 'open') = (completed_at IS NULL))`. Without it a half-failed
completion leaves a row that is open and has a completion date, and every count
of "done this week" disagrees with every list of open work. Cancelling stamps
the time too, because a cancelled task is finished — and it keeps its reason,
because a task that simply vanishes teaches nobody anything.

The migration backfills existing rows into shape before adding the constraint.
Nothing in Phase 5 could produce either bad shape, but a constraint added to a
live table has to survive whatever is already in it.

### Decision 13: overdue is measured against a date, not the clock

`openWork` and `workSummary` take `asOf`. Same rule Phase 21 applied to the
PDF's timestamp and for the same reason: a report that reads the clock cannot
be run for last Tuesday and cannot be asserted on.

### Decision 14: closing is undoable from the screen that closes

`closedWork` exists so the Done button has a list of what it has done, and a
Reopen beside each row. Without it one mis-click is permanent, `reopenTask` is
reachable only from a test — which is another way of saying it is not built —
and the honest description of the board would be that a task *can* be silently
lost: by being closed.

Done and dropped sit in the same list because both are finished, and both keep
what was said about them. The window is a parameter passed to the list and to
the count above it from one place, so the two are counted over the same week —
a header that disagrees with the list under it is worse than no header.

## Consequences

- **Inbound mail is not captured.** A reply from a client has to be logged by
  hand. There is no IMAP connection, no forwarding address, no threading — the
  log records that somebody replied, not the reply.
- **No reminders.** An overdue follow-up surfaces when somebody opens the page.
  The Phase 10 queue and Phase 8's push notifications both exist and neither is
  wired to this, so a task due Friday nudges nobody on Friday.
- **Communications carry no attachments yet.** Phase 20 can attach a document to
  eleven kinds of record and `communication` is not one of them, so "here is the
  quote I emailed them" is a sentence rather than a file.
- **No per-contact consent check on the log.** Recording that a marketing email
  went is separate from consent, which Phase 5 enforces at send time — but
  nothing here re-checks it, so a communication row can outlive the consent that
  justified it.
- **Campaign sends are invisible on the timeline**, deliberately (Decision 6),
  which means "why have we not heard from them since March?" will not show the
  four newsletters they were sent. The marketing workspace answers that.
- **Tasks have no recurrence and no dependencies.** A quarterly check-in has to
  be raised four times. This is a follow-up list, not a project-management
  surface, and the line is deliberate.
- **The timeline merges in memory.** Each source is capped, then the merge is
  capped, so pagination is approximate past sixty entries. A `UNION` would need
  a lowest-common-denominator row and every source would lose the columns worth
  showing.
- **An open task's timeline position is its due date**, which means a follow-up
  dated next year sits at the top of the history. That is right for "what is
  outstanding" and surprising for "what happened when".
- **No timeline on a contact or a job**, only on a client and a deal. The data
  supports it; the screens do not exist.

## Follow-up

1. **Wire overdue follow-ups to the Phase 10 queue**, and to the Phase 8 push
   channel, so a promise made on a call is chased without somebody opening a
   page.
2. **Attachments on communications** — one row in the Phase 20 registry.
3. **Inbound email capture**, which is the largest single gap and needs a
   provider decision before it needs code.
4. **A contact timeline**, and one on a job, from the same query.
5. **Recurring follow-ups**, for the quarterly check-in that is currently
   raised by hand four times a year.
