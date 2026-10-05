# Thomson Reuters Workpapers CS

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** workpapers · **Finding:** file import
**Vendor:** Thomson Reuters · **Family:** CS Professional Suite

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | None found. Thomson Reuters' developer portal publishes GoSystem APIs; the CS Professional Suite is not represented. | S |
| Private/partner API? | Not established. | — |
| Desktop SDK or local bridge? | No SDK. Import is the **Spreadsheet Import Wizard** inside the product. | V |
| Imports a trial balance directly? | **Yes.** *"The working trial balance feature in Workpapers CS enables you to quickly import data from a spreadsheet"*, and there is a documented Spreadsheet Import Wizard route for QuickBooks-produced spreadsheets that is generic in shape. | V |
| Imports GL detail? | Not established through the spreadsheet route. | — |
| Imports adjusting journal entries? | Made here, not imported. Workpapers CS is where adjustments are entered before being transferred onward. | V |
| File formats | Spreadsheet. Also a documented path from ATB for Windows via an exported spreadsheet. | V |
| Tax/account codes required? | **Not for import — but required before the onward transfer.** Tax codes for Workpapers CS clients *"can only be assigned or corrected from within"* Workpapers CS, and they are what UltraTax CS reads. | V |
| Approval, licence, NDA, certification? | **None for the import.** A deployment prerequisite exists: Workpapers CS requires a **FIRM database** for integration and data sharing with UltraTax CS. | V |
| Recommended Accountrix path | **A spreadsheet for the Spreadsheet Import Wizard: chart of accounts with beginning balances, then current balances.** | — |
| Fallback manual path | The same file, firm-driven — which is the path. | V |
| Supporting documentation | Thomson Reuters help, below. | V |

## Why this target matters more than its own import

Workpapers CS is the **way into UltraTax CS** that does not require being on
Thomson Reuters' closed third-party vendor list:

> The working trial balance feature in Workpapers CS enables you to quickly
> import data from a spreadsheet, link trial balance data directly to Microsoft
> Word and Excel files, and then transfer your adjusted balance to UltraTax CS,
> GoSystem Tax RS, and a variety of other tax applications.

So one spreadsheet adapter reaches both Priority 1 Thomson Reuters tax products
through the vendor's own supported route, with the firm assigning tax codes once
inside a product they already own. Given what the UltraTax worksheet found —
that UltraTax's third-party import is a named-vendor menu Accountrix is not on —
this is the Thomson Reuters answer, and it should be read as the plan rather
than as a consolation.

It also sets the correct expectation to a customer: Accountrix does not write a
file UltraTax reads. It writes a file the firm's workpaper product reads, and
that product feeds the return. That is §16's own framing — *"hand those books to
the accountant's professional software in the exact structure that software
expects"* — and the structure Workpapers CS expects is a spreadsheet.

## What must be confirmed before this becomes an adapter

1. **The Spreadsheet Import Wizard's column contract.** Documented pages exist
   for importing a chart of accounts with beginning balance amounts, and for
   QuickBooks-produced spreadsheets specifically. Whether a generic spreadsheet
   is accepted, and with which headings, is unconfirmed — and the QuickBooks
   page may describe a *shape* rather than a source, which would make it the
   specification to build against.
2. **Beginning balances versus current balances.** There is a separate
   documented step for entering beginning balances and for adding a beginning
   balance column to a trial balance view. Accountrix produces
   `opening_balances.csv` already; which file goes where is unconfirmed.
3. **Whether CSV is accepted or only Excel.**
4. **The FIRM database prerequisite** — a firm without one cannot pass balances
   to UltraTax at all, and an adapter should say so rather than let the handover
   fail silently at the far end.
5. **Product currency.** Thomson Reuters has an *Engagement Manager* migration
   path documented *from* Workpapers CS, which suggests this product is being
   succeeded. §7's first question is whether a product is active.

## Sources

- [Workpapers CS trial balance software — product page](https://tax.thomsonreuters.com/us/en/cs-professional-suite/workpapers-cs)
- [Workpapers CS brochure (PDF)](https://tax.thomsonreuters.com/content/dam/ewp-m/images/tax/en/artworked-images/brand-updates-2025/workpapers-cs-brochure1.pdf)
- [Spreadsheet import — account balances from QuickBooks (Workpapers CS)](https://www.thomsonreuters.com/en-us/help/workpapers-cs/integrate-with-quickbooks/spreadsheet-import-account-balances-from-quickbook)
- [Import from ATB for Windows — Workpapers CS](https://www.thomsonreuters.com/en-us/help/workpapers-cs/integrate-data-with-other-applications/import-from-atb-for-windows)
- [Enter beginning balances for a client's Chart of Accounts](https://www.thomsonreuters.com/en-us/help/workpapers-cs/trial-balance/chart-of-accounts/enter-beginning-balances-for-a-clients-coa)
- [Add a beginning balance column to a trial balance view](https://www.thomsonreuters.com/en-us/help/workpapers-cs/trial-balance/trial-balance-screen/add-a-beginning-balance-column)
- [Import general ledger balances with tax codes — UltraTax CS](https://www.thomsonreuters.com/en-us/help/ultratax-cs/integration/integrate-with-cs-suite/import-general-ledger-balances)
- [Workpapers CS or Accounting CS to Engagement Manager migration](https://www.thomsonreuters.com/en-us/help/engagement-manager/workpapers-cs-or-accounting-cs-migration/workpapers-cs-or-accounting-cs-migration)
