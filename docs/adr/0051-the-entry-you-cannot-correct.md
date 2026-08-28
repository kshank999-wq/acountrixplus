# ADR 0051 — The entry you cannot correct, and the one you must not

- **Status:** Accepted
- **Date:** 2026-08-28
- **Context:** Spec §2, §13, §16, §19. The journal screen stated the correction
  principle in its own header and offered neither correction — and wiring one up
  naively would have broken the books.
- **Builds on:** [ADR 0031](0031-the-control-accounts-against-the-documents.md),
  [ADR 0045](0045-the-record-you-can-never-fix.md),
  [ADR 0047](0047-the-supplier-reference-is-not-our-number.md),
  [ADR 0050](0050-the-payment-nobody-approved.md)

## Context

The journal screen has told users this since Phase 2:

> *"Voided entries stay listed — the ledger corrects by reversal, never by
> deletion."*

It then showed five columns — number, date, memo, source, status — and **no
debits, no credits, no money at all**, beside no correction of any kind. Three
functions had existed since Phase 2 with no caller anywhere in `src/app`:

- `entryWithLines` — an entry with its lines and account names.
- `voidEntry` — the user-initiated void, called only by a server action no
  screen had ever called.
- `reverseEntry` — reachable only sideways, when a deposit is unwound.

So an entry posted to the wrong account could neither be read nor put right.
An accountant could not audit their own ledger from the ledger screen.

## The costly wrong answer

Not "an entry stayed wrong" — that is a nuisance, and the trial balance still
balanced. It is **wiring the void button up naively.**

`voidEntry` checked a permission and an open period and nothing else. Void the
entry behind INV-1002 and the invoice still says $24,000 is owed while Accounts
Receivable no longer carries it. The subledger and the ledger disagree — the one
thing [ADR 0031](0031-the-control-accounts-against-the-documents.md) went to the
trouble of proving they never do, with an integrity check that would notice the
next night and nothing that would prevent it.

The reason this has never bitten a user is not that it was guarded. It is that
the button was missing.

So the interesting question is not *how* to correct an entry. It is **which
entries may be corrected this way at all.**

## Decision 1: a derived entry is corrected by correcting its document

`isDerived` tests two things, because each catches what the other misses:

- the source is not `manual` or `adjusting` (`invoice`, `bill`, `payroll`,
  `takings`, …), **or**
- `sourceType` is set at all.

The second matters more than it looks. `reverseEntry` posts its reversal with
source `adjusting` while copying the original's `sourceType`, so unwinding a
deposit produces an `adjusting` entry that is still tied to a document. Testing
the source alone would have let that one through.

The refusal names what to go and fix — *"Void the invoice on Invoices & bills;
the ledger follows it"* — rather than saying no, which is Phase 47's rule
applied to the ledger.

**The guard sits on `voidEntry`, not on `voidJournalEntry`.** A document still
voids its own entry through the internal path, in the same transaction as the
document changes, so both halves keep moving together. Only the person-initiated
path is constrained, and only to what a person posted by hand.

## Decision 2: a closed period is reversed, not voided

Voiding an entry dated inside a closed period silently changes numbers somebody
has already given to a bank or a tax authority. A reversal shows the correction
where it can be seen — in the current period, dated today, with both entries
standing and pointing at each other.

`assertPeriodOpen` already refused the void at the service level, but a screen
that offers a button and then shows a raw error has taught nobody anything.
`correctionFor` decides *before* the button is drawn, and the button that
appears is the one that will work.

## Decision 3: reversing is allowed wherever voiding is; the reverse is not

An open period is not proof nobody has reported on it — an accountant may have
given last month's numbers to the bank on a Tuesday. So the screen recommends
voiding an open-period entry and offers *"Reverse it instead"* alongside.

Asking to **void** a closed-period entry is refused in both directions. That
asymmetry is the whole rule: the safer correction is always available, the less
safe one is not.

## Decision 4: you can see what an entry says

Lines, accounts, debits and credits, fetched when a row is opened rather than
shipped with the page — a hundred entries of half a dozen lines each is a lot of
money nobody asked to see, and *"what does entry #412 actually say"* is a
question asked one entry at a time.

The totals row prints the figure once in each column and labels it **Balanced**
rather than inviting the reader to check whether two numbers agree. They agree
by construction; `createJournalEntry` will not accept anything else.

## What the browser found

A React key warning, immediately: the row and its expanded detail are two
`<tr>`s for one entry, and the fragment wrapping them carried no key. Keys on
the inner rows are not the same thing, and React said so on the first render.
Fixed with an explicit `<Fragment key>`.

Smaller than the defects the last few phases turned up, and worth saying so
plainly rather than dressing it up.

The rest of the verification confirmed the rules rather than breaking them: a
bill's entry showed its two lines and refused correction with *"Void the bill on
Invoices & bills"*; a hand-posted entry offered both corrections; and an entry
dated 2026-03-15 with January–June closed offered **only** *"Reverse it"*, then
posted #98 dated 2026-08-28 with both entries left standing and cross-linked.

One false alarm is worth recording too, because it looked exactly like a bug: a
March-dated entry read as *"falls in an open period"*. The entry was dated today
— my own script had filled the period-close **From** field instead of the
journal form's date, because the close controls render first and both are
`input[type="date"]`. The application was right; the test driver was wrong.

## Consequences

- `entryWithLines`, `voidEntry` and `reverseEntry` all have callers for the
  first time since Phase 2.
- `voidEntry` refuses an entry that belongs to a document, so the naive path is
  closed even for a future caller that forgets.
- `voidEntryAction` is replaced by `correctEntryAction`, which takes the method
  and checks it rather than trusting it.
- The journal shows money.

## What this does not do

It does not let anybody edit a posted entry, and never will — history survives
by voiding and re-posting or by reversing, which is the rule the screen has
claimed since Phase 2 and now actually offers.

It also does not correct a *derived* entry when the document behind it has no
correction of its own. `documentAdvice` names a screen for every source it knows
about, but a source whose document cannot yet be voided leaves a person with
honest advice and no button at the other end of it. That is a gap in those
modules rather than in this one, and naming it is better than pretending the
ledger can paper over it.
