# Intuit ProSeries Tax

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** file import, and the weakest of the fourteen
**Vendor:** Intuit · **Deployment:** Windows desktop (also hosted)

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **No.** Reported in Intuit's own developer community: there is no public API or SDK for ProSeries — only the Lacerte interface for tax-prep products, Trial Balance import for ProSeries, and document tools. | S |
| Private/partner API? | Not established. | — |
| Desktop SDK or local bridge? | **None for ProSeries.** The Lacerte SDK does not cover it. | S |
| Imports a trial balance directly? | **Yes**, via a built-in trial balance import. | S |
| Imports GL detail? | No. | — |
| Imports adjusting journal entries? | No. | — |
| File formats | **Accountant's Trial Balance (ATB)**, a **generic dBase trial balance file**, or `.txf` from *"any accounting program that can generate .txf files."* | S |
| Tax/account codes required? | Not established. A trial balance arriving from ATB is already mapped to return lines by ATB. | — |
| Approval, licence, NDA, certification? | None known — there is nothing to be approved for. | — |
| Recommended Accountrix path | **None yet.** `.txf` is the only candidate and it is unspecified for this purpose. | — |
| Fallback manual path | Accountrix's universal `trial_balance.csv` beside the return, keyed by the preparer. | — |
| Supporting documentation | **Thin, and almost entirely secondary.** See below. | S |

## This is the worksheet that says "do not build this yet"

Every substantive answer here is **S**. The format list came from a 2012 trade
review and community threads; no current Intuit page describing ProSeries
trial balance import was reached, and the import is described in community
posts as having broken across recent versions:

- The Accountant's Trial Balance link to ProSeries business returns was
  reported not working for the 2020 product.
- A thread from March 2023 reports updates killing the Trial Balance Setup link.
- Another reports automatic ATB import crashing and corrupting ProSeries 2022.

Those are user reports, not vendor statements, and they may be stale or
misdiagnosed. But three independent reports of the same feature failing across
three product years is a reason to ask before building, not after.

**Of the fourteen Priority 1 targets this is the one with the least documented,
least stable and least specified path.** The honest recommendation is to leave
ProSeries on the universal package and spend the effort on a target whose
format is written down.

## The `.txf` question

The one documented-sounding thread is `.txf` — *Tax Exchange Format* — accepted
from *"any accounting program that can generate .txf files"*. If that is true
and current, it would be the most portable tax-import format in the whole set,
because it is a published interchange format rather than a vendor's private
layout.

It is also the claim most likely to be out of date: `.txf` is an old format
associated with consumer tax products, and a 2012 review is not evidence about
the 2026 product. **Confirm whether ProSeries still accepts `.txf` for business
returns, and what record types it expects.** If yes, this target jumps from
worst to best. If no, it stays last.

## What must be confirmed before this becomes an adapter

1. **Whether `.txf` import exists in the current product**, and its record
   specification.
2. **Whether the ATB link works** in the current release, and whether ATB's
   file format is published.
3. **The dBase trial balance layout**, if that route is real — field names and
   types.
4. **Whether Intuit intends ProSeries to receive third-party trial balances at
   all**, which the absence of any current documentation rather suggests it
   does not.

Note the asymmetry worth recording: Lacerte and ProSeries are both Intuit
desktop tax products, and Lacerte has a published SDK and a documented Excel
trial balance import while ProSeries has neither. Same vendor, same deployment,
opposite answers — the second time in this research that one vendor's two
products needed separate worksheets.

## Sources

- [Import Existing Client Data to ProSeries — Intuit](https://accountants.intuit.com/tax-software/proseries/data-conversion/)
- [ProSeries Add-Ons: Tax Tools for Professional Tax Preparers](https://accountants.intuit.com/tax-software/proseries/integrations/)
- [Trial balance — Intuit Accountants Community](https://accountants.intuit.com/community/proseries-tax-discussions/discussion/trial-balance/00/238045)
- [Accountant's Trial Balance software link to ProSeries 2020 is NOT working — community](https://accountants.intuit.com/community/proseries-tax-discussions/discussion/accountant-s-trial-balance-software-link-to-proseries-2020/00/107299)
- [FIX the Trial Balance Setup link — community, March 2023](https://accountants.intuit.com/community/proseries-tax-discussions/discussion/fix-the-trial-balance-setup-link-updates-killed-the-link-1-2/00/253592)
- [Automatic Import of ATB program crashing and corrupting ProSeries 2022 — community](https://accountants.intuit.com/community/proseries-product-discussions-9/automatic-import-of-atb-program-crashing-and-corrupting-proseries-2022-63077)
- [API or SDK for ProSeries — does it exist? — community](https://accountants.intuit.com/community/proseries-product-discussions-9/api-or-sdk-for-proseries-does-it-exist-or-any-workarounds-64547)
- [2012 Review of Intuit ProSeries — CPA Practice Advisor](https://www.cpapracticeadvisor.com/2012/03/28/2012-review-of-intuit-proseries/7270/)
- [Export to ProSeries (TurboTax) — Caseware Working Papers (USA tax year export)](https://documentation.caseware.com/2022/WorkingPapers/en/Content/Practice/Tax/Tax-USA/USA-Tax-Year-Export.htm)
