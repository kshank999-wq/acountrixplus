# CCH ProSystem fx Engagement

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** workpapers · **Finding:** file import
**Vendor:** Wolters Kluwer · **Also sold as:** CCH ProSystem fx Workpaper Manager

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | None found for this product. Wolters Kluwer's Open Integration APIs are a **CCH Axcess** platform; this is the on-premise predecessor. | S |
| Private/partner API? | Not established for this product. | — |
| Desktop SDK or local bridge? | Not required for import. The trial balance import is a user-driven Excel/paste operation. | V |
| Imports a trial balance directly? | **Yes**, and the column contract is documented in detail — see below. There is also a *Paste TB Import* that takes the clipboard. | V |
| Imports GL detail? | Not established through the trial balance import. | — |
| Imports adjusting journal entries? | Entries are **made here**, not imported: reclassifying, tax and potential journal entries, recurring and reversing, and journal entries may be posted directly to tax codes rather than to an account, which avoids setting up a contra account for a tax-only adjustment. | S |
| File formats | Microsoft Excel. Also clipboard paste. | V |
| Tax/account codes required? | Not for the balance import. Optional extra columns may carry **account group mappings to non-tax grouping lists**. Tax grouping is applied inside Engagement afterwards, and is what the onward `COMPFILE.TXT` to ProSystem fx Tax needs. | V |
| Approval, licence, NDA, certification? | **None.** A documented user-facing import. | V |
| Recommended Accountrix path | A **CCH-flavoured trial balance CSV**: account number first, description second, one signed balance column. Not the universal file — see the column contract. | — |
| Fallback manual path | The same file, pasted rather than imported, via Paste TB Import. | V |
| Supporting documentation | CCH's own help and knowledge base, below. | V |

## The column contract, which is the most precisely documented of the fourteen

- **The first two columns are fixed**: `Account #` then `Description`. They are
  required fields and **must be the first two columns** of the imported data.
- **One column per balance** to be imported.
- **Debits and credits go in one column.** Credits are differentiated with a
  minus sign `-` or in parentheses.
- Account numbers **may not contain** `'` `|` `:` `"` `,` `(` `)` `*` `?` and
  **may not exceed 64 characters**. No trailing spaces after the number or the
  description.
- Account descriptions may not contain `|` `*` `?` `"` and may not exceed 255
  characters.
- Balance columns must contain **no formulas and no non-numeric data**.

## What this changes about Accountrix's output

This is the finding that matters most across the whole research, because it is
specific enough to be wrong about:

**Accountrix's `trial_balance.csv` has separate `debit` and `credit` columns.
This product wants one signed column.** And CCH Axcess Engagement — the same
vendor's cloud successor — wants the *opposite*: separate debit and credit
columns, required. Two products, one vendor, two conventions.

So the adapter cannot be "the universal package with a different file name".
That is exactly what §6's adapter seam is for, and it is reassuring that the
first target examined closely proves the seam was worth declaring.

Two smaller consequences:

- The **64-character account number limit** is a real constraint that §11's
  `account_identifiers_portable` check does not test for. It tests characters,
  not length. A destination-specific length rule belongs in the adapter's own
  validation rather than in the universal check.
- Accountrix's portable identifier set is `[A-Za-z0-9.-]`, which is strictly
  inside what this product forbids. The universal check is sound here.

## What must be confirmed before this becomes an adapter

1. **Header row.** Whether the import expects one, and whether the wizard maps
   columns by position or by name. The documentation describes column *order*
   as fixed, which suggests position — but a wizard that also reads names would
   change the file.
2. **Which balance column is which.** "One column for each balance column to be
   imported" implies the wizard asks. Current period, prior period, beginning
   balance — the mapping is unconfirmed.
3. **Whether this product is still being sold.** It is the on-premise
   predecessor to CCH Axcess Engagement and Wolters Kluwer is plainly moving
   firms to the cloud. §7's first research item is *"confirm that the product is
   active"*, and this worksheet cannot.

## Sources

- [Importing Trial Balance Data — CCH Axcess Engagement help](https://help-engagement.cchaxcess.com/Engagement/Content/Trial-Balances/Uploading%20Trial%20Balance%20Data.htm)
- [KB: How do I import numbers into my CCH ProSystem fx Engagement or Workpaper Manager Trial Balance from a Microsoft Excel document?](https://support.cch.com/kb/solution/000166410/sw2191?IsNewArticle=True)
- [KB: How do I import Chart of Accounts information into my CCH ProSystem fx Engagement or Workpaper Manager Trial Balance from a Microsoft Excel document?](https://support.cch.com/kb/solution/000166410)
- [KB: How do I format my data before importing into a trial balance using Paste TB Import?](https://support.cch.com/kb/solution/000183237/000183237?IsNewArticle=True&language=en_US)
- [ProSystem fx Engagement 6.5 User Guide (PDF)](https://support.cch.com/updates/Engagement/pdf/guides_tab/version6/65/Engagement%206.5%20User%20Guide.pdf)
- [CCH ProSystem fx Workpaper Manager — product page](https://taxna.wolterskluwer.com/professional-tax-software/prosystem-fx/workpaper-manager)
