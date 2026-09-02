# 0089 — The preference that assumed a company

**Status:** accepted
**Date:** Phase 89
**Amends:** ADR 0008 (notification topics), ADR 0088 (the firm's morning brief).

## The defect

Phase 8 gave every notification topic a per-person on/off switch, for a reason
worth restating: *a channel nobody can quiet is a channel that gets filtered to
a folder, and then the one message that mattered is filtered with it.* The
switch is real, reachable at `/m/settings`, and honoured by `notify` before
anything reaches a provider.

It is keyed on `(user, company, topic)` with a **non-null** company, and every
function that reads or writes it takes an `ActorContext`, which names exactly
one company. The premise held for eight phases because every notification this
application sent belonged to a company.

**Phase 88 made it false.** The firm's morning brief belongs to a *practice* —
a third kind of owner, neither a company nor housekeeping. So the one channel
that arrives unannounced in somebody's inbox is the one channel with no switch,
and the machinery could not be pointed at it: there was nowhere to put the row.

ADR 0088 nominated this itself, as *"the shape of defect this project keeps
finding one phase after it is introduced"*.

## Decision 1: a preference names an audience, not a nullable company

The cheap fix is to drop the `NOT NULL` and let "no company" mean the practice
one. It is wrong twice.

It makes **"no company" a missing value** rather than a different owner, so
nothing in the schema says which firm the row is about — a person at two firms
could silence one and find both silent.

And two rows with a null company are **distinct** as far as an ordinary unique
constraint is concerned. That is the trap `installGlobalSchedules` already
documents for schedules: *"Postgres treats nulls as distinct in a unique
constraint, so calling this twice would create two rows rather than upserting.
Guarded by reading first, which is safe here because it runs at deploy time
rather than in a hot path."* A preference toggle is a hot path, and
read-then-write is not safe there.

So a row names an audience — exactly one of a company or a practice — with a
check constraint saying so, and a unique index over all four columns declared
**`NULLS NOT DISTINCT`**. The database arbitrates, and the upsert stays an
upsert.

## Decision 2: a topic belongs to one kind of audience

`TOPIC_AUDIENCE` is named data listing every topic against the owner it belongs
to. Not a default — listing them exhaustively means the next topic added has to
make the choice deliberately rather than inheriting one.

A company topic stored against a practice would be a row **nothing ever reads**,
which is worse than having no preference at all: the person set it, and believes
they are covered. `setPreferenceFor` refuses before writing.

The consequence is that the company settings screen now offers the company's
topics rather than all of them. A Phase 8 test asserted it offered *every* topic
— its stated intent being *"a topic the settings screen forgets is a
notification nobody can switch off"* — and that intent is exactly right and now
belongs across two screens. It is restated: every topic appears on exactly one
screen, asserted in `audience.test.ts` for both.

## Decision 3: per person, not per firm

One member of a firm wanting out is not the firm wanting out, so the brief
checks the switch for each recipient and skips only those who said no. The
handler reports `quieted` alongside `sent`, because a run that delivered one
letter of two should say why rather than look like a partial failure.

The control lives on `/practice` rather than in the company settings screen,
which is the honest place: it is not a company's business whether their
accountant reads their own firm's post.

## What this did not do

**Absent still means on.** Phase 8's rule is unchanged and deliberately so — a
person who installed the app has already opted in once, and making them opt in
twice is how a useful reminder never arrives. The brief keeps arriving until
somebody says otherwise; it simply became possible to say so.

**No per-topic screen for practices.** There is one practice topic, so the
control is one line on the roster rather than a settings page. When there are
three, `preferencesFor` already returns them all and the page is a loop away.

**Nothing was migrated.** Every existing preference row is a company row and
stays one; the new column is null for all of them, which is what the check
constraint already means.

## What the next phase might take

`notification_log` still has a `NOT NULL` company, so the brief — which is a
notification by every meaning except the transport it uses — is invisible to the
one table built to answer *"why did I not get told about that"*. ADR 0008 built
that log because the question *"needs an answer that is not a guess"*, and for
this channel the answer is now a guess: the letter is in `transactional_messages`
and the suppression is nowhere at all. A person who switched the brief off and
forgot has no way to find out that they did.
