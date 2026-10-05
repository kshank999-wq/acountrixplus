# CCH Axcess Engagement

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** workpapers · **Finding:** file import
**Vendor:** Wolters Kluwer · **Related:** CCH Axcess Financial Prep / Engagement Essentials share this import

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **Yes, in principle.** The CCH Axcess Open Integration Platform publishes **Trial Balance Management APIs** that *"support importing and exporting trial balance and general ledger data"*. Journal-entry management and grouping-list templates are described as **future** enhancements. | V |
| Private/partner API? | The same platform, behind approval. Three partner tiers; the entry-level tier is *Licensed Consultant*. | V |
| Desktop SDK or local bridge? | No. Cloud product; the file import is in the browser. | V |
| Imports a trial balance directly? | **Yes.** Engagement List → engagement → *Trial Balance* → *Microsoft Excel* → browse. Excel and CSV go through the *Data Import Wizard*. There are also direct QuickBooks Online and Xero connectors. | V |
| Imports GL detail? | Via the APIs, yes — *"trial balance and general ledger data"*. Through the file import, not established. | V |
| Imports adjusting journal entries? | Not yet through the API (described as a future enhancement). Entries are made in the product. | V |
| File formats | `.xlsx` (Excel 2013 or newer) and CSV. | V |
| Tax/account codes required? | Not for the balance import. Grouping is applied inside the product. | V |
| Approval, licence, NDA, certification? | **For the API: yes.** Credentials are requested and approved by Wolters Kluwer first, and the scope is whatever they approve. **For the file import: none.** | V |
| Recommended Accountrix path | **The file import, with an Axcess-flavoured `.xlsx`.** Not the API — the gate costs weeks and the file is documented today. | — |
| Fallback manual path | CSV through the Data Import Wizard instead of `.xlsx`. | V |
| Supporting documentation | CCH Axcess help and the Open Integration page, below. | V |

## The documented file contract

- **Excel 2013 or newer, `.xlsx`, containing exactly one worksheet.**
- **Accounts begin on row 2.** Row 1 must be blank or used for header
  information.
- The first four to six columns, in order:

  | # | Column | Required |
  | - | --- | --- |
  | 1 | Account Number | optional |
  | 2 | Account Name | **required** |
  | 3 | Current Period Debit Balance | **required** |
  | 4 | Current Period Credit Balance | **required** |
  | 5 | Prior Period Debit Balance | optional |
  | 6 | Prior Period Credit Balance | optional |

- **Only one instance of each account number and each account name.**
- **Zero-balance cells are left blank**, not written as `0.00`.
- **Up to 40,000 accounts** and associated balances.

## What this changes about Accountrix's output

**Separate debit and credit columns, both required** — the opposite of CCH
ProSystem fx Engagement, which wants one signed column. Same vendor. This is the
clearest evidence in the research that §7 is right to ask the debit/credit
question of every target individually.

Three more consequences:

1. **`.xlsx`, and it is required here.** This is the first target where the
   XLSX question Phase 158 deferred stops being optional: CSV is accepted
   through the Data Import Wizard, so an adapter can ship without a spreadsheet
   writer — but the documented primary path is `.xlsx` with a one-worksheet
   rule, and a firm following the vendor's own instructions will look for it.
2. **Blank, not zero.** Accountrix's `decimal()` renders `0` as `0.00`. An
   Axcess adapter has to emit an empty cell instead, which is a rendering rule
   and not a figure change — exactly the kind of thing §11's
   `totals_reconcile_to_source` check exists to catch if it goes wrong.
3. **Account *name* is the required key, not the number.** Uniqueness is
   demanded on both. Accountrix guarantees unique numbers per company and does
   **not** guarantee unique names — two accounts may legitimately be called
   "Miscellaneous". That is a destination-specific validation this adapter must
   add, and it is a genuine new check rather than one borrowed from §11.

## What must be confirmed before this becomes an adapter

1. **Whether row 1 may carry our own header** or must be truly blank. "Blank or
   used for header information" reads permissive; a sample import would settle
   it.
2. **The CSV variant's rules.** The Data Import Wizard is described as
   "flexible", which is not a contract.
3. **The API's real surface.** If the Trial Balance Management APIs can take
   general ledger detail as well as balances, the long-term path may be the API
   after all — but that is an approval conversation, not a research question.
4. **Pricing claims seen in the research are not vendor figures.** A
   third-party consultancy page quoted a fixed fee "from $10,000" and a "$499
   AI-Ready Audit" for custom development. That is **S**, it is that firm's
   pricing rather than Wolters Kluwer's, and it must not be repeated as though
   it were the cost of the API.

## Sources

- [Importing Trial Balance Data — CCH Axcess Engagement](https://help-engagement.cchaxcess.com/Engagement/Content/Trial-Balances/Uploading%20Trial%20Balance%20Data.htm)
- [Importing Trial Balance Data — CCH Axcess Financial Prep](https://help-financialprep.cchaxcess.com/FinPrep/Content/Trial-Balances/Uploading%20Trial%20Balance%20Data.htm)
- [Re-Importing Trial Balance Data](https://help-engagement.cchaxcess.com/Engagement/Content/Trial-Balances/Re-import%20the%20Trial%20Balance%20data.htm)
- [KB: How do I import trial balance information from Microsoft Excel into CCH Axcess Engagement?](https://support.cch.com/kb/solution/000219516/000219516?IsNewArticle=True)
- [CCH Axcess Open Integration APIs](https://www.wolterskluwer.com/en/solutions/cch-axcess/open-integration)
- [CCH Axcess Engagement Essentials / Financial Prep](https://www.wolterskluwer.com/en/solutions/cch-axcess/financial-prep)
- [KB: What is Token Authentication (OAuth 2.0) for CCH Axcess Open Integration Platform?](https://support.cch.com/kb/solution/000106115/000106115)
