# ADR 0030 — Nobody bills past what was authorised

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Spec §5 ("Automotive / Repair — jobs, parts, labor, estimates,
  **customer vehicles**"), §13, §23
- **Builds on:** [ADR 0007](0007-industry-modules-without-forking-the-ledger.md),
  [ADR 0014](0014-one-inventory-five-industries.md),
  [ADR 0029](0029-a-booking-is-a-promise-and-part-of-the-money-was-never-yours.md)

## Context

`vehicles` is the **tenth and last** of the industry modules declared in
Phase 0. All ten are now implemented, and the settings page's "Not built yet"
section is empty for the first time since Phase 7.

It was left until last on purpose, and for most of that time the reason looked
like a good one: a vehicle is a *dimension*, and Phase 16 has reported per
dimension since then. Phase 0's own description — "per-vehicle cost and mileage
tracking" — describes a fleet, and a fleet really is a dimension plus a mileage
log.

But that description was wrong about what the spec asks for. §5's automotive row
says **customer vehicles**, not company vehicles, and the accounting content is
not in the vehicle at all. It is in the estimate: **a repair shop may not bill
past what the customer authorised**, and in most jurisdictions that is not a
policy but a statute. That makes it the only module in the application whose
central rule exists because the law says so.

Five claims, asserted in `tests/vehicles.test.ts`:

1. **Nobody bills past what the customer authorised.**
2. **An odometer does not go backwards.**
3. **The record follows the car**, not the owner.
4. **Parts, labour and sublet are three different things.**
5. **A part fitted is a sale**, relieved from the lots it came out of.

## Decision 1: the ceiling is enforced at billing, not at quoting

`completeRepairOrder` refuses when the work exceeds the authorised amount plus
the order's tolerance. `addLine` does not.

That asymmetry is the design. An advisor has to be able to price the extra work
*in order to ring up and ask about it* — refusing the line would make the phone
call impossible, and what happens next in a real shop is that somebody keys the
job somewhere else. So the estimate can grow freely, the screen shows the gap
continuously, and the refusal lands at the one moment it matters.

The message names the **additional** amount rather than the new total, because
that is what the customer is being asked to agree to. `authorityFor` computes it
as `quoted − authorised`, deliberately *not* to the ceiling: asking only up to
the ceiling would let the tolerance apply again on top of the new authorisation,
and a limit that compounds is not a limit.

## Decision 2: the tolerance applies to the authorised amount, never to the quote

A 10% tolerance on £400 authorised is a £440 ceiling, and it stays £440 however
large the quote grows. Applying the percentage to the quote instead would make
the allowance grow with the overspend — the exact opposite of a limit. A test
sweeps four quote sizes against one authorisation and asserts the ceiling never
moves.

The ceiling rounds **down**. A ceiling that rounds up is one the shop set for
itself.

A tolerance of zero is a legitimate and common setting, and is the default. It
means every penny over needs a fresh yes.

## Decision 3: an authorisation is a row, not a column

`repair_order_authorisations` holds one row per approval: how much more, down
which channel, who said yes, who took it, and when.

`repair_orders.authorised_cents` exists as well, and is a cache incremented in
the same transaction. It could be derived — but it is what the billing ceiling
is computed from on every screen and every completion, and deriving it there
would put a `sum()` in the hot path of the one check that must never be skipped.

**Who agreed to what, when, and how is the entire evidentiary content of this
module.** A shop challenged over a bill needs to say "you approved a further
£175 by telephone at 14:20 on the 6th, and Marek took the call". A single
running total cannot say any of that, which is why the rows are the record and
the column is only a cache.

Amounts are *additional*, not cumulative, and a mistaken approval is reversed by
a negative row rather than by editing history — the same rule Phase 26 applied
to fund releases.

## Decision 4: the two sides of the authorisation check are still worth comparing

`authorisationsAgree` puts every order's `authorised_cents` against the sum of
its own approval rows. This is the only reconciliation in the application where
both sides come from the same module, which makes it worth saying why it is not
self-checking: the cache and the rows are written by **different statements**, so
a bug in one would not move the other, and the offender list decides rather than
the netted difference — totals can cancel out while individual orders are wrong.

## Decision 5: an odometer does not go backwards

`odometerStep` returns one of three verdicts, and the middle one is the reason
it is not a boolean. `unmoved` — the same reading as last time — is a car towed
in, looked at, and collected without being driven. Real, common, and not an
error; named separately so a shop that sees a run of them can ask why.

`backwards` is refused. The honest explanations are a typo or a replaced
instrument cluster, and both are things a person should have to assert
deliberately. `recordOdometer` takes an explicit `allowRollback` with a reason
and writes an audit event — because the dishonest explanation is a crime, and
software should not make it convenient.

## Decision 6: parts, labour and sublet are three revenue accounts

A shop looking at one revenue figure cannot tell a busy bay from an expensive
gearbox. Labour is capacity, parts are a margin on somebody else's product, and
sublet is neither.

`4620 Sublet Revenue` is **not in the automotive pack** — the pack gives sublet
a cost account and no revenue account — so `ensureAccounts` installs it. Folding
it into `4600 Labor Revenue` would be the easy fix and the wrong one: no
technician's time is consumed by a sublet, so a shop that books it as labour
believes its own bay is more productive than it is, and prices accordingly.

A part fitted is a genuine sale — the stock leaves permanently — so it uses
Phase 14's existing `sale` movement kind rather than inventing one. Only the
account it debits differs, and `consumeStock` has taken that as an argument
since Phase 27. This is what ADR 0007 asks for, three phases running.

## Decision 7: the cost of a sublet is deliberately not posted

The sublet's revenue is booked; its cost is not. The machine shop sends an
invoice, and that invoice goes through accounts payable coded to `5180 Sublet
Repairs` like any other bill. Accruing it at completion as well would
double-count it the moment the real bill arrived, and nothing links the two well
enough to net them off.

The consequence is real: a sublet's cost lands in the period its bill is
entered, not the period the job completed. `sublet_cost_cents` is recorded on
the line anyway so `shopMix` can report whether the shop makes anything on work
it sends out — usually a disappointing number, and worth knowing.

## Decision 8: the record follows the car

Vehicles are keyed by VIN where there is one, and `customer_id` is the *current*
keeper, allowed to change. When a car is sold, the vehicle row and every repair
order on it stay put.

A service history that reset on sale would be worth far less — to the next
owner, to the shop that wants the work, and to anybody establishing what was
done and when.

## The defect this phase found, and what it means for the codebase

Two report totals came back as zero, silently, with no error. Both were written
as correlated subqueries in the select projection:

```sql
(select coalesce(sum(a.amount_cents), 0)
 from repair_order_authorisations a where a.repair_order_id = "id")
```

**Drizzle omits table qualification in a single-table query.** With no join on
the outer query, `${repairOrders.id}` renders as bare `"id"` — and inside the
subquery's own `FROM`, that resolves to *its* `id` column. The correlation
became `a.repair_order_id = a.id`: valid SQL, never true, never an error.

The same fragment in a query that *has* a join renders `"repair_orders"."id"`
and is correct, which is why the identical pattern in
`marketing/audience.ts` and `evidence/service.ts` has always worked — both join.
Those were checked and left alone.

Worth recording because of how it was nearly mis-diagnosed: the first instinct
was to assume the unqualified form everywhere and "prove" it by running that
form in psql. That proves the hypothesis, not the code. Dumping `.toSQL()` for
each real query is what settled it, and is the only thing that would have.

All four totals here are now joins with `group by`, which sidesteps the question
entirely and is faster besides.

## Consequences

- **All ten industry modules are implemented.** The settings page's "Not built
  yet" list is empty. It is kept rather than deleted, because the next module
  declared will need it.
- **Nothing settles the receivable.** Billing debits Accounts Receivable, and
  clearing it is Phase 12's payment machinery — the same gap Phase 29 left, and
  most acute here, where customers pay at the counter.
- **A sublet's cost lands in the period its bill is entered**, per Decision 7.
- **No parts markup rule.** Each line is priced by hand; there is no matrix
  turning cost into price, which is how most shops actually price parts.
- **No technician time tracking.** A labour line is hours × rate typed in, not
  clocked. Phase 15 has timesheets and nothing joins them to a repair order.
- **The odometer is a single running maximum.** A reading is checked against the
  vehicle's highest, so a genuine correction downward needs the rollback flag
  even when it is obviously a typo.
- **No MOT, service intervals or reminders**, which is most of what a garage's
  software sells on — and all of it schedulable on Phase 10's queue.
- **`repair` is a new journal source**, so anything enumerating the existing
  ones needs updating.

## Follow-up

1. **Settle at the counter**, closing the receivable Phase 29 also leaves open.
2. **A parts pricing matrix**, cost band to markup.
3. **Clock labour from Phase 15's timesheets** rather than typing hours.
4. **Service and MOT reminders** on Phase 10's scheduler and Phase 19's mail.
5. **A lint or review habit for raw `sql` correlated subqueries** — the failure
   mode is silent, and the only reliable check is reading the emitted SQL.
