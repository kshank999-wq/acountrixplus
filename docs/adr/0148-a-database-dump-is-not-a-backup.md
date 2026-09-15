# 0148 — A database dump is not a backup

**Status:** accepted
**Date:** 2026-09-15
**Phase:** 148

---

## How this was found

Not by measuring the code. By auditing `docs/SPEC.md` against it, on request,
after three phases of scanning had stopped producing findings.

Spec §19 asks for four things:

> Backups, point-in-time recovery strategy, retention policy, and tested restore
> procedure.

The retention policy is built — `RETENTION_POLICIES` has been a registry since
Phase 97. The other three did not exist **in any form**. `docs/DEPLOY.md` ran to
323 lines on deploying, secrets, domains, the worker, and what is still a mock,
and contained no occurrence of *backup*, *restore* or *recovery*.

For a system that holds other people's books, an undocumented and unrehearsed
restore path is the largest single gap in the specification, and the cheapest to
close.

## What the phase actually found

The interesting part is not that the section was missing. It is that **a
database backup is not a backup of this system**, and the argument for that was
already in the repository, written from the other side.

`secret-box.ts` says:

> A database dump — a leaked backup, a SQL injection, a misconfigured replica —
> yields ciphertext, and the key was never in it.

That is correct and it is well argued. It is also the exact reason a dump you
*keep* is insufficient: restore the database without `ENCRYPTION_KEY` and every
MFA-enrolled user is locked out of their own books permanently. AES-GCM
authenticates, so a wrong key fails rather than producing a plausible secret —
the row does not become wrong, it stops being data.

One file held both halves of that, and neither half mentioned a restore.

## Regenerable is the distinction that matters

Six things have to come back and they are not the same kind of problem:

| target | lives in | regenerable |
| --- | --- | --- |
| the database | Supabase | no |
| document bytes | `OBJECT_STORE_PATH` | no |
| `ENCRYPTION_KEY` | environment | **no** — the ciphertext dies with it |
| `VAPID_PRIVATE_KEY` | environment | **no** — every push subscription dies with it |
| `SESSION_SECRET` | environment | yes — everybody signs in again |
| `CRON_SECRET` | environment | yes — set it at both ends |

The test of the flag is whether you could change the value **on purpose on a
Tuesday**. `SESSION_SECRET` is the normal response to suspecting a leak.
`ENCRYPTION_KEY` is not, and neither is `VAPID_PRIVATE_KEY`: a new key pair
takes a minute to issue and kills every subscription the moment it exists, so
recovering the old one is cheaper than asking every user on every device to
enable notifications again. Nothing would have told anybody that was the choice.

`SESSION_SECRET` and `CRON_SECRET` are on the list **because** they do not
matter. A register whose entries are all emergencies is read as one
undifferentiated emergency, and `restoreStands` does not hold a restore open for
either of them — a checklist that cannot be finished is one nobody finishes.

## The question nobody should answer from memory

Whether anything lives outside the database is a **fact in** the database.
`document_blobs.storage_provider` records the adapter per row, and its own
comment already insisted on it: *"Read from here, never from the setting."*

```sql
select storage_provider, count(*) from document_blobs group by storage_provider;
```

`database` means the bytes are in `document_bytes` and the dump has them.
`filesystem` means they are under `OBJECT_STORE_PATH` and it does not. A company
that switched adapters has both, and both halves of its history matter.

So `restoreStands` takes `storesInUse` as a **measurement** rather than a
declaration, on ADR 0141's rule: the half that could excuse a target is the half
that has to be checkable. A company that stayed on the database adapter is not
told to go and find a directory, and that matters — a false alarm is how a
checklist gets ignored.

## What is run rather than asserted

The claim that `ENCRYPTION_KEY` cannot be regenerated is the whole argument, so
the test **performs** it: encrypt a TOTP secret, decrypt it back, swap the key in
the environment, and watch the decrypt throw. Phase 121's rule — a check only
ever seen to agree is not a check.

The restore procedure's own rehearsal has the same shape. Step 3 is *sign in as
a user who has MFA enrolled*, and it is called out as the step that catches a
missing key, because it is the only one that does: a restore missing
`ENCRYPTION_KEY` looks completely healthy until somebody with MFA tries to log
in.

Step 4 sends the operator to **Settings → Integrity**, which is the part that
makes a restore *sound* rather than merely present. Twenty-odd checks already
exist — `ledger.receivables` and `ledger.payables` prove the subledgers still
agree with the control accounts, `banking.cash_tie_out` proves the bank side
does. Writing a second set of restore-verification checks would have been the
defect this project keeps naming; the register was already there.

## What it caught in itself

Two things, both the same fault in different clothes, and both worth recording
because this phase is about a document nobody reads until the worst day.

- **The query was wrong.** I wrote `select distinct store from document_blobs`
  into the module, the test and DEPLOY.md, from reading a comment rather than
  the column. It is `storage_provider`. The test runs the query against the live
  schema, which is why it was caught before it shipped into the one document
  somebody follows under pressure rather than after.
- **The environment check looked in a list I typed.** It named four files by
  hand and failed on `SESSION_SECRET`, which is read somewhere else. It scans the
  tree now. That is the tenth instance of this family in this codebase and it had
  no business appearing in the test written to catch it.

## What this does not do

**It does not automate a backup.** The procedure is Supabase's point-in-time
recovery, which is a setting on a paid plan that somebody has to have turned on
*before* the day it is needed — hence the section beginning by checking it
rather than describing it. Nothing here schedules anything.

**It does not verify a restore automatically.** `restoreStands` takes what an
operator says they recovered. It is a checklist with teeth, not a monitor.

**The rehearsal has not been run against production.** It cannot be from here.
It is written to be run once now and once after any change to storage or
secrets, and it is written so that failing it costs a scratch project rather
than a company.

## What is nominated next

The isolation guards, already measured: **1,330** queries naming one of **159**
company-scoped tables, of which 271 have no `scoped()` or `companyId` in the
statement and 29 are writes keyed by an id argument. Every one is safe, by
**six** different mechanisms — `scoped()`, a conditions array, a scoped read
first, an owner-helper, a caller-established id, a system actor with no tenant
at all — and nothing records which one any given write stands on.

The README says isolation *"rests on `scoped()` at every query"*. That is the
same kind of sentence this phase found in `secret-box.ts`: true about the part
it describes and not true of the system.
