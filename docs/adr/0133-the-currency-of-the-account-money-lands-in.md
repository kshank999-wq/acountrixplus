# 0133 — The currency of the account money lands in

**Status:** accepted
**Date:** 2026-09-05
**Phase:** 133

---

## How this was found

ADR 0131 named a defect and ADR 0132 named it again without building it:

> Remit a payroll liability from a euro account and the bank line carries a
> functional figure the statement will never show.

Measuring it before adopting it — the rule this project has kept since Phase 104
— turned one site into a class of ten, and turned a bug report into a question
the codebase had never asked anywhere.

## The question `LEDGER_POSTINGS` cannot ask

Phase 127 asks every site that reaches `debitCents` or `creditCents`: **is this
figure the company's own money?** It is a good question and it caught two real
defects. But a ledger line names an account as well as an amount, and one kind
of account is held somewhere real:

> **The figure can be right and the entry still wrong, because the account it
> lands on is held in a currency nobody asked about.**

Measured: **nineteen postings in fourteen functions** land on a bank account's
ledger account. `financial_accounts.currency` is read in seven places across
`src/modules` — the bank feed, three screens, the accounts module, the AI
retrieval and the sync. **Not one of the ten that need it is among them.**

Remit $1,200 from a euro account. `recordRemittance` refuses an amount larger
than `liabilityPositions` says is owed, so the figure is measured against a
ledger balance and genuinely *is* the books' money — `LEDGER_POSTINGS` is right
to call it `domestic`. The entry balances. And it asserts that $1,200 left an
account that deals in euros, when what left was €1,100 worth $1,210 that day.

The part that makes it undiscoverable is not the arithmetic. **The person was
never asked what left.** There is no field for it. The path has no way to be
right.

## Why this refuses rather than converts

Phase 117's rule: a refusal beats a check. Converting the ten would mean ten new
rate decisions, ten UI changes and ten ways to get it wrong, built
speculatively for accounts that mostly do not exist yet. Refusing means a
business with a euro account is told which paths cannot yet handle it, instead
of being handed entries nobody can defend.

That is a real limitation and it is stated as one, in the file and in the
refusal itself — which names the account, both currencies, the act, and what to
do instead.

**A domestic account is untouched.** `isForeign` is false and all ten behave
exactly as they did, which is why this survived a hundred and thirty phases. The
230 tests across the nine affected suites pass unchanged.

## The lookup and the question are one call

Each of the ten did its own two-line lookup: select the `chart_account_id`,
refuse if the row is missing. **Ten copies of a lookup is how ten copies of a
missing question happen** — nobody adding the eleventh path would have known
there was one to ask, because there was nowhere for it to live.

`bankGlAccountFor` is that place. A path that wants the ledger account gets it
from there and is refused there, so the eleventh inherits the rule by using the
function rather than by remembering.

## Three wrong counts, and a scan that missed the feed

Both failures are this project's own recurring ones, committed while writing the
file that records them, and both are in the test rather than quietly fixed.

**The count.** Eleven, from reading a grep. Thirteen, from counting the registry
I had just written. Nineteen, from running the scan. Each was plausible and only
the last was measured — which is Phase 126's lesson about
`UNCLASSIFIED_CARRIERS` and Phase 132's about `ALLOWED_BARE_REFUSALS`, a third
time.

**The scan.** Matching `chartAccountId: bank.chartAccountId` missed four
functions, including `buildLines` — the bank feed, the one path that has always
got this right — because `posting.ts` and `restate.ts` resolve the account once
into `glAccountId` and post that. A scan that cannot see the thing it is
modelled on is the failure Phase 128 found in the posting scan and Phase 131 in
the screen scan.

## Verified in a browser, and what the confirming suite caught

`/properties` → Deposits held → "Take, return or keep" offers all four of
Ridgeline's accounts, Frankfurt Current among them, because the picker is built
from `listFinancialAccounts` with no currency filter. Choosing it and pressing
"Take it" puts the refusal on the screen word for word:

> Frankfurt Current is held in EUR and these books are kept in USD, so holding
> this deposit would put a USD figure against an account that moves in EUR —
> without recording what actually left it. Use a USD account, or post it by hand
> as a journal entry that says what the rate was.

Nothing was written: `deposit_movements` still holds only the seeded row, and
the register and the ledger still agree at $1,750. That is the whole claim —
the sentence survives `messageFor`, and the refusal lands before the write.

**The confirming suite went red on `registry-error.test.ts`, and that is the
best thing in this phase.** Phase 132 asserted a measured count of eleven
`RegistryError` throws. `BANK_POSTINGS` was written a phase later, against the
file beside it, by somebody who never opened that test — and the count caught
it: `expected 12 to be 11`. The first time the device has *caught* a registry
rather than described one. The count is now twelve and a second assertion names
`BANK_POSTINGS`, so the twelfth is recorded rather than merely counted.

## What this does not do

**It does not convert anything.** Ten paths refuse where they used to post. A
business that needs to remit from a euro account still cannot; it is now told
so, rather than being given an entry that says something untrue.

**It does not check where the guard sits in each path.** The call goes
immediately before the posting, which is the invariant point and uniform across
all ten — but in `recordRemittance` that puts it after the liability check, so
somebody with no liability sees that refusal first. Both are true refusals and
neither is wrong; ordering them by which a person would rather read is a
separate question nobody has measured.

**It does not give `payouts` the comparison it nearly has.** `payouts` carries a
currency of its own, so `importPayouts` is the path closest to converting — and
nothing compares that currency to the account's. It refuses rather than trusting
that a processor settles into a matching account, and closing that properly is
the one of the ten with the shortest road out.

Measured after the fact, that nomination was understated, and the correction
belongs here rather than in the phase that acts on it. `batch.currency` is
written to `payouts.currency` and **never read again**; the entry posts
`batch.amountCents` to both legs unconverted. So a euro payout into a *domestic*
account posts €X as $X — Phase 127's original defect, which this phase's guard
does not catch, because `mayPostToBank` asks about the account and never about
the money. `LEDGER_POSTINGS` declares this site `domestic` on an argument that
says so out loud — "a fact about the data, not a guarantee from the schema" —
and this phase enforced only the `financial_accounts` half of that fact.
`checkouts` carries a currency too, and `heldByProcessor` sums across all of
them ungrouped, so the in-transit account cannot be made to clear. Every
`.currency` in `src/modules/payments/` is written or displayed; none is compared.
