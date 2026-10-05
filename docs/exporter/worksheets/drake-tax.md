# Drake Tax

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** file import, into the vendor's own template
**Vendor:** Drake Software · **Deployment:** Windows desktop (also hosted, also Drake Tax online)

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **No.** Reported plainly: Drake Tax has no public API, and neither the online version nor Drake-hosted setups expose one to third-party applications. | S |
| Private/partner API? | **No open developer access.** Drake's *Partner Products* list is a vetted add-on marketplace, not a developer platform. | S |
| Desktop SDK or local bridge? | None published. Integrations that exist are **file-based** — partners move files in and out of Drake's folders. | S |
| Imports a trial balance directly? | **Yes.** `Data Entry Menu → Import → Trial Balance Import`, for Corporate, Sub-S and Partnership returns. | V |
| Imports GL detail? | No. | V |
| Imports adjusting journal entries? | No. | — |
| File formats | **Microsoft Excel `.xls` / `.xlsx`, and it must be Drake's own template.** | V |
| Tax/account codes required? | **Yes, per row.** The template carries an `Import to – Screen and line` column naming the Drake screen and line each amount goes to. | V |
| Approval, licence, NDA, certification? | None for the import. There is nothing to be approved for. | S |
| Recommended Accountrix path | **None yet — and that is the finding.** See below. | — |
| Fallback manual path | Accountrix's universal `trial_balance.csv` beside the return, with the preparer filling Drake's template or keying the figures. | — |
| Supporting documentation | Drake's knowledge base and help, below. | V |

## The problem, stated plainly

The template is not a format. It is a file that lives inside the installed
software:

> Trial balance templates are saved in the **TB folder** of your software. The
> file name consists of the client name, `TB` (for trial balance), and the file
> extension for Excel (`.xls` or `.xlsx`).

And it may not be altered:

> **Modifying the provided template results in a corrupt import.** To ensure
> that the information is imported correctly, the spreadsheet template provided
> must be used with the format unchanged.

It also requires **Excel 2003 or later with macros enabled**, which says the
template is macro-bearing rather than a plain sheet.

So the usual adapter shape — Accountrix writes a file, the firm imports it —
does not apply. The file Drake wants is generated **by Drake, per client**, and
Accountrix would have to fill a workbook it has never seen without changing
anything about it. That is not a format Accountrix can implement from a
specification; it is a file it would have to be handed.

**Of the fourteen Priority 1 targets this is the one with the clearest
documentation and the least actionable path**, and the two facts are related:
the documentation is clear precisely because it is telling the user to use the
vendor's file.

## What an adapter could honestly do

Three options, in the order they should be tried:

1. **Produce a sheet shaped like the template's data region** — Account Title,
   Debit, Credit, and `Import to – Screen and line` — for the preparer to paste
   into their own `<client>TB.xlsx`. This is the realistic answer: it removes
   the keying without touching the template. It needs the spreadsheet writer
   Phase 158 deferred, or a CSV the preparer pastes.
2. **Ask Drake whether the template can be populated programmatically**, and
   whether its macros tolerate externally written cells. A question with a real
   possibility of "no".
3. **Route through Caseware Working Papers**, which does not export to Drake —
   so this one has no indirect path, unlike UltraTax.

Option 1 is what the adapter should be, and it means Drake's adapter produces
something explicitly labelled *for pasting*, with `generateManualImportInstructions`
doing more work than the file itself. §8's optional-members design, earning
itself on the second target examined.

## What must be confirmed before this becomes an adapter

1. **The template's exact data region** — which row data starts on, the exact
   column order, and whether the `Import to` column takes a code or free text.
2. **Whether pasted values survive the macros.**
3. **Rows 1–3** carry Company Name and Year End information and are documented
   as needing updating before data entry. Whether a paste should include them is
   unconfirmed.
4. **Reliability.** The documentation is clear; community reports of
   import features breaking across Drake versions are not reassuring, and a
   format this tightly coupled to a product version needs a version check.

## Sources

- [Drake Tax — Trial Balance Import (KB 11166)](https://kb.drakesoftware.com/kb/Drake-Tax/11166.htm)
- [Trial Balance Import — Drake help, 2022](https://www.drakesoftware.com/sharedassets/help/2022/trial-balance-import.html)
- [Drake Tax — 1120 Consolidated or Composite Return (KB 10815)](https://kb.drakesoftware.com/kb/Drake-Tax/10815.htm)
- [Drake Tax — 4562: Import Assets from Spreadsheet (KB 15982)](https://kb.drakesoftware.com/kb/Drake-Tax/15982.htm)
- [Drake Software User's Manual, Tax Year 2010 Supplement: Corporations (1120) (PDF)](https://support.drakesoftware.com/PDF/2010_1120.pdf)
- [SUPPLEMENT: Partnerships (1065) (PDF)](https://www.drakesoftware.com/sharedassets/manuals/2019/partnerships.pdf)
- Secondary, on the absence of an API: [Claude + Drake Tax: what the integration can and can't do](https://www.usecarly.com/blog/claude-drake-tax-integration/)
