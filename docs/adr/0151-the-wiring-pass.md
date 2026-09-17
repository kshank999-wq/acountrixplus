# 0151 — The wiring pass

**Status:** accepted
**Date:** 2026-09-17
**Phase:** 151

---

## What this was

Thirteen phases of cores built and deliberately not connected, on one
instruction: *get everything in place, then hook it up.* `PENDING_WIRING`
existed to make that stageable — because by Phase 49's rule a function with no
caller is a feature that does not exist, and a staged core is indistinguishable
from a forgotten one unless something writes down which it is.

This is the pass. Five entries wired, one left.

| core → target | what it repaired |
| --- | --- |
| `bankGlAccountFor` → `recordContribution` | a gift into a euro account posted a dollar figure while its sibling refused |
| `taxPerCode` → `priceDocumentTax` | three lines under one 8.25% code charged 523 where the code's base gives 522 |
| `recoverHeld` → `recoverWriteOff` | the bank took the carried rate; $41.25 had nowhere to go |
| `spends` → `applyDeposit` | the check, the posting and the message all used the invoice's face amount |
| `priceApplicationLines` → `priceApplication` + `BillingPanel` | the preview promised a total the commit refused |

What remains is `mayPostToBank`, blocked by a column since Phase 136 and naming
no acceptance test on purpose — the register permits that only for a blocked
entry, which is the distinction that keeps it from being an excuse.

## The register worked

It was built on the argument that prose nothing checks goes stale, and it
behaved that way throughout: `wiringStateFor` fails an entry whose target
already calls its core, so each wiring **forced** its own entry off the list.
The backlog could not be left describing finished work.

Two other registries moved with it, and both were caught by their own scans
rather than by me remembering:

- **`BANK_POSTINGS`.** Wiring `recoverHeld` gave `recoverWriteOff` a day rate,
  which removed the reason it was withholding the money's currency from the
  guard. `who-may-ask.test.ts` failed with *"the registry and the code disagree
  about what this path does"* the moment the code started passing one. It is
  now the sixth `matched` path and the only entry in that registry whose
  handling has ever changed. `no-day-rate` stays declared with nobody using it:
  it is the reason a path holding the currency may still not pass it, and the
  next path in that position should find the vocabulary rather than argue it
  again.
- **The Phase 146 test** said *"when the wiring pass lands, both of these flip
  and the entry comes off `PENDING_WIRING`"*. They flipped.

## What the pass found that no register held

This is the part worth keeping. Five entries were wired and **four separate
faults** turned up that nothing had recorded, every one of them surfaced by
doing the work rather than by planning it.

### An acceptance test that was a stub

`gift-card-against-foreign-invoice.test.ts` created an invoice, asserted two
ids were truthy, and **never called `redeemGiftCard`**. It also asked for
account 1200 where the receivable is 1100 — a detail that would have failed on
the first run it never got.

ADR 0139's rule is that a test which cannot fail for the right reason is
fiction. A **skipped** test is where that is easiest to keep, because nothing
ever runs it to find out, and the register's promise — "unskip it and it says
whether it worked" — was not true of this entry. Rewritten to drive the real
path.

### A defect that cannot happen

`redeemGiftCard` reaches its invoice through `appointment.invoiceId`, and an
appointment gets one from `completeAppointment`, which calls `createInvoice`
with no currency. An appointment invoice is therefore always in the company's
own money, and the register's measured scenario — *"a $600 card against a
€1,000 invoice carried at 1.10"* — is not reachable through the only path that
gets there.

The wiring was kept: `affords` asks the right question whatever the currencies
are, the domestic answer is identical, and the day an appointment can be
invoiced in euros this is already right. The **claim** that it repaired a live
defect was not kept. An entry on a register of live faults that describes an
unreachable one is the same failure as prose nobody checks, one level up.

### A function that returned an empty list after writing

`setScheduleOfValues` ends by returning `scheduleFor(ctx, projectId)` — on `db`,
from inside its own transaction. So it read the schedule as it stood *before*
the write and returned nothing after successfully saving. Measured: returns 0
rows where the schedule has 1.

Every caller in the suite ignored the return value, which is how it survived.
The Phase 146 acceptance test used it and got nothing, which is how it was
found. `scheduleFor` takes an executor now.

### Two tests that could not both be right

`jobs.test.ts` asserted `priceApplication` **throws**. The Phase 146 acceptance
test asserted it **returns problems**. Wiring made the contradiction load-
bearing, and it had to be settled rather than split.

The settlement is the one ADR 0146 argued for: the preview reports and the
commit refuses. `priceApplication` is the preview — its own comment says so —
so it returns the list, and `createProgressBilling` throws on the first problem
in the sentence it always used. Putting the refusal in `priceApplication` would
have kept the fault being repaired: a screen calling it would still meet one
refusal per click.

## Two return values that were invisible

Both the same shape, and the inverse of Phase 49's rule: not a function with no
caller, but a **value with no reader**.

`settleInvoiceWithoutCash` has returned `functionalCents` since Phase 127 with a
declared type that did not mention it, so every caller saw a face amount and no
way to ask what it was carried at. `applyDeposit` had no way to tell a caller
what it actually applied, which is precisely why `applyDepositAction` reached
for the face amount somebody typed and rendered €400 as "$400.00".

A value the type hides is unreachable as surely as one that is never returned.

## What changed for a person using this

Worth stating plainly, because four of the five change figures people see:

- an invoice with several lines under one tax code charges a cent or two less,
  and now equals its own printed base times its printed rate;
- a recovered foreign write-off banks what the statement will show, with the
  difference named as a realised gain instead of vanishing;
- a deposit applied to a foreign invoice takes the invoice's worth off the
  tenancy rather than its face amount, refuses when the holding cannot cover it,
  and reports the figure that actually moved;
- a donation into a foreign account is refused with a sentence rather than
  posted wrongly;
- a progress billing preview shows every problem at once, on the row it belongs
  to, instead of a total the server will decline.

## What this does not do

**It does not finish the register.** `mayPostToBank` needs a column, a form
field and a migration — ADR 0136 called it "a real change to a real screen" and
that is still what it is.

**It does not touch `BLIND_FACE_SUMS`.** Three registered sums, two feeding
statutory filings, each a query change. They were registered rather than
repaired under the staging instruction and remain so.

**It does not prove the screen half of the billing preview by test.**
`BillingPanel` is a React component and this suite has no browser. What holds it
is the transcription of the panel's own `useMemo` in
`application-preview.test.ts`, which now asserts the clamp is **gone** rather
than present.

## What is nominated next

`BLIND_FACE_SUMS` — three sums, two of which reach a statutory filing, and the
only remaining register of known-wrong figures. Then `mayPostToBank`, which is
a field and a screen rather than a wiring.
