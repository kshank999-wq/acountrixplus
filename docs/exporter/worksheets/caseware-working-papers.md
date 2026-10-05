# Caseware Working Papers

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** workpapers · **Finding:** file import
**Vendor:** Caseware International · **Product family:** Working Papers (desktop)

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | None found for the desktop product. Caseware's REST API is a **Cloud** product; see `caseware-cloud`. | — |
| Private/partner API? | Not established. | — |
| Desktop SDK or local bridge? | Not required for import. Working Papers has its own import wizards and reads ordinary files. | V |
| Imports a trial balance directly? | **Yes.** `Engagement → Import → Excel File` opens the Excel Import Wizard; `Engagement → Import → ASCII Text File` opens the ASCII wizard. | V |
| Imports GL detail? | **Yes, and separately.** Under *Components to import* you choose either *Chart of accounts and general ledger balances* or *General ledger detail* — **each data type must come from a separate file.** | V |
| Imports adjusting journal entries? | Not through this route. Working Papers is where adjustments are *made*; it then exports them onward to tax. | S |
| File formats | ASCII: `.txt`, `.csv`, `.rtf`, `.prn`. Excel: `.xls`, `.xlsx`, `.xlsm`, `.xlt`, `.xltm`, `.xlsb`, `.xlam`. | V |
| Tax/account codes required? | Not for import. Tax export codes are assigned *inside* Working Papers afterwards, on the Trial Balance Tax tab, and are what its onward exports need. | X |
| Approval, licence, NDA, certification? | **None.** This is a documented user-facing import of ordinary files. No programme to join. | V |
| Recommended Accountrix path | **Two CSV files, which Accountrix already produces.** `chart_of_accounts.csv` plus `trial_balance.csv` for the first component, `general_ledger.csv` for the second. The one-file-per-component rule maps onto the package as it stands. | — |
| Fallback manual path | The same files, with the firm driving the wizard. There is no non-manual path, so the fallback *is* the path. | — |
| Supporting documentation | Caseware's own Working Papers documentation, below. | V |

## Why this is the one to build first

Of the fourteen Priority 1 targets this has the fewest unknowns and no gate in
front of it. It takes plain CSV, its import is documented and user-driven, and
its component split — chart and balances in one file, ledger detail in another —
is the split Accountrix's universal package already has.

It is also the right *place* in a firm's workflow. Working Papers is where a
client's trial balance arrives before any return is prepared, and from there
Caseware exports onward to UltraTax CS, Lacerte, ProSeries, GoSystem and CCH
ProSystem fx Tax. One adapter here reaches five tax products through a path
their own vendors already support — which is worth more than five adapters
written against five undocumented formats.

## What must be confirmed before this becomes an adapter

1. **The file requirements page.** Caseware's docs say the file "must meet the
   file requirements for successful import" and the summary did not enumerate
   them. Column names, header-row handling, and the debit/credit convention are
   all unconfirmed.
2. **Zero-balance accounts are not imported automatically.** Documented, and it
   matters: Accountrix's `opening_balances.csv` deliberately includes every
   account so a firm can tie to last year's signed trial balance. Whether that
   file is usable here, or needs the zero rows dropped, is a question for a
   sample import.
3. **Which Working Papers versions.** The documentation is versioned by year
   (2018–2023 all have pages) and the wizards changed. §7 asks which versions
   are supported and this worksheet cannot say.

## Sources

- [Importing a Trial Balance — Working Papers](https://documentation.caseware.com/latest/Audit/en/Content/User_Client_File_Setup/t_Using_the_Import_Feature.htm)
- [Import from ASCII or Excel — Working Papers](https://documentation.caseware.com/2019/WorkingPapers/en/Content/Engagements/File-Preparation/Imports/Import-ASCII-Excel.htm)
- [Importing a Trial Balance from Excel/ASCII](https://my.caseware.com/s/article/Importing-a-Trial-Balance-from-ExcelASCII?language=en_US)
- [How do I import a Trial Balance using a csv?](https://my.caseware.com/s/article/How-do-I-import-a-Trial-Balance?language=en_US)
- [USA Tax year export — Working Papers](https://documentation.caseware.com/2022/WorkingPapers/en/Content/Practice/Tax/Tax-USA/USA-Tax-Year-Export.htm)
- [Caseware — Working Papers docs](https://www.caseware.com/docs/en/desktop/working-papers)
