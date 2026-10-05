# Thomson Reuters Accounting CS

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** workpapers · **Finding:** file import
**Vendor:** Thomson Reuters · **Family:** CS Professional Suite

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | None found. | S |
| Private/partner API? | Not established. | — |
| Desktop SDK or local bridge? | No SDK. Spreadsheet import inside the product. | V |
| Imports a trial balance directly? | **Yes.** A documented chart-of-accounts spreadsheet import that carries balances, and separate spreadsheet imports for transactions, vendors and customers. | V |
| Imports GL detail? | **Yes — there is a documented *Spreadsheet import — transactions*.** This is the only one of the fourteen with a documented transaction-level import, which makes it the only plausible home for Accountrix's `general_ledger.csv`. | V |
| Imports adjusting journal entries? | Not established as a distinct import; transactions are the nearest documented route. | — |
| File formats | Excel and CSV. Accounting CS *"can import and export from/to QuickBooks, Excel and CSV."* | V |
| Tax/account codes required? | **Optional on import, and supported.** Sample spreadsheets are published in two shapes: one with current-year and prior-year balances, and one **with type and tax code information**. Tax codes are what UltraTax CS then reads. | V |
| Approval, licence, NDA, certification? | None for the import. The **FIRM database** prerequisite applies for data sharing with UltraTax CS. | V |
| Recommended Accountrix path | **A chart-of-accounts spreadsheet with balances**, using the published sample as the specification, with the type-and-tax-code variant once §10's mapping store exists. | — |
| Fallback manual path | The same file, firm-driven. | V |
| Supporting documentation | Thomson Reuters help, below. | V |

## The documented rules

Fewer than the CCH products publish, but each one is a real constraint:

- **The spreadsheet must be closed, and remain closed for the whole import**,
  and **must not be password protected.**
- **Maximum amount is 999,999,999.99** when importing balances into the chart
  of accounts.
- **Sample spreadsheets are published**, in a current/prior-year variant and a
  type-and-tax-code variant. Those samples are the specification, and getting
  them is the first verification step.
- **Re-importing an existing account zeroes its balances for the selected
  dates and then imports only what is in the file.** Not additive.

That last rule is worth dwelling on, because it is a destructive-by-design
import and the kind of thing an exporter should warn about rather than discover.
A partial file does not merge — it replaces, for the dates covered. An adapter
that produced a filtered trial balance, say only accounts with activity, would
silently zero everything it omitted. Accountrix's `opening_balances.csv` uses
`includeZero: true` for an unrelated reason and happens to be the right shape;
`trial_balance.csv` filters zero-activity accounts out and is the wrong one.

## Why this target is interesting beyond its own import

Two reasons.

It is the **one documented transaction-level import** in the Priority 1 set.
Every other target wants balances, and §5's *"general ledger detail"* section
has had nowhere to go. Here it does.

And like Workpapers CS it is a **route into UltraTax CS**, by the tax-code
mechanism, without needing a place on Thomson Reuters' closed third-party
vendor list. Between the two, Accountrix can reach UltraTax through whichever
CS-suite product a firm already runs.

## What must be confirmed before this becomes an adapter

1. **Get the sample spreadsheets.** They are published and they are the
   contract. Everything else in this worksheet is secondary to that.
2. **The transaction import's columns**, which would decide whether
   `general_ledger.csv` can be reused or needs its own shape.
3. **Which posting period balances land in.** The documentation says balances
   import "directly into the period selected for the balance column", which
   implies the period is chosen in the wizard rather than carried in the file.
4. **The zero-then-import behaviour**, confirmed against a sample, because an
   adapter that gets this wrong deletes a client's balances rather than failing.
5. **Product currency**, as for Workpapers CS — there is a documented migration
   path to Engagement Manager.

## Sources

- [Import a chart of accounts from a spreadsheet — Accounting CS Client Access](https://www.thomsonreuters.com/content/helpandsupp/en-us/help/accounting-cs-client-access/chart-of-accounts-and-posting-periods/chart-of-accounts/import-coa-from-spreadsheet.html)
- [Import account balances and the chart of accounts from QuickBooks — Accounting CS](https://www.thomsonreuters.com/en-us/help/accounting-cs/integrate-with-quickbooks/import-account-balances-and-the-chart-of-accounts)
- [Spreadsheet import — account balances from QuickBooks](https://www.thomsonreuters.com/en-us/help/accounting-cs/integrate-with-quickbooks/spreadsheet-import-account-balances-from-quickbook)
- [Spreadsheet import — Account Balances from QuickBooks (CS platform help)](https://cs.thomsonreuters.com/ua/acct_pr/wpcs/cs_us_en/acs_platform/plat_spreadsheet_import_qb.htm)
- [Spreadsheet import — transactions](https://www.thomsonreuters.com/en-us/help/accounting-cs-client-access/import-data/spreadsheet-import-transactions)
- [Spreadsheet import — vendor data](https://www.thomsonreuters.com/en-us/help/accounting-cs-client-access/vendors-and-tax-agents/spreadsheet-import-vendor-data)
- [Import account balances into UltraTax CS — Accounting CS](https://www.thomsonreuters.com/en-us/help/accounting-cs/integrate-with-cs-professional-suite/import-account-balances-into-ultratax-cs)
- [GoSystem Tax RS integration 2020 and later — Accounting CS](https://www.thomsonreuters.com/content/helpandsupp/en-us/help/accounting-cs/integrate-data-with-other-applications/gosystem-tax-rs-integration-2020-and-later.html)
