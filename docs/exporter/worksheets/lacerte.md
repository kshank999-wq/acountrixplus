# Intuit Lacerte Tax

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** file import
**Vendor:** Intuit · **Deployment:** Windows desktop (also hosted)

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | No web API. But there **is a published SDK** — see the next row, which is the real answer. | V |
| Private/partner API? | Not established beyond the SDK. | — |
| Desktop SDK or local bridge? | **Yes, and it is documented.** Intuit publishes a **Lacerte SDK** offering an **ODBC driver** and a **.NET library / COM API**, *"required in order to interact with Lacerte's encrypted tax data."* | V |
| Imports a trial balance directly? | **Yes.** The **Trial Balance Utility**, reached from `Tools → Import/Export Data → Lacerte Trial Balance Utility`, then `File → Import → From Excel`. It also imports directly from QuickBooks and EasyACCT. | V |
| Imports GL detail? | No. The utility works at account-balance level. | V |
| Imports adjusting journal entries? | **Made, not imported.** The utility is where adjusting journal entries are entered, and it prints trial balance reports and financial statements. | V |
| File formats | Excel, for the Trial Balance Utility. Caseware produces `.xB#` — `x` is the tax entity code, `#` the last digit of the tax year — for its own Lacerte export. | V · X |
| Tax/account codes required? | Accounts are assigned a **tax page and line**. **SmartMap** removes most of that setup *"for trial balance accounts originating from QuickBooks and EasyACCT"* — which is to say, not for a third party's file. Each account also gets a **Type**: `A`, `L`, `R` or `E`. | V |
| Approval, licence, NDA, certification? | **None for the Excel import.** The SDK is a published Intuit developer offering; its licence terms are unconfirmed. | V |
| Recommended Accountrix path | **A Lacerte-flavoured Excel or CSV trial balance for the Trial Balance Utility.** Not the SDK. | — |
| Fallback manual path | The same file, with the firm driving the import wizard — which is already how this works. | V |
| Supporting documentation | Intuit's support articles and the Lacerte SDK docs, below. | V |

## The import contract, as far as it is documented

- The wizard **shows the spreadsheet and asks which column is which** — account
  number, account name, ending balance. For each column you select a heading,
  with *Do Not Import* available.
- **The only required column is Account Name.**
- Both shapes are accepted in practice: separate debit/credit columns, or a
  single balance column. Negative numbers in parentheses are handled.
- The **Type** column takes `A` / `L` / `R` / `E`, typed as a first letter or
  chosen from a drop-down.
- Supported return types: **1065, 1120, 1120S, 990, 1041 and Schedule C.**

The column-flexibility and parenthesis claims come from a third-party trial
balance product's documentation (**S**), not from Intuit, and are the weakest
part of this worksheet. The required-column and wizard-behaviour claims are
**V**.

## Why not the SDK

The SDK is the technically superior path and it is the wrong one for Accountrix,
for a reason that is about deployment rather than preference:

**It is an ODBC driver and a COM/.NET library that run on the machine where
Lacerte is installed.** Accountrix is a web application. Reaching that SDK would
mean shipping a Windows agent the firm installs and keeps updated beside their
tax software — a second product, with its own release cycle, its own support
burden and its own security review, to deliver a file the Trial Balance Utility
will read anyway.

The SDK is the right answer to a different question: a firm that wants data
pulled *out* of Lacerte, or written into return fields directly, which is beyond
anything §5's package describes. Recorded here so the decision is a decision
rather than an omission, and so the next person does not have to rediscover that
it exists.

## What must be confirmed before this becomes an adapter

1. **The actual column headings the wizard offers.** "Select the appropriate
   column heading" implies a fixed vocabulary that this worksheet does not have.
2. **Whether an entity Type column is required**, or inferable, or assignable
   after import. Accountrix holds `account_type` already, so supplying it is
   cheap if the mapping is `asset→A`, `liability→L`, `revenue→R`, `expense→E` —
   but equity has no letter in that list, which is a real gap to resolve.
3. **Whether CSV is accepted or only `.xls`/`.xlsx`.** The menu says "From
   Excel". If it means Excel only, this target needs the spreadsheet writer
   Phase 158 deferred.
4. **What SmartMap does with a non-QuickBooks file** — if nothing, every account
   needs mapping by hand on first use, which is §10's mapping store earning its
   place.

## Sources

- [Using the Lacerte Trial Balance Utility to import Excel data](https://accountants.intuit.com/support/en-us/help-article/partnership/using-lacerte-trial-balance-utility-import-excel/L19njx4ka_US_en_US)
- [Common questions about the Lacerte Trial Balance Utility](https://accountants.intuit.com/support/en-us/help-article/federal-taxes/common-questions-lacerte-trial-balance-utility/L5uS9jw7Q_US_en_US)
- [Using Lacerte Data Conductor to import data](https://accountants.intuit.com/support/en-us/help-article/federal-taxes/using-lacerte-data-conductor-import-data/L0wLtZ9Qy_US_en_US)
- [Getting started with Lacerte SDK — Intuit Developer](https://developer.intuit.com/app/developer/lacerte-sdk/docs/lacerte-get-started)
- [Viewing Data with Lacerte SDK — Intuit Accountants Community](https://accountants.intuit.com/community/lacerte-sdk-group/viewing-data-with-lacerte-sdk/gpm-p/338557)
- [Export to Lacerte Tax — Caseware Working Papers](https://documentation.caseware.com/2020/WorkingPapers/en/Content/Practice/Tax/Tax-USA/Export-Lacerte-Tax.htm)
- [Transferring from EasyACCT to Lacerte](https://accountants.intuit.com/support/en-us/help-article/trial-balance/transferring-easyacct-lacerte/L1Q4S4h3d_US_en_US)
