# Thomson Reuters GoSystem Tax RS

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** programmatic
**Vendor:** Thomson Reuters · **Deployment:** Cloud (enterprise)

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **Yes — the only Priority 1 tax target with a published API catalogue.** Thomson Reuters' developer portal lists **38 GoSystem Tax APIs**: check e-file status, **import or export tax return data**, print returns and more. | V |
| Private/partner API? | The same APIs, behind a request form. Not a separate private surface. | V |
| Desktop SDK or local bridge? | No. Cloud product, REST services. | V |
| Imports a trial balance directly? | **Yes.** GoSystem has a built-in Trial Balance that imports from spreadsheets, audit packages, general ledger packages, databases and client write-up packages, **for 1065 and 1120 returns**. | V |
| Imports GL detail? | Not established. The Trial Balance works at balance level. | — |
| Imports adjusting journal entries? | Not established. | — |
| File formats | Microsoft Excel into Trial Balance, with **template-based column mapping** and a drag-and-drop interface. JSON over REST for the APIs. | V |
| Tax/account codes required? | Mapping is done with a **template** — create a new one or use an existing one. So codes are required but the mapping is reusable, which is §10's mapping store in the destination's own product. | V |
| Approval, licence, NDA, certification? | **Yes, and the steps are documented.** Create an account at the Thomson Reuters developer portal, then **download and complete the GoSystem Tax RS API request form.** | V |
| Recommended Accountrix path | **The Excel/spreadsheet Trial Balance import first; the API second, when a customer sponsors the request form.** | — |
| Fallback manual path | The spreadsheet import, driven by the preparer — which is the recommended path, so the fallback is the API's absence rather than the file's. | V |
| Supporting documentation | Thomson Reuters help, the developer portal, and the annual RS Specifications PDFs. | V |

## Why the file first, even though the API is real

The API is genuine and it is the right long-term destination. It is also behind
a form that a human at Thomson Reuters processes, and §13's point is that the
sequence matters: research, then paperwork, then code. Shipping the spreadsheet
path does not block the API path and it gives a firm something this season.

Worth noting what the API is *for*, from its own description: e-filing,
printing, and importing or exporting **tax return data** — moving hundreds of
partners into a partnership return, updating a value in a return in real time.
That is return-level automation. The thing Accountrix has is a trial balance,
and the trial balance route into GoSystem is the built-in Trial Balance with a
spreadsheet. The two are complementary rather than alternatives, and conflating
them would be a mistake a worksheet exists to prevent.

## A documentation source worth keeping

Thomson Reuters publishes annual **GoSystem Tax RS Specifications** PDFs on
`riahelp.com` — one per tax year, each dated. That is the closest thing in the
whole research to a versioned, citable format specification, and §7's last
research item is *"determine how Accountrix will detect and support format/API
version changes."* Those documents are the mechanism: an adapter can name the
tax year's specification it was built against, which is exactly what
`supportedVersions` on `ExportAdapter` is for.

## What must be confirmed before this becomes an adapter

1. **The spreadsheet's column requirements.** "Template-based mapping" and
   "drag-and-drop" describe an interface, not a file contract. Unknown.
2. **Which entity types.** The Trial Balance is documented for **1065 and 1120**.
   1120-S, 990 and 1041 are unaddressed, and if the Trial Balance really is
   limited to two return types that materially narrows this target.
3. **What the API request form asks for.** Whether it requires a customer
   firm's sponsorship, a fee, an NDA, or a certification round.
4. **Preliminary balances.** There is a documented *Set up preliminary balances*
   step whose relationship to the Trial Balance import is unclear and may be
   the actual entry point.
5. **Whether `developers.thomsonreuters.com` and
   `developerportal.thomsonreuters.com` are the same portal.** Both appeared in
   the research, named differently in different places.

## Sources

- [GoSystem — Thomson Reuters Developer Portal](https://developerportal.thomsonreuters.com/gosystem)
- [Set up preliminary balances — GoSystem Tax RS](https://www.thomsonreuters.com/en-us/help/gosystem-tax-rs/trial-balance/preliminary-balances)
- [GoSystem Tax RS integration 2020 and later — Accounting CS](https://www.thomsonreuters.com/content/helpandsupp/en-us/help/accounting-cs/integrate-data-with-other-applications/gosystem-tax-rs-integration-2020-and-later.html)
- [GoSystem Tax RS integration 2019 and earlier — Accounting CS](https://www.thomsonreuters.com/en-us/help/accounting-cs/integrate-data-with-other-applications/gosystem-tax-rs-integration-2019-and-earlier)
- [GoSystem Tax RS Specifications for Tax Year 2021 (PDF)](https://www.riahelp.com/html/2021/guides/common/2021_RS_Specifications_GoSystem.pdf)
- [GoSystem Tax RS Specifications for Tax Year 2020 (PDF)](https://www.riahelp.com/html/2020/guides/common/2020_RS_Specifications_GoSystem.pdf)
- [GoSystem Tax RS Specifications for Tax Year 2019 (PDF)](https://www.riahelp.com/html/2019/guides/common/2019_RS_Specifications_GoSystem.pdf)
- [Tax File Activation on web for GoSystem Tax RS API — SurePrep](https://www.thomsonreuters.com/en-us/help/sureprep/integration-with-gosystem-tax-rs/tax-file-activation-web-for-gosystem-tax-rs-api)
- [Add GoSystem Tax RS as a vendor in engagements — Engagement Manager](https://www.thomsonreuters.com/en-us/help/engagement-manager/products-that-integrate-with-engagement-manager/tax-applications/add-gosystem-tax-as-a-vendor)
