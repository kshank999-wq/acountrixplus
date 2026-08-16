# ADR 0018 — Access is granted, never claimed

- **Status:** Accepted
- **Date:** 2026-08-16
- **Context:** Spec §14 ("Accountant practice mode can later allow one
  accountant to switch securely among multiple client companies"), §19
- **Builds on:** [ADR 0001](0001-modular-monolith-and-tenancy.md),
  [ADR 0013](0013-a-stolen-password-is-not-enough.md)

## Context

§14's last deferred sentence, and the one the whole tenancy design was built to
survive.

Since Phase 1 every service in this codebase has taken an explicit
`ActorContext` and there has been no ambient "current company" anywhere. That
decision cost something on every function signature for eighteen phases, and it
was made for a case that did not exist yet: a human who legitimately belongs to
twenty companies at once. An accountant is that human, and this is the first
time the design is actually tested rather than merely asserted.

Two claims:

1. **Access is granted, never claimed.** Whichever side asks, the *other* side
   has to agree.
2. **One company at a time.** Switching mints a new context rather than a wider
   one.

## Part one: two signatures

### Decision 1: whoever asked cannot be whoever agrees

`practice_engagements.initiated_by` records which side asked, and
`respondToEngagement` refuses when that side tries to accept. One comparison,
no flag that turns it off, and `tests/practice.test.ts` asserts both
directions.

The alternative — "the firm adds the client and the client is notified" — is
how a support tool ends up able to read every customer's ledger. More
mundanely, it is how one mistyped email address hands a stranger the books.

Symmetric on purpose. A firm that finds itself holding books it never agreed to
hold has taken on a liability nobody asked it about, so a company cannot
conscript an accountant either.

### Decision 2: an engagement grants memberships and then steps out of the way

Accepting an engagement materialises a `memberships` row for each practice
member, tagged with the engagement that created it. Everything downstream —
permissions, the audit log, session resolution, `scoped()` — already understood
memberships and needed no changes at all.

The alternative was to derive access at read time by checking engagements in
the session hot path. That gives *two* answers to "can this person see these
books", and two answers can disagree. One table grants access, and it is the
one that has granted access since Phase 1.

Tagging matters as much as materialising: ending an engagement removes exactly
the memberships it created. A sweep by "everybody from that firm" would also
remove the bookkeeper who works at the firm *and* was hired directly by the
client — a real arrangement, and one where the two grants are independent. A
test asserts the directly-hired one survives.

### Decision 3: the client's decision caps the firm's

A practice member has a `defaultRole`; an engagement has a `grantedRole`; the
membership gets the narrower of the two. A firm that would like its people to
be owners still arrives as whatever the client agreed to.

`narrowerOf` orders roles by *ledger reach* rather than importance — `sales`
and `bookkeeper` are not comparable on any single axis, and where neither
contains the other the engagement's cap wins, because it is the client's
decision.

### Decision 4: ending it is asymmetric, and deliberately so

Starting an engagement needs both signatures. Ending one needs either. **A
client must never need their accountant's permission to take their books
back.**

Revocation takes effect on the *next request*, because `resolveSession`
re-reads the membership every time — a decision made in Phase 13 for a
different reason, and this is what it turned out to be for. A test signs a
session in, ends the engagement, and asserts the same session resolves to null
immediately afterwards.

### Decision 5: leaving the firm ends access everywhere at once

One revocation, not forty. Somebody who leaves an accounting firm on Friday
should not still be able to read a client's ledger on Monday because one
company got missed. Symmetrically, a firm that hires a bookkeeper on Monday
expects them to work on Tuesday — the alternative is re-inviting them at forty
clients one at a time, which nobody does, so instead everybody shares a login.

## Part two: one company at a time

### Decision 6: the context still names exactly one company

Switching replaces the name in the session; it does not add a second. Every
`scoped()` call written across eighteen phases keeps working unchanged, because
none of them ever asked "which companies may I see" — they asked "which company
am I in", and there is still exactly one answer.

A context carrying a *set* of company ids would mean re-reading every query in
the application to decide whether it meant one or many. That is a review of
several hundred call sites where a single missed one leaks a client's ledger to
another client's accountant.

### Decision 7: exactly one query crosses tenants, and it is built not to be pointed anywhere else

`practiceWorkQueue` is the one exception, and it has to be: the whole value of
practice mode is seeing forty clients at once, and a page that made an
accountant click into each one to find out whether there is anything to do is a
page nobody opens.

Four things make it safe, and they are all structural rather than diligence:

- The company set is derived **inside the function** from the caller's own
  memberships. There is no parameter that can widen it.
- Practice membership is checked **before anything is read** — a gate, not a
  filter, so a guessed practice id returns nothing rather than another firm's
  client roster.
- Each client's count is a **separate query naming a company already proven
  reachable**. One grouped query over every company is the version that, with a
  filter typo, returns the entire database.
- It returns **counts, not rows**. An accountant triaging a backlog needs a
  number, not a page of somebody else's transactions in books they have not
  entered.

### Decision 8: the audit log names the firm

An accountant's actions are attributed as "Dana Chen (Hartley & Co)". The
client reading their own audit log should not have to cross-reference a user
list to discover that whoever reopened December works for their accountants.

`viaPractice` rides on the `ActorContext` and changes what an event *says*,
never what anybody may do — the role does that, and the role was capped by the
client when the engagement was accepted.

The switch itself is recorded **in the company being entered**. "Who opened our
books, and when" is the client's question; filing it in the accountant's own
company would put it where the person it concerns cannot read it.

### Decision 9: a person can now exist without a company

Until this phase every user arrived by registering a business. An accountant
breaks that: they sign up to run a *practice* and may never own a company at
all. `registerUser` is the new door, and `resolveSession` correctly returns
null for a session with no active company — this user can sign in and has
nowhere to go until a client grants them somewhere.

## Consequences

- **A practice member reaches every client of the firm.** There is no per-client
  staff assignment, so a firm that wants one junior on one client and not the
  other cannot say so. This is the largest gap in the phase and the most likely
  next request.
- **Engagements are found by name, not by invitation link.** A client searches a
  directory of practices and offers access; there is no emailed token, because
  there is still no email provider wired for transactional mail. It means a
  firm must already exist in the system before a client can invite them.
- **The practice directory is public to signed-in users.** Name and contact
  email only — a directory that revealed how many clients a firm has would be a
  competitive-intelligence feed — but a firm cannot opt out of being listed.
- **No practice-level MFA policy.** A client can require a second factor of
  everybody in *their* company (Phase 13), and that does cover practice members
  once they hold a membership. A firm cannot impose its own policy on its staff.
- **The work queue counts one thing.** Transactions awaiting review is the
  universal backlog, but a firm chasing period-end wants unreconciled accounts,
  open close tasks, and unposted drafts as well.
- **No client grouping or tags.** Forty clients is a flat list.
- **Switching always lands on the transaction inbox.** The page you were on in
  one company is rarely the page you want in the next, and a deep link that
  happens to exist in both would silently change whose figures you are reading —
  but somebody moving between the same report at four clients pays for that.
- **A practice cannot be deleted**, only deactivated, and nothing in the
  interface does even that.

## Follow-up

1. **Per-client staff assignment**, so a firm can put one person on one client.
2. **Invitation by email**, which needs the transactional email provider that
   password reset has been waiting on since Phase 13.
3. **A richer work queue** — unreconciled accounts, open periods, drafts
   awaiting a decision, not only the transaction backlog.
4. **Practice-level security policy**, so a firm can require MFA of its own
   staff rather than relying on each client to.
5. **Client tags or groups**, for a firm whose list has outgrown a single page.
