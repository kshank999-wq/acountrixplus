# CCH Axcess Tax

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** file import
**Vendor:** Wolters Kluwer

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **Yes.** The CCH Axcess **Open Integration Platform** publishes a Tax API Kit and an Engagement API Kit; documentation is at `developers.cchaxcess.com`, signed into with CCH Axcess credentials. Authentication is OAuth 2.0 token authentication. | V |
| Private/partner API? | The same platform. Three partner tiers, entry level *Licensed Consultant*, intended for integrators testing API data or building custom integrations. | V |
| Desktop SDK or local bridge? | No. Cloud product. **G/L Direct** is a feature inside the return. | V |
| Imports a trial balance directly? | **Yes.** G/L Direct imports trial balance data from Excel into the return. There is also a documented KB path specifically for Axcess. | V |
| Imports GL detail? | Not into a return. The Engagement side of the platform handles general ledger data. | V |
| Imports adjusting journal entries? | Journal-entry management over the API is described as a **future** enhancement. Not today. | V |
| File formats | Tab-delimited `.txt` or comma-delimited `.csv` (and fixed-width ASCII) for G/L Direct; JSON over REST for the API. | V |
| Tax/account codes required? | A custom G/L Direct template may designate a tax code column. The G/L Direct trial balance view presents data in two views — **accounts** and **tax codes** — so codes are how the return is populated. | V |
| Approval, licence, NDA, certification? | **For the API: yes** — credential approval comes first and the scope is whatever Wolters Kluwer approves. Annual API Tool Kit licensing is reportedly no longer required for firms not developing in-house. **For G/L Direct: none.** | V · S |
| Recommended Accountrix path | **G/L Direct with a custom import template**, the same file as `cch-prosystem-fx-tax`. The API is the better long-term answer and is behind a gate; the file works today and needs nobody's permission. | — |
| Fallback manual path | The preparer keys the balances, or imports via CCH Axcess Engagement and carries them across inside the platform. | V |
| Supporting documentation | Wolters Kluwer's Open Integration pages and the CCH knowledge base, below. | V |

## Why the file and not the API

This is the only Priority 1 tax target with a genuine, documented REST API, and
the recommendation is still the file. Three reasons, in order of weight:

1. **The gate is real and it is first.** Credential approval precedes
   everything, and the scope of what the credentials expose is whatever the
   vendor approves. That is a commercial conversation on Wolters Kluwer's
   timetable, not an engineering task on ours.
2. **G/L Direct costs nothing and is available now.** A custom template is
   defined once by the firm. Accountrix writes a delimited file. No
   relationship, no tiers, no licence.
3. **The API's trial balance surface is on the Engagement side**, not the Tax
   side. The Tax API Kit's documented use cases are workflow — e-filing,
   printing, return data — rather than "here is a client's trial balance". The
   thing Accountrix wants to push is a trial balance.

So the API is recorded as the right destination to revisit **once a firm asks
for it and will sponsor the credential request**, which is the honest trigger:
a partner application made speculatively, before any customer needs it, is work
spent on a permission nobody is waiting for.

## What must be confirmed before this becomes an adapter

1. **Whether Axcess G/L Direct has the same file rules as ProSystem fx.** The
   two are documented separately — `support.cch.com` KB 000167887 is
   Axcess-specific — and this worksheet assumes they match. That assumption is
   the first thing to test, and it is the kind of assumption that produces a
   file rejected without a useful message.
2. **Whether a tax code column is mandatory.**
3. **The partner tiers' actual terms.** Tier names came through clearly; what
   each tier permits did not.
4. **Pricing figures in the research are not vendor figures.** A consultancy
   page quoted "from $10,000" for custom development and a "$499 AI-Ready
   Audit". That is that firm's pricing, not Wolters Kluwer's, and must not be
   repeated as the cost of API access.

## Sources

- [CCH Axcess Open Integration APIs](https://www.wolterskluwer.com/en/solutions/cch-axcess/open-integration)
- [KB: How do I import trial balance data from Microsoft Excel to an Axcess return using G/L Direct?](https://support.cch.com/kb/solution/000167887/how-do-i-import-trial-balance-data-from-microsoft-excel-to-an-axcess-return-using-g-l-direct)
- [KB: What is Token Authentication (OAuth 2.0) for CCH Axcess Open Integration Platform (OIP)?](https://support.cch.com/kb/solution/000106115/000106115)
- [Frequently asked questions about tax preparation APIs — Wolters Kluwer](https://www.wolterskluwer.com/en/expert-insights/frequently-asked-questions-about-tax-preparation-apis)
- [Integrating CCH Axcess with enterprise software via APIs](https://www.wolterskluwer.com/en/expert-insights/integrating-cch-axcess-with-enterprise-software-via-apis)
- [API-first productivity utilities in CCH Axcess](https://www.wolterskluwer.com/en/expert-insights/api-first-productivity-utilities-in-cch-axcess)
- [Wolters Kluwer introduces CCH Axcess Marketplace](https://www.wolterskluwer.com/en/news/wolters-kluwer-introduces-cch-axcess-marketplace)
- [Using G/L Direct Data Import](https://z001download.cchaxcess.com/pfxbrowserhelp/TaxHelp/Content/Product%20Interfaces/GL_GL%20Direct%20Data%20Import%20Overview.htm)
