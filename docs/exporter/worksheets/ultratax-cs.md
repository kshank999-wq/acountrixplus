# Thomson Reuters UltraTax CS

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** file import, through a closed list
**Vendor:** Thomson Reuters · **Family:** CS Professional Suite

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | None found for UltraTax CS. Thomson Reuters' developer portal publishes **GoSystem** APIs; UltraTax is not among them. | S |
| Private/partner API? | Not established. What exists in its place is a **named third-party vendor list** — see below. | S |
| Desktop SDK or local bridge? | No SDK. Import is `Utilities → Third Party → <vendor>` inside UltraTax, or a tax-code retrieval from a CS-suite application. | S · V |
| Imports a trial balance directly? | **Yes — but only from a recognised source.** Either a CS-suite application (Accounting CS, Workpapers CS) by tax code, or a file from one of the named third-party products. | V |
| Imports GL detail? | No. UltraTax wants balances summarised by tax code, not ledger lines. | V |
| Imports adjusting journal entries? | No. Adjustments are made in the workpaper product and arrive in the balances. | V |
| File formats | `.dwi` from Caseware Working Papers. Other named vendors have their own formats. No documented generic format. | X |
| Tax/account codes required? | **Yes, and this is the mechanism.** *"A tax code tells UltraTax CS where an account balance belongs in the tax return."* It summarises related accounts, applies whole-dollar rounding, and transfers values to the matching input screens. For Accounting CS and Workpapers CS clients, **tax codes can only be assigned from within those applications.** | V |
| Approval, licence, NDA, certification? | **Unresolved, and this is the blocker.** Appearing in `Utilities → Third Party` implies a vendor relationship with Thomson Reuters. Nothing found describes how a product joins that list. | — |
| Recommended Accountrix path | **Indirect, via a product already on the list.** Accountrix → CSV → Caseware Working Papers (or Workpapers CS) → that product's own UltraTax export. | X |
| Fallback manual path | The preparer keys the balances, or Accountrix's universal package is read alongside the return. | — |
| Supporting documentation | Thomson Reuters help on tax codes; Caseware's documentation of the `.dwi` route. | V · X |

## The finding that decides this worksheet

UltraTax CS does **not** appear to have a generic trial balance import. It has a
menu of named vendors:

> Third-party applications that can export to UltraTax CS include Dillner's Full
> Contact Accounting System (FCAS), Universal Business Computing Company,
> CaseWare Working Papers, Client Ledger System, ProSystem fx Engagement,
> Accounting for Practitioners, and Accountant's Relief.

And the import is reached as `Utilities → Third Party → Caseware Working
Papers`, i.e. **the vendor is the menu item**. Accountrix is not on that list,
and no documentation found says how a product gets on it.

This is precisely what Exporter spec §7 was written to catch:

> Do not assume an API exists. Professional tax and workpaper products often
> rely on vendor-specific import files, trial-balance mappings, desktop
> utilities, SDKs, partner programs, or controlled integrations.

A *controlled integration*. Writing a `.dwi` file and hoping UltraTax reads it
under the Caseware menu item would be impersonating another vendor's export —
which is both a technical guess and the wrong thing to do.

**So this is the highest-priority target and the one furthest from an adapter**,
and the next step is a question to Thomson Reuters rather than more research.

## The indirect path, which is real and available today

Accountrix's universal CSV already imports into Caseware Working Papers (see
that worksheet) and into Workpapers CS. Both export onward to UltraTax CS by
routes their own vendors document. So a client's books can reach UltraTax today
with no adapter at all — through one extra product the firm almost certainly
already owns.

That is worth stating to a customer plainly rather than describing UltraTax as
unsupported. It also changes the build order: an adapter for Caseware Working
Papers reaches UltraTax, Lacerte, ProSeries, GoSystem and CCH ProSystem fx Tax
through paths those vendors already support.

## What must be confirmed before this becomes an adapter

1. **How a product joins the third-party list.** Is there a partner programme,
   a specification, a fee, a certification? This is the whole question and it
   needs an answer from Thomson Reuters.
2. **Whether the third-party vendor list claim is accurate.** It came through
   **S** — a search summary of a page about UltraTax add-ons, not a vendor
   page naming the menu. It is the most consequential claim in this worksheet
   and the least well sourced. Confirm it against
   `cs.thomsonreuters.com/.../ovw_integrat.htm` before acting.
3. **The `.dwi` format**, if the list question is ever resolved favourably.
4. **The tax code scheme.** UltraTax tax codes are per entity type and
   per-product; the mapping store (§10) would need to hold them.
5. **The FIRM database requirement.** Accounting CS and Workpapers CS need a
   *FIRM* database for data sharing with UltraTax CS to work at all, which is a
   deployment fact a firm must satisfy and Accountrix cannot.

## Sources

- [Import general ledger balances with tax codes — UltraTax CS](https://www.thomsonreuters.com/en-us/help/ultratax-cs/integration/integrate-with-cs-suite/import-general-ledger-balances)
- [Import account balances into UltraTax CS — Accounting CS](https://www.thomsonreuters.com/en-us/help/accounting-cs/integrate-with-cs-professional-suite/import-account-balances-into-ultratax-cs)
- [Integration with UltraTax CS: Account balances — Onvio](https://www.thomsonreuters.com/en-us/help/onvio/trial-balance/import-account-balances-into-ultratax-cs)
- [UltraTax CS integration with other applications](https://cs.thomsonreuters.com/ua/ut/2018_cs_us_en/utwapp/common/ovw_integrat.htm)
- [Export to UltraTax CS — Caseware Working Papers](https://documentation.caseware.com/2022/WorkingPapers/en/Content/Practice/Tax/Tax-USA/Export-UltraTax.htm)
- [Export to UltraTax Utility (ProSystem fx Engagement v7.0) release notes (PDF)](https://support.cch.com/updates/engagement/pdf/UltraTax%20Utility%20Release%20Notes_US.pdf)
