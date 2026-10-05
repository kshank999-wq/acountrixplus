# CCH ProSystem fx Tax

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** file import
**Vendor:** Wolters Kluwer

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | None found for this product. Wolters Kluwer's Open Integration APIs are a **CCH Axcess** platform. | S |
| Private/partner API? | Not established for this product. | — |
| Desktop SDK or local bridge? | No SDK. **G/L Bridge** and **G/L Direct** are features *inside* Tax, driven by the preparer, that read a file Accountrix would produce. | V |
| Imports a trial balance directly? | **Yes, two ways.** *G/L Bridge* reads a `COMPFILE.TXT` produced by Engagement or Caseware. *G/L Direct* imports delimited or fixed-width ASCII straight into the return's chart-of-accounts worksheet grid. | V |
| Imports GL detail? | Not into the return. Tax wants balances mapped to tax codes, not ledger lines. | S |
| Imports adjusting journal entries? | Not as entries. Adjustments arrive already reflected in the balances, or via Engagement's *Dynalink*, which dynamically links an Engagement trial balance to the return. | S |
| File formats | `COMPFILE.TXT` (G/L Bridge). For G/L Direct: tab-delimited `.txt` or comma-delimited `.csv`, or fixed-width ASCII. | V |
| Tax/account codes required? | **Yes for G/L Bridge** — a *Grouping List* is selected at export time and is what maps accounts to the return. **Optional for G/L Direct** — a custom template may designate a tax code column. | V |
| Approval, licence, NDA, certification? | **None.** Both are documented user-facing imports with no programme in front of them. | V |
| Recommended Accountrix path | **G/L Direct with a custom import template.** Accountrix writes a plain delimited file; the firm defines the template once and reuses it. No vendor relationship required. | — |
| Fallback manual path | The preparer keys the balances, or routes through Caseware / Engagement, both of which produce `COMPFILE.TXT`. | X |
| Supporting documentation | CCH Tax help, the G/L Direct fact sheet, and Caseware's export documentation. | V · X |

## The G/L Direct file contract

This is the generic way in, and it is the most useful single finding for a tax
adapter because it needs no vendor relationship:

> The G/L Direct system allows for standard or custom imports of trial balance
> data into the tax return chart of accounts worksheet grid. You can import
> delimited or fixed width ASCII text files.

For a file produced from Excel, the documented rules are:

- Saved as **Text (Tab delimited) `.txt`** or **CSV (Comma delimited) `.csv`**
- **No headers, no footers, no total lines**
- **No dollar signs** in amount fields
- **No commas** in amount fields
- **Negative numbers carry a minus sign**, not brackets or parentheses

A **custom import template** designates each column's data type — account
number, account description, tax code — so the column order is Accountrix's to
choose, provided the template matches. There is also a list of **standard**
templates for named general-ledger and write-up packages; Accountrix is not one
of them, and a custom template is the answer rather than a request to be added.

## What this changes about Accountrix's output

**No header row.** Accountrix's `trial_balance.csv` has one, and every other
target examined either wants one or tolerates one. This is the only target that
forbids it outright, which is a good argument for the adapter seam: a header is
not a detail an exporter can be casually right about.

The rest, Accountrix already satisfies. `decimal()` emits no dollar sign, no
thousands separator, and a leading minus rather than parentheses — three of the
five rules met by a function written for a different reason in Phase 103.

**No total lines** also matters: Accountrix's `profit_and_loss.csv` writes
totals as rows marked by an empty `account_number`. That is right for a
statement a person reads and wrong for a file a grid parses, and it is why the
tax adapter must build its own trial balance file rather than reuse the
statements.

## What must be confirmed before this becomes an adapter

1. **Whether a tax code column is required in practice**, or whether the
   preparer can map accounts to return lines inside the grid after import. The
   difference decides whether §10's mapping store is a prerequisite for this
   adapter or merely a convenience.
2. **The Grouping List question.** If G/L Direct also wants a grouping list,
   this target needs the mapping store and moves behind it.
3. **Fixed-width layout**, if it turns out to be preferred — field widths are
   unconfirmed.
4. **Product currency.** Like ProSystem fx Engagement, this is the on-premise
   predecessor to an Axcess product, and §7 asks first whether a product is
   still active.

## Sources

- [Importing Accounting Data Using G/L Bridge — CCH Tax help](https://download.cchaxcess.com/pfxbrowserhelp/TaxHelp/Content/ImportExport/IE_Importing%20Accounting%20Data%20to%20Tax.htm)
- [Using G/L Direct Data Import](https://z001download.cchaxcess.com/pfxbrowserhelp/TaxHelp/Content/Product%20Interfaces/GL_GL%20Direct%20Data%20Import%20Overview.htm)
- [Importing Custom G/L Direct Data](https://z001download.cchaxcess.com/pfxbrowserhelp/TaxHelp/Content/Product%20Interfaces/GL_Importing%20Custom%20GL%20Direct%20Data.htm)
- [Importing Standard G/L Direct Data](https://z001download.cchaxcess.com/PfxBrowserHelp/TAXHelp/Content/Product%20Interfaces/GL_Importing%20Standard%20GL%20Direct%20Data.htm)
- [G/L Direct fact sheet (PDF)](https://support.cch.com/apioss/Knowledge/GetAttachement?AttachementId=0684R00000IzAW5QAN&AttachementName=Fact+Sheet.pdf.pdf)
- [KB: How do I create an export file or compfile from Engagement or Workpaper Manager to import into ProSystem fx Tax using G/L Bridge?](https://support.cch.com/kb/solution/How-do-I-create-an-export-file-or-compfile-from-CCH-ProSystem-fx-Engagement-or-Workpaper-Manager-to-import-into-CCH-ProSystem-fx-Tax-using-G-L-Bridge?language=en_US)
- [Export to CCH ProSystem fx Tax — Caseware Working Papers](https://documentation.caseware.com/2023/WorkingPapers/en/Content/Practice/Tax/Tax-USA/Export-CCH-ProSystem-fx-Tax.htm)
- [Setting up a Tax Export for CCH ProSystem fx — Caseware](https://documentation.caseware.com/2018/WorkingPapers/en/Content/Accounting_and_Assurance/Tax/USA/t_CCH_ProSystem_fx_Tax_Setup.htm)
