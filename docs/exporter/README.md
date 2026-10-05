# Integration worksheets

Exporter spec §13 requires, for each Priority 1 target, *"a one-page integration
worksheet before writing production code"*, answering twelve questions and
citing *"what official vendor documentation supports the decision."*

This directory holds those fourteen worksheets. Phase 159.

## Read this before you read a worksheet

**No worksheet in this directory is verified, and none of them authorises
adapter code.** They are marked `draft`, and `WORKSHEETS` in
`src/modules/exporter/worksheets.ts` keeps every destination refusing until
somebody promotes one.

The reason is specific and it is not modesty. The research was done in an
environment whose egress policy blocks every vendor documentation host —
`accountants.intuit.com`, `developer.intuit.com`, `tax.thomsonreuters.com`,
`cs.thomsonreuters.com`, `support.cch.com`, `help-engagement.cchaxcess.com`,
`download.cchaxcess.com`, `drakesoftware.com`, `kb.drakesoftware.com`,
`documentation.caseware.com`, `www.caseware.com`, `riahelp.com`, and in fact
every host tried. Web *search* worked and returned summaries of those pages;
fetching them did not.

So every citation below is a page that search surfaced and summarised, and that
nobody on this side has opened. That is a real distinction and §13 is a clause
about exactly it: a worksheet whose answers come from a summary of a page is a
worksheet that has not yet read the documentation it cites.

Each answer therefore carries its provenance:

| Mark | Means |
| --- | --- |
| **V** | A vendor help or knowledge-base page for *this* product, summarised by search |
| **X** | Another vendor's documentation describing this product's import (e.g. Caseware on UltraTax) |
| **S** | Secondary — trade press, a consultancy, a community thread |
| **—** | Not established. No source found, and nothing is asserted |

An **S** answer is not evidence for a format decision. Two of the findings
below that would most change the design — Drake's template-corruption rule and
UltraTax's closed third-party vendor list — rest on **V** and **S**
respectively, and the second is flagged in its own worksheet as the single most
important thing to confirm.

## Promoting a worksheet

Verification means: open the cited vendor pages, confirm each answer, obtain a
sample file or sandbox where the vendor offers one, and change the entry's
`status` to `verified` with the date and who did it. `adapterMayBeBuilt` then
stops refusing, and `tests/export-worksheets.test.ts` holds the rules.

A worksheet promoted without opening the pages is worse than no worksheet,
because the registry's whole purpose is to be the thing a reader trusts.

## What the research changed about Accountrix's own output

Three findings bear on the universal package as Phase 158 wrote it, and they
are recorded here rather than acted on, because acting on them is adapter work:

1. **Debit/credit convention is not uniform inside one vendor's own range.**
   CCH ProSystem fx Engagement wants debits and credits in a *single signed
   column* with credits negative or parenthesised; CCH Axcess Engagement wants
   *separate* debit and credit columns. Same vendor, two conventions. §7 asks
   this question of every target for a reason.
2. **CCH G/L Direct wants no header row**, no dollar signs, no thousands
   separators, and a minus sign rather than parentheses. Accountrix's
   `trial_balance.csv` has a header and two columns; `decimal()` already gets
   the rest right.
3. **Account number limits are real and specific.** ProSystem fx Engagement
   caps account numbers at 64 characters and forbids `' | : " , ( ) * ?`.
   §11's `account_identifiers_portable` check allows only
   `[A-Za-z0-9.-]`, which is inside that, so the check is sound — but it says
   nothing about length.

## The worksheets

| Target | Finding | Recommended path | Worksheet |
| --- | --- | --- | --- |
| Intuit Lacerte Tax | file import | Excel into the Trial Balance Utility | [lacerte](worksheets/lacerte.md) |
| Intuit ProSeries Tax | file import | Weakest of the fourteen — no API, no SDK | [proseries](worksheets/proseries.md) |
| Intuit ProConnect Tax | file import | No third-party path published | [proconnect](worksheets/proconnect.md) |
| Thomson Reuters UltraTax CS | file import | Blocked on a closed vendor list | [ultratax-cs](worksheets/ultratax-cs.md) |
| Thomson Reuters GoSystem Tax RS | programmatic | REST API, developer account + request form | [gosystem-tax-rs](worksheets/gosystem-tax-rs.md) |
| Wolters Kluwer CCH Axcess Tax | file import | G/L Direct custom template | [cch-axcess-tax](worksheets/cch-axcess-tax.md) |
| Wolters Kluwer CCH ProSystem fx Tax | file import | G/L Direct custom template | [cch-prosystem-fx-tax](worksheets/cch-prosystem-fx-tax.md) |
| Drake Tax | file import | Drake's own macro template — a problem | [drake-tax](worksheets/drake-tax.md) |
| Caseware Working Papers | file import | CSV/Excel import wizard — the best fit | [caseware-working-papers](worksheets/caseware-working-papers.md) |
| Caseware Cloud / Engagements | programmatic | REST + OAuth2, firm-issued credentials | [caseware-cloud](worksheets/caseware-cloud.md) |
| CCH Axcess Engagement | file import | .xlsx, separate debit/credit columns | [cch-axcess-engagement](worksheets/cch-axcess-engagement.md) |
| CCH ProSystem fx Engagement | file import | Excel, single signed balance column | [cch-prosystem-fx-engagement](worksheets/cch-prosystem-fx-engagement.md) |
| Thomson Reuters Workpapers CS | file import | Spreadsheet Import Wizard | [workpapers-cs](worksheets/workpapers-cs.md) |
| Thomson Reuters Accounting CS | file import | Chart-of-accounts spreadsheet with tax codes | [accounting-cs](worksheets/accounting-cs.md) |

## What the shape of the answers says

Twelve of fourteen are **file import**. Two are **programmatic**, and only one
of those two — Caseware Cloud — issues credentials without an approval process,
because the *firm* registers the API client rather than Accountrix being
admitted to a programme.

That is §7's warning borne out. An exporter built on the assumption that
professional software is reached through APIs would have been wrong about
twelve of fourteen Priority 1 targets, and the two it was right about are the
two that need paperwork.

It also says where to start. The three worksheets with the fewest unknowns and
no approval gate are **Caseware Working Papers**, **CCH Axcess Engagement** and
**CCH ProSystem fx Engagement** — all workpaper products, all taking a
spreadsheet whose columns are documented, and between them the place a firm
actually receives a client's trial balance before any return is prepared.
