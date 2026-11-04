# 0183 — The people on the proposal

**Status:** accepted
**Date:** 2026-11-04
**Phase:** 183

---

## The nomination held

Fourth of ADR 0173's eight measured gaps, and the last that is not §7's design
engine. The audit said:

> **Team bios (§15)** — `company_profiles.credentials` covers licences,
> certifications and insurance; bios have no home.

Measured and correct. `credentials` is a `jsonb` array of
`{kind, label, identifier?, expiresOn?}`, which covers licences,
certifications, insurance and memberships. A bio had no column anywhere, and
`memberships` carries a role rather than a person's story.

ADR 0182 also predicted the shape of the answer: *"the question to answer first
is whether a bio is a column, a table, or a block, and the answer is probably a
table because a firm has several people and a proposal names two of them."* It
is a table, for three reasons and the third is decisive.

## A table, not a `jsonb` array

`credentials` is the obvious neighbour to copy, and copying it would have been
wrong.

**A document has to point at one.** §15 ends *"brand assets feed both the
Proposal Designer and Marketing Creative Studio"*, so a proposal names two of a
firm's five people. A reference into a `jsonb` array has no key — which is the
argument Phase 180 made one phase after Phase 179 found a cross-tenant check
broken for nine phases, and the argument Phase 20 made when it moved receipts
out of an array because *"an array cannot answer 'which of these has no
paperwork?'"*

**A bio has a headshot.** That is a reference to `assets`, which means a
composite tenant key — and a foreign key out of a `jsonb` element does not
exist. `team_members_headshot_fkey` is `(company_id, headshot_asset_id) →
assets (company_id, id)` with `ON DELETE SET NULL (headshot_asset_id)`: the
column-list form, required because `company_id` is `NOT NULL` and cannot be
nulled with it. Deleting a photograph must not delete the person.

**A credential is a fact about the company; a bio is a person.** A licence
number has no photograph, no ordering anybody argues about, and nobody asks
which proposals it appeared on.

### Not `users`

The temptation is to hang a bio off `memberships`, since the firm's people are
mostly its logins. It is wrong in both directions: a founding principal who
never signs in still goes on the capability statement, and a bookkeeper with a
login does not. `user_id` is nullable, so a bio *can* name the account it
describes where there is one — which is what a future "write your own bio"
screen needs without making every bio an account.

## Retired, not deleted

`is_active` rather than a delete, for the reason the clause library already
argues: a proposal sent last year named the people who were going to do the
work, and somebody leaving must not change what a client was shown. The block
stores member ids, so deleting the row would either break an old document or
silently drop a name from it.

This is asserted by rendering, not asserted by comment: the test retires
somebody and then renders a block that names them.

It also decides the retention classification. `team_members` is `NEVER_SWEPT`,
and that is the sharpest entry on that list because **the table already makes
the argument in the other direction** — `is_active` exists so retiring does not
change old proposals, and a sweep would change them. A retirement flag and an
age policy would be two answers to one question, and one of them would be wrong.

## One pool, one selector

The first draft had `teamForDocument(companyId, ids)` returning *one block's*
members and `RenderData.teamMembers` holding them. That is wrong the moment a
document has two team blocks — both would be served the same list — and it is
the mistake Phase 181's table block made, which `document-render.tsx` already
warns about: *"Three renderers reading the raw rows is how one document becomes
three documents."*

So it is two functions:

- `teamForDocument(companyId, blocks)` reads the **pool** — the active
  directory plus any retired person a block names by id — in one query, from the
  blocks themselves.
- `selectTeam(pool, memberIds)` is pure, shared by the page, the PDF and the
  email, and does the choosing. An empty selection is the active directory; a
  named one comes back **in the block's order**, because an author listing two
  people has said who leads this pitch and the firm's standing order is a
  different fact.

`RenderedTeamMember` therefore carries `isActive`, and that field is load-bearing
rather than decorative: without it the pool and the default selection are the
same list, and a document saying "our team" would silently include the person
who left.

## Eight surfaces, and the editor is the one that matters

Phase 181's `BLOCK_SURFACES` named exactly what the eighteenth block type had to
satisfy, in advance, by file:

```
team is not handled at editor (src/components/design/block-editor.tsx)
team is not handled at web (src/components/design/document-render.tsx)
team is not handled at pdf (src/modules/pdf/layout.ts)
team is not handled at email-html (src/modules/marketing/render-email.ts)
team is not handled at merge-fill (src/modules/design/merge-fields.ts)
team is not handled at merge-detect (src/modules/design/merge-fields.ts)
team is not handled at designer-label (src/components/design/designer.tsx)
```

Seven lines instead of a block that renders as nothing somewhere nobody looks.
That register was written one phase after discovering three block types had
rendered everywhere and been configurable nowhere since Phase 5, and this is the
first phase it was in place for. It worked.

Three of the seven are honest degradations and each says so where it degrades:

- **The PDF does not draw headshots.** The writer places text and rectangles;
  a photograph dropped into a print-quality document at whatever resolution it
  happens to be is worse than a name set properly. `showPhotos` is honoured on
  the page and in the email and ignored here.
- **The email does not either**, for the reason `image` emits nothing: this
  renderer has no absolute asset URL to put in a `src`. The difference from
  `image` is that the rest of the block still carries its content, so this is a
  degraded section rather than a dropped one.
- **The email stacks**, ignoring `layout: 'grid'`, for the reason `columns`
  already gives: Outlook does not do grid and a phone shows one column anyway.

The two merge-field surfaces fill `title` and nothing else, which is the honest
answer — `memberIds` are ids and a bio comes from `team_members` — and it is
asserted so the no-op is a decision rather than an omission. `default:` would
have left `{{client.name}}` in a block title, in front of the client.

## The template whose description already promised this

`professional-engagement`'s description reads *"Approach, deliverables, team,
fees, and terms."* It had no team section of any kind.

That is ADR 0182's finding one level up. Phase 182 found four columns with no
reader; this is a **sentence shipped to users with nothing behind it** — and it
is in the one artefact a person reads before choosing a template. The §15 block
goes there and nowhere else: `standard-services` is the narrative reference,
`construction-bid` and `simple-estimate` do not claim it.

`memberIds: []` in the template, necessarily. A template is shared across
companies, so a hard-coded id would point at another tenant's person — which the
composite foreign key would refuse and nothing would explain. The empty default
is both the only correct value and the useful one.

## The scan that had never seen four writes

Updating the tree-wide counts found something that is not about this phase at
all.

`isolation-guards.test.ts` scans every `update`/`delete` on a tenant-scoped
table keyed by a caller-supplied id, and asserts each one has a guard. It
matched the table and its `where` with `[\s\S]{0,600}?` between them — so a
`.set({ … })` longer than six hundred characters pushed the `where` out of
reach, the statement did not match the pattern **at all**, and the write was not
counted.

Four writes were in that state:

| write | table | since |
| --- | --- | --- |
| `changeStage` | `opportunities` | Phase 6 |
| `issueToken` | `action_tokens` | Phase 102 |
| `billStage` | `proposal_schedule_stages` | Phase 154 |
| `updateTeamMember` | `team_members` | this phase |

All four are correctly guarded, which is the only reason this is a measurement
defect and not a disclosure. But the file whose single job is to say so had
never looked at them — and `changeStage` moves every opportunity in the system.
Phase 160's shape exactly: a control that does not fire.

The fix is not a bigger number. `enclosingQuery` is Phase 152's boundary and
exists for precisely this; its own docstring records ADR 0134 replacing a
fixed-line window *"because the window leaked and excused a real defect"*. The
reads scan has used it since Phase 150. This half was still counting characters.
The count goes 112 → 118: two new writes, four that were always there.

A fixed window would also have been *enough* at 900 characters. It was not
chosen, because a magic number that happens to be big enough today is the thing
that was wrong yesterday.

## What this does not do

**No headshot upload flow.** `headshotAssetId` is a column, the composite key
protects it, the page renders it and the Design Center screen does not set it
yet — a person uploads in the asset library and there is no picker on the team
row. Stated rather than implied, because this is a `PENDING_WIRING`-shaped gap
and the honest version of it is a sentence here.

**No per-person "write your own bio".** `user_id` is nullable and nothing sets
it. The column exists so that screen does not need a migration; it is not that
screen.

**The isolation-guard distribution sentence drifted again.** `PINNED_CLAIMS`
holds twelve measured numbers and one declared unmeasured, because the read and
write scans live inside two test files and nothing outside them can ask for the
number. It read *"542 of the 911 reads, against 28 of the 111 writes"* against a
measured 562 of 916 — stale since Phase 180, exactly as the declaration said it
would be. Phase 157's rule says an unused declaration is kept when it **accuses**
and deleted when it excuses: this one has now watched itself go stale twice,
which is the argument for moving those scans into `src/modules/source/` rather
than a reason to stop declaring it.

## Nominated for Phase 184

**`document_links`, away from twelve keyless polymorphic subject references.**

It is nominated now because three phases have made the case and the fourth
would just be repeating it. `document_links` uses a `subject_type` enum and a
`subject_id`, and its own docstring says what that costs:

> A polymorphic reference has no foreign key, so nothing in the database stops a
> link pointing at a uuid that belongs to another company — or to nothing at
> all. The check has to live in code.

Phase 180 declined that precedent for `asset_links` and built five composite
keys and a CHECK instead; Phase 183 added a sixth composite key for a headshot
without arguing it, because by now the argument is settled. What is left is the
table that still has the old shape, carrying **evidence** — which is the one
category where "the check lives in code" is least acceptable, because §19 is
about auditability and an auditor cannot read a function.

Behind it: §7's four remaining design-engine pieces (crop/mask, SVG, artboard
affordances, vector primitives), the client-link comment thread, and moving the
read and write scans into a module so the thirteenth pinned claim can stop being
the thirteenth pinned claim.
