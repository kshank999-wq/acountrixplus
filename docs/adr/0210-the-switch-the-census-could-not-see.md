# 0210 — The switch the census could not see

**Status:** accepted
**Date:** 2026-11-12
**Phase:** 210

---

## The nomination, measured

ADR 0209 nominated **an employee who cannot leave**, and for the first time in
this run of phases it came with its measurement already done: `employees` has
one insert and no update, so `is_active` and `end_date` have no writer.

That holds. `grep` confirms it in one line, and it is the smaller half.

The nomination also named the second half, which is what this phase turned out
to be: *"the column census cannot see either of them, since a
`select`-then-`filter` in JavaScript never writes the `table.column` string the
scan's read rule looks for. The question this raises is how many more sit
behind the query shape rather than behind the exclusion. That is a number to
measure before anything is built on it."*

**Seventy-two.** Sixteen of them written by nothing.

## The rule that was costing findings

`writerCandidates` asks which columns something reads that nothing writes. Its
test for *read* is `tableVar.column` named outside the schema, on the sound
argument that drizzle spells a projection, a `where` and an `orderBy` the same
way, so naming is the honest proxy for reading.

A projectionless `select()` compiles to `select *`. It reads **every column of
the table** and names none of them, and the row's columns are then reached as
properties — `row.isActive`, `profile?.country` — which carry no table to key
on. And the skip happens first:

```ts
if (info.systemSet) continue
if (!named.has(`${tableVar}.${column}`)) continue   // ← here
if (settable.has(`${tableVar}.${column}`)) continue
```

So a column no query named could not be a candidate **however unwritable it
was**. The seven mechanisms this register documents all hide a *writer*, which
makes the scan over-report and each entry argue one down. This one hid a
*reader*, so the scan under-reported and said nothing at all.

Phase 202 narrowed the exclusion for defaulted columns and closed *"all six
`isActive` switches"* that narrowing exposed. The exclusion was never what hid
the rest. The shape of the query was.

## The paragraph that had the observation and the wrong conclusion

Phase 203 found this mechanism. In the right file, with the right example:

> `writerCandidates` uses "named outside the schema" as the test for *read*,
> which is **conservative in the safe direction — a missed read loses a
> candidate**. Inverted it becomes the exclusion test, and a single `.select()`
> with no projection reads every column of a table while naming none:
> `recentRequests` in `ai/settings.ts` is one, so every column of `ai_requests`
> looks unread. Measured, the mirror reports 683 columns, which is the size of
> the error rather than a finding.

Everything in that is true except the clause in bold. A missed read does not
lose a candidate; it loses a **finding**. The forward census does not report
carefully, it reports nothing — and one of this phase's sixteen is
`ai_requests.cacheHit`, on the very table that paragraph used as its example.
Seven phases, in a file that names the defect, pointed the other way. The
sentence is corrected in place rather than left to be rediscovered (Phase 179).

## The class, measured — and the control that matters

Thirty tables carried an `isActive`. For each, two independent questions: does
any `.values(` or `.set(` mention the column, and does any query name it as
`table.isActive`.

| | writer | no writer |
| --- | --- | --- |
| **named by a query** | 24 | 0 |
| **never named** | 1 | 5 |

Every defect of the class sat inside a blind spot covering six tables of
thirty. The sixth is the control and is the reason this is stated as a
correlation rather than a cause: **`cost_codes` has the identical shape** —
`listCostCodes` selects every row and filters `row.isActive` in JavaScript — and
`updateCostCode` writes the column anyway. The query shape does not cause a
missing writer. It hides whether there is one, and five times out of six there
was not.

Without that cell the table would read as *the shape causes the defect*, which
is the kind of claim this project has had to withdraw before (ADR 0208's
headline, measured, was wrong at every call site).

## The two columns this register was created for

The sharpest finding is not an `isActive`.

Phase 201's own docstring explains why the register exists:

> Phase 200 set out to give one prompt the company's own words and found a
> column with no editor. The narrow check written for that — a form's field
> list against the table's columns — **named two more on its first run**, and
> both were worse: `letterhead.ts` reads `addressLine2` and `country` and puts
> them on every document a client sees, so a business with a second address
> line could not put it on its own letterhead.

All three got a **field** on the Design Center form, with a comment saying so.
None of them got a **place to land.** `saveProfileAction`'s schema declared
thirteen keys of sixteen, and a zod object *strips* what it does not declare
rather than refusing it — so a company could type its second address line,
press Save, read *"Company profile saved."* and have the value dropped at the
boundary. `ProfileInput` was missing two of the three as well.

So `addressLines()` builds a four-line envelope block of which two lines could
never be filled, on every invoice, quote and statement; and §11's *adapt
content to company voice* had no voice to adapt to, which is precisely what
Phase 200 set out to fix.

**Why it survived.** The tripwire Phase 200 left behind asserts that
`PROFILE_FIELDS` covers the profile's text columns, and it passed throughout —
a form is one of the three places a field has to exist. The test that proves
the module works calls `saveProfile` directly, so it proved the module. The
column census could not report the columns because `getProfile` is a
projectionless select. Three checks, each correct about its own segment, and
nothing looking along the path.

The test now holds the chain: every field on the form is a key the action
accepts and a property the service's input type has.

## What was closed, and in what order

The order is the readers', because what a column is read *for* is what the
absence costs.

**`practitioners.isActive`** first, because the guard was already written:

```ts
if (!practitioner.isActive) {
  throw new AppointmentError(`${practitioner.name} is no longer taking appointments.`)
}
```

The column defaults to `true` and had no writer, so that branch has been
unreachable since Phase 3 and the message has never been shown to anybody. The
booking picker filters on the same flag and had never excluded anybody. A
refusal nothing can trigger is worse than a missing one, because reading the
booking path tells you a stood-down practitioner cannot be booked. ADR 0204
closed `cash_drawers.isActive` and `practices.isActive` and called them *"the
other two **enforced** switches"*. There was a third.

Standing somebody down stops **new** bookings and leaves the diary alone: each
appointment in it is a commitment to a client, and cancelling one is a decision
about that client, with a reason and possibly a refund.

**`employees.isActive` with `end_date`** as one act, so a date and a flag cannot
give two answers to *has this person left* (Phase 70). A **future date is
refused** rather than scheduled: `is_active` is stored, and a departure dated
next month would need something to come along and flip it, which nothing would —
the flag would read `true` beside a leaving date already in the row, which is
the defect this phase removes rather than relocates. A constraint beats a state
machine nobody winds (Phase 116). The limitation is declared.

And `createPayrollRun` refuses a payslip for somebody who left before the period
opened. This is the check ADR 0208 said was missing — it was, and it could not
have been written, because the guard would have read an always-null column. The
list it reads stays **unnarrowed** deliberately and the guard is on the date:
somebody who left on the 14th is owed the run that covers the 14th, so
filtering on `isActive` here would have refused the one payroll run that matters
most while looking like a tightened check.

The index on this table is `(company_id, is_active)`. The schema was built to
serve a filter the application never ran against the database and could never
have made false.

**`tax_codes.isActive`**, which Phase 209's own comment called inert beside the
picker that passes it. Retiring stops a code being offered and touches nothing
already priced, because every `document_tax_lines` row carries the `rate_bp` it
was priced at (ADR 0021). `effective_to` deliberately keeps **no** writer:
retiring a code and superseding a rate from a given day are different acts, the
second needing the successor to exist and `priceDocumentTax` to choose between
them by date. Half a meaning would be worse than a declared finding.

**`company_profiles.addressLine2` and `country`**, as above.

## What was removed rather than closed

`segments.isActive` and `vehicles.isActive` had no writer **and no reader** —
not a query, not a filter, not a screen, not a badge. That is Phase 49's shape,
and the honest answer for one is a migration:

- a control to justify a column is inventing a requirement, and
- leaving the column is leaving a promise in the schema that a segment or a
  vehicle can be turned off.

`segments_company_idx` existed to serve a filter on the column being dropped and
is rebuilt on `(company_id, name)`. `vehicles.isActive` is the one even the
corrected scan does not report, because nothing fetches it either.

## The exclusion that was excusing a site

`tests/a-voice-to-adapt-to.test.ts` left `credentials` out of its form check as
*"a structured list with its own editor and its own add/remove controls"*. There
is no such editor. Nothing writes the column and nothing reads it — and
`modules/studio/team.ts` cites it as the reason §15's certifications are
covered: *"the measurement held: `company_profiles.credentials` covers licences,
certifications, insurance and memberships"*.

An exclusion that **excuses** a site is worse than one that misses it, which is
ADR 0134's rule, in the test that cites ADR 0134. It stays out of that check — a
jsonb list of licences is not a text box — and the reason now points at the
register that holds it as a finding, so the claim is tested somewhere rather
than asserted in a comment.

## The verdict that was kept

`unwritable` was created in Phase 201, emptied in Phase 208, and kept on Phase
157's rule that an unused declaration stays when it *accuses*, with the argument
that a register with no word for a finding cannot report the next one.

Two phases later it was needed fourteen times. Had it been deleted as dead code,
this phase would have had to invent the word before it could record anything.

## What this does not do

**It does not fix the sixteen.** Five were closed and two removed; the rest are
declared with the verdict, each naming what reads it, because a finding whose
reader is nothing is a smaller problem than a finding whose reader is a
client-facing document. The largest is `bill_lines.itemId` — Phase 169's
inventory gap on the **purchase** side, so a stocked item bought through a bill
still receives no stock.

**It does not narrow the insert-only class.** That number moves from 770 to
**1169** under the same correction, which is a measurement of how badly the
limitation was understated rather than a change to it. Narrowing it still needs
a way to say which columns are *state* rather than *record*.

**It does not rewrite the two queries that hid the switches.** `listEmployees`
and `listTaxCodes` still select every row and filter in JavaScript. Putting the
predicate in the `where` would have made the columns visible to the old rule and
hidden the method's defect behind two corrected call sites — and the next
`select()` with no projection would have cost the next finding.

**It does not schedule a departure.** On or after the day, by constraint.

## What moved

The column census is **96 candidates and 14 findings covering 16 columns**,
across **2,177 columns and 185 tables**. `insertOnlyColumns` is **1169**. The
isolation census is **304 writes and 975 reads** — one write and one read for
each of the three new writers, every one `scoped()`, which is why both scoped
figures move by three as well.

One audit action, `practitioner.update`. `employee.update` and `tax_code.update`
have been in that union since Phase 9 with nothing able to emit either: the
vocabulary for a correction written and the correction not. Three new
`RECORD_KINDS` — a worker, a tax code and a practitioner — because until now
nothing in the application had ever had to say *not that one* about any of them.

One migration, `0103`, dropping two columns and rebuilding one index.

## Nominated for Phase 211

**The stock nobody received.**

`bill_lines.itemId` has no writer. It is Phase 169's finding on the purchase
side: `invoice_lines.itemId` existed from Phase 14 with no writer, so a stocked
item *sold* through the composer relieved no stock, and Phase 169 built the
picker that fills it. The bill composer never got one, so a stocked item
**bought** through a bill receives no stock — and that is the half of inventory
that costs money and the half a stock-on-hand figure is wrong about.

It is nominated with its measurement partly done: the column is a declared
finding, the invoice side is built and can be read as the model, and
`goods_receipts` exists and posts an accrual, which means the question of
whether a bill line or a receipt line is the right place to record what arrived
has to be answered first. That answer is the phase, and it should be measured
before the picker is built — on this run's record, the nomination is still the
least reliable part of a phase, and the last two changed under measurement in
ways that produced a better phase than the one nominated.

Behind that: the remaining findings, of which `projects.endDate` (a job that
cannot be finished) and the four `journalEntryId` and `notes` columns are the
substantial ones; the CRM account panel's missing payables side (ADR 0208); the
four joins from an unscoped primary (ADR 0198); and §11's six remaining
functions.
