# 0074 — Whose letter is it

**Status:** accepted
**Date:** Phase 74
**Amends:** ADR 0073 (the mark), ADR 0005 (campaigns), ADR 0019 (transactional mail).

## The defect

ADR 0073 nominated this: `modules/notify` and `modules/pdf` write `'Accountrix
Plus'` as a literal rather than reading `BRAND.full`. That was true, and it was
the smaller half of what was there.

Grepping the string found it in **six modules and sixty-eight pages**, and it
meant **three different things**:

| Meaning | Where | Verdict |
| --- | --- | --- |
| *This letter is from the product* | authenticator issuer, reset subject, invitation body, transactional `From:`, communications-log actor, PDF `/Producer` | correct, but written six times |
| *We do not know whose letter this is, so use ours* | `marketing/campaigns.ts` `fromName` | **wrong** |
| *We do not know whose workspace this is, so use ours* | `session?.companyName ?? 'Accountrix Plus'`, ×77 | **wrong**, and never reachable |

One string, three meanings, and two of them defects. This is the shape Phase 70
removed from the words for corrections and Phase 73 removed from the mark; here
it is again in the sentence the product uses to say who is speaking.

## The rule

> **A letter is either ours or theirs. Ours may carry our name; theirs never
> may.**

`modules/brand/voice` holds it. `OUR_NAME` is what the product signs its own
post with. `senderName({ chosen, legalName, companyName })` is the name on a
letter a **company** sends, and it is written so that it *cannot* return
`OUR_NAME`: the chain ends at `companies.name`, which is `NOT NULL`.

Pure — no database, no clock.

## Decision 1: a company's marketing goes out under the company's name

```ts
// before
fromName: campaign.fromName ?? profile?.legalName ?? 'Accountrix Plus'
```

That is a marketing campaign a business sends to its own contacts, over its own
unsubscribe link. `campaigns.ts` read `companyProfiles` — a separate, optional
table with a nullable `legal_name` — and **never loaded `companies`**, whose
`name` is `NOT NULL` and exists from the moment a tenant registers.

Two states reach the end of that chain, and they fail differently:

- **The legal name was cleared.** Onboarding writes a profile whose legal name
  is the company name, so the `?? 'Accountrix Plus'` branch looked unreachable.
  It is not the branch that fires. The Design Center's Legal name box is
  `z.string().trim().max(200).optional()` with no `.min(1)`, and the form is
  controlled and seeded with `profile.legalName ?? ''` — so clearing the box
  saves `''`. `''` is not null, `??` does not fall through, and every campaign
  that company sent went out **from nobody**. This is the reachable one.
- **There is no profile row, or its legal name is null.** A company that arrived
  any way other than through onboarding. *Here* the old chain signed a
  business's marketing with **our** name, to its own customers.

`senderName` closes both: blank is not a choice, and the last resort is the
company, not us. `{{company.name}}` in a creative gets the same treatment — it
resolved to the *legal* name, and to nothing at all without a profile.

## Decision 2: the fallback nobody chose is deleted, not improved

Sixty-eight pages wrote `session?.companyName ?? 'Accountrix Plus'`, seventy-
seven times. Nobody decided it. `currentSession()` is typed `Session | null`,
every one of those pages calls `requireActor()` first — which redirects when
there is no session — and that is what you write to make the type checker stop
arguing.

It put our name in the one place on the screen that answers *whose books am I
in*: the account card at the foot of the rail, which exists, in its own words,
for "the moment before somebody types a number into the wrong company's ledger".

The branch was unreachable, so the fix is not a better fallback. `requireSession()`
returns a session or redirects, exactly as `requireActor()` already did, and the
seventy-seven fallbacks become `session.companyName`. A defect that cannot be
written is better than one that is written correctly seventy-seven times.

The same expression was also the MFA issuer — `issuer: session?.companyName ??
'Accountrix Plus'` — where the fallback was *right* by accident: an authenticator
app should name the workspace, and name us only when no workspace is known.
That default now lives once, in `beginEnrollment`, as `opts.issuer ?? OUR_NAME`.

## What this did not do

Nothing in the ledger, no migration, no schema. The PDF `/Producer` still names
us and the `/Author` still names the company, which is the same rule read from
the other end: we made the document, they own it.

The `'Accountrix Plus'` that remains in `app/layout.tsx` and in prose on the
marketing pages is the product talking about itself on its own site, which is
the one place the literal is the subject rather than a fallback.

## What the next phase might take

`z.string().trim().max(200).optional()` with no `.min(1)` is why a legal name
could be cleared to `''` at all, and the Design Center profile has **thirteen**
fields shaped exactly like it. Whatever else reads them — the invoice PDF's
letterhead, the proposal footer, `{{company.email}}` — has the same hole one
level down: a field that is present, empty, and therefore not defaulted.
