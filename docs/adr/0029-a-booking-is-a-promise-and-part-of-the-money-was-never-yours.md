# ADR 0029 — A booking is a promise, and part of the money was never yours

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §5 ("Healthcare / Practice — **service revenue, providers,
  locations, payment categories**" and "Personal Care / Appointment Services —
  **appointments/service revenue, staff/contractor splits, products**"), §13, §23
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0023](0023-somebody-elses-money.md),
  [ADR 0028](0028-a-day-is-a-fact-somebody-else-recorded.md)

## Context

`appointments` has been a declared industry module since Phase 0, switched on by
the healthcare and personal-care packs, doing nothing. This is the ninth of
§5's fourteen rows to get a real module — and, like Phase 28, it serves two of
them, because a dentist and a hair salon do the same thing: keep a diary,
deliver a service out of it, and owe a share of what it earned to the person who
did the work.

The obvious objection is that a diary is a scheduling feature and belongs in a
scheduling product. Three things here are not scheduling, and they are why this
is a module rather than a calendar widget:

- **A booking is a promise, not a sale.**
- **Part of the money was never the business's.**
- **A gift card is money taken for a service not yet given.**

Five claims, asserted in `tests/appointments.test.ts`:

1. **A booking posts nothing**; delivery posts everything.
2. **Two people cannot be in the same chair at once**, and the database says so.
3. **The practitioner's share is a liability** from the moment the work is done.
4. **A gift card is money owed, not money earned** — and redeeming one does not
   earn it a second time.
5. **A no-show is not a cancellation**, and neither is revenue.

## Decision 1: the database refuses a double-booking, because a check cannot

`appointments_no_double_booking` is an `EXCLUDE USING gist` constraint over
`(practitioner_id, tstzrange(starts_at, ends_at))`, restricted by `WHERE status
IN ('booked','completed')`. It is **hand-written into the migration**, because
drizzle-kit does not generate exclusion constraints — the first hand-written SQL
in twenty-nine migrations, and worth the exception.

Every phase since Phase 23 has followed the rule *where two people can act at
once, the database arbitrates*, and every previous phase expressed it as a
unique key. A unique key cannot express this one. Bookings at 10:00 and 10:30
collide on no column at all; they collide on an **interval**, and only Postgres
knows that at the moment of insert. The alternative is to read the
practitioner's diary, decide there is room, and then insert — correct exactly
until the receptionist and the online booking form act in the same second, and
silently wrong after that. A test races two bookings with `Promise.allSettled`
and asserts that exactly one survives.

Two details carry more weight than they look:

- **The `WHERE` clause.** A cancelled appointment must stop reserving its slot,
  or a client who calls off Tuesday blocks that hour for ever.
- **`tstzrange` is half-open.** 10:00–11:00 and 11:00–12:00 do not overlap, so a
  full day's back-to-back diary is legal. A closed range would refuse the normal
  case, which is the sort of thing that is discovered by a receptionist rather
  than by a test unless somebody writes the test.

`btree_gist` is what lets a plain uuid equality sit in the same GiST index as a
range overlap.

## Decision 2: booking posts nothing at all

The ledger does not move until the service is delivered. This is revenue
recognition in one sentence, and it is the thing a calendar bolted onto an
invoice gets wrong.

If a booking posted, every cancellation would need a reversal, and a practice's
revenue would be whatever its diary happened to hold — which is a number that
goes up when somebody books six months out and down when they call off. The
forward book is reported (`diarySummary.bookedCents`) and named separately from
what was earned, so nobody adds the two together. A test books £300 into the
diary against £65 delivered and asserts the profit and loss says £65.

## Decision 3: the share is a cost, never netted off the revenue

```
  Dr Accounts Receivable            total
      Cr Service Revenue                    price
      Cr Retail Product Sales               products
  Dr Booth Rent and Staff Splits    share
      Cr Contractor Payouts Payable         share
```

The salon earned the whole £65 and owes £29.25 of it. Netting to £35.75 of
revenue would understate both the turnover and the cost of producing it, and
would hide the payout from anybody reading the profit and loss — which is
exactly the figure a salon owner is looking for when they ask why a busy month
made no money. The demo shows £264 of revenue against £123.90 of splits, and the
gross profit line is the answer to that question.

The share is credited to `2320` whether the practitioner is a contractor or an
employee. The liability is the same fact either way — work done, not yet paid
for — and which door the money leaves by is payroll's business.

## Decision 4: rates are copied onto the booking, and the split always sums

`commission_bp` and `product_commission_bp` are written onto the appointment
when it is booked. A practitioner's rise in April must not restate what March's
work was worth, and a service repriced must not restate what a past visit
earned. A test raises somebody's rate between booking and completion and asserts
the old rate is what pays.

Service and retail carry **separate** rates, because they genuinely differ in
this trade: a stylist on 45% of the cut is commonly on 10% of the shampoo, and
one rate covering both misstates every bill with a product on it.

`splitFor` computes the practitioner's share and gives the business **the
remainder**, so the two halves sum to the price by construction rather than by
luck. The business absorbs the half-penny. Consistency matters more than
direction: a rule that sometimes favours one party and sometimes the other
produces a discrepancy nobody can explain. `roundingCents` reports the fraction
and who got it, because "why is it 49p and not 50p" is a question with an answer.

The split is taken on **what was charged**, not what was listed. A £100 service
discounted to £80 splits £80. The alternative exists in the trade and is a
defensible commercial choice, but it makes the discount invisible in the split
and lets a manager give away margin that is not theirs to give.

## Decision 5: a gift card is a liability, and redeeming it earns nothing extra

Selling a card is `Dr Cash / Cr 2590 Gift Cards Outstanding`. **No revenue.**
The business has the money and has given nothing for it.

Redeeming one is `Dr 2590 / Cr Accounts Receivable` — and this is the decision
most likely to be questioned, because the personal-care pack installs
`4720 Gift Card Redemptions` as a revenue account and this module never posts
to it.

Crediting `4720` on redemption would count the same money twice. The revenue was
already recognised when the service was delivered; by the time a card appears at
the desk the practice has earned its £65 and the client owes it, and the card
settles the debt. Posting revenue again would state £130 of income for one £65
haircut. `4720` belongs to a different model — the one a till uses, where there
is no separate delivery event to hang the revenue on — and **having an account
in the pack is not a reason to post to it.** A test runs the profit and loss
after a redemption and asserts £65.

A card cannot pay more than it holds (that would create money) and cannot pay
more than the bill (that would hand back change in cash on a voucher, turning a
promise of *service* into a promise of *money* — a materially different
obligation and in several places a regulated one).

## Decision 6: a practitioner is not a user

`practitioners` is its own table, not a `users` row and not a `memberships` row,
because **most practitioners never sign in**. A salon's chair renter and a
clinic's visiting physiotherapist appear in the diary, earn a share, and have no
login and no permissions. Modelling them as users would either create dormant
accounts that can be signed into, or force a fake membership row whose role has
to be explained. `user_id` is an optional link for the ones who do sign in.

## Decision 7: a no-show is not a cancellation

Separate statuses, and neither posts. A cancellation is a slot given back in
time to sell again; a no-show is a slot that was lost. A practice that cannot
tell them apart cannot see the cost of either, and `noShowRateBp` measures
no-shows against everyone who was expected rather than against every booking
ever made.

A no-show fee is deliberately **not** posted here. It is a fee, raised as an
invoice, with a different revenue account and in most places different tax
treatment. Quietly booking the service revenue for a service nobody received
would be the wrong answer to a tempting question.

## Decision 8: two reconciliations, and they are not the same kind

- **Payouts** put `sum(appointments.practitioner_cents)` against the balance on
  2320. These are *expected* to diverge once anybody has been paid, so a
  difference is not a fault — it is the answer to "what went out this month".
  The seed and the test both pay staff with an ordinary journal entry,
  deliberately: money has to leave 2320 by a door this module does not control,
  or the figure is checking itself. This is Phase 28's tips position against a
  different obligation, and the recurrence is the point.
- **Gift cards** put `sum(gift_cards.balance_cents)` against the balance on
  2590, and these two **should** match exactly, because nothing legitimately
  moves 2590 except selling and spending a card — both of which maintain the
  balance in the same transaction. A difference means a posting without a card
  update, a card update without a posting, or somebody journalling by hand. A
  test does exactly that last thing and asserts the report catches it.

## Consequences

- **Nothing settles a cash-paid visit.** Delivery debits Accounts Receivable,
  and clearing it is Phase 12's payment machinery or a gift card. A salon whose
  clients all pay at the desk will accumulate receivables unless somebody
  records the payments.
- **A practice using both this and Phase 28 would double-count.** Appointments
  recognise revenue per visit; daily takings recognise it per day. Nothing
  prevents a business from running both against the same trading, and nothing
  warns about it.
- **No recurring appointments, no waiting list, no reminders.** A standing
  Tuesday slot is six rows typed six times, and nothing tells a client their
  appointment is tomorrow — even though Phase 19 has the mail channel and
  Phase 10 has the scheduler.
- **No resource other than a practitioner.** A treatment room, a chair, or a
  piece of equipment can be double-booked freely. The constraint is keyed on
  the practitioner alone.
- **No breakage on gift cards.** Recognising revenue on cards that will never be
  used requires a judgement about how many never come back, and a wrong
  judgement books revenue that has to be given back. Cards sit on 2590 for ever,
  and nothing reports how old they are.
- **`1220`-style chasing does not exist here either.** Nothing surfaces an aged
  gift card or an unpaid practitioner in Phase 24's health checks.
- **Retail does not touch inventory.** A shampoo sold at a visit credits 4710
  and relieves no stock, so cost of sales for retail comes from purchases. Both
  packs enable `inventory`; nothing joins the two.
- **`appointment` is a new journal source**, so anything that enumerated the
  existing ones needs updating.
- **The first hand-written migration SQL.** `npm run db:generate` will not
  reproduce `appointments_no_double_booking`, so a future schema change that
  regenerates the migration must not drop it.

## Follow-up

1. **Settle a visit at the desk**, rather than leaving a receivable behind.
2. **Recurring bookings and reminders**, on Phase 10's scheduler and Phase 19's
   mail.
3. **Rooms and equipment as bookable resources**, which the same constraint
   shape extends to.
4. **Aged gift cards** in Phase 24's health surface, and a breakage policy that
   is a named decision rather than a silent one.
5. **Recipes from a service to its consumables**, so retail and treatment stock
   relieve inventory — the same gap Phase 28 left for a restaurant.
