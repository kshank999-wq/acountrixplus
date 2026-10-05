# Intuit ProConnect Tax

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** tax · **Finding:** no third-party path established
**Vendor:** Intuit · **Deployment:** Cloud

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **None found for third parties.** Intuit's developer platform publishes QuickBooks APIs and a Lacerte SDK; nothing for ProConnect. API-directory sites claiming a ProConnect API are aggregator pages, not Intuit documentation. | S |
| Private/partner API? | Not established. | — |
| Desktop SDK or local bridge? | N/A — cloud product. | — |
| Imports a trial balance directly? | **Yes, from QuickBooks Online Accountant, and that is the documented mechanism.** *Prep for Taxes* in QBOA produces a trial balance and exports the client's accounting data to ProConnect Tax; **Books to Tax** then flows it into the return and auto-populates it. Tax adjustments can be reconciled against the imported trial balance and the tax mapping reclassified before import. | V |
| Imports GL detail? | Not established. | — |
| Imports adjusting journal entries? | Adjustments are made against the imported trial balance inside the workflow, not imported as entries. | V |
| File formats | **None documented for a third party.** The documented path is an Intuit-to-Intuit data flow, not a file. | — |
| Tax/account codes required? | Tax mapping is applied in QBOA's *Prep for Taxes* before the books reach the return. | V |
| Approval, licence, NDA, certification? | **Unresolved.** There is no published programme to apply to. | — |
| Recommended Accountrix path | **None. The universal package, and say so plainly.** | — |
| Fallback manual path | Accountrix's universal `trial_balance.csv`, keyed or pasted by the preparer into the return. | — |
| Supporting documentation | Intuit's own pages describe the QuickBooks route and nothing else. | V |

## Why this one has no path, and why that is the interesting answer

ProConnect's trial balance story is **QuickBooks Online Accountant**. Every
documented route runs `QBOA → Prep for Taxes → ProConnect`, inside Intuit's own
stack, with no file leaving it and no third-party entry point.

That is a coherent product decision and it puts Accountrix in a specific
position worth naming. Exporter spec §2 excludes QuickBooks Online as an export
*destination* because it is a direct competitor. ProConnect's only documented
import is from that competitor. So the one path into this Priority 1 target runs
through the product the specification forbids exporting to.

**There is no contradiction to resolve and nothing to work around.** §2's
exclusion is about not building the migration path off Accountrix as a feature
of Accountrix; it says nothing about ProConnect. What it means practically is
that this target cannot be reached without Intuit opening a door, and no amount
of research changes that. The next step is a question to Intuit, not another
search.

It is also worth stating what *is* available and declining it. A third-party
trial balance product documents its own ProConnect workflow, which suggests
some route exists for a vendor willing to build against it. Finding out what
that is means asking them or asking Intuit; inferring the format from a
competitor's behaviour would be guessing at a private interface, which is the
same mistake as impersonating Caseware's `.dwi` under UltraTax's menu.

## What must be confirmed before this becomes an adapter

1. **Whether Intuit offers any third-party trial balance ingress to ProConnect
   at all.** This is the whole question.
2. **Whether the Lacerte SDK's data model reaches ProConnect.** Both are Intuit
   tax products and ProConnect is sometimes described as the cloud sibling of
   Lacerte; if they share a tax-data model, the SDK's field layout might be the
   specification even if the transport is not. Speculative, and worth one
   question.
3. **Whether *Prep for Taxes* can consume an imported trial balance** from
   outside QuickBooks — i.e. whether a firm can bring Accountrix's trial balance
   into QBOA as a working paper without the books living there. That would be an
   odd route and it is the only one visible.

Until one of those is answered, this worksheet's recommendation is the honest
one: ProConnect stays on the universal package, and a customer asking for it
should be told the reason rather than given a date.

## Sources

- [ProConnect Tax Features — Intuit](https://accountants.intuit.com/tax-online/features)
- [ProConnect Tax and QuickBooks Online: get in the cloud — Intuit Tax Pro Center](https://accountants.intuit.com/taxprocenter/practice-management/get-in-the-cloud-proconnect-tax-quickbooks-online/)
- [ProConnect plus QuickBooks Integration](https://accountants.intuit.com/tax-software/tax-online/proconnect-plus-quickbooks/)
- [ProConnect Tax Online resources for accountants — QuickBooks help](https://quickbooks.intuit.com/learn-support/en-us/help-article/accountant-reports/proconnect-tax-online-resources-accountants/L9HA22Xxs_US_en_US)
- [Integrations for ProConnect Tax](https://accountants.intuit.com/tax-software/tax-online/integrations/)
- [What's new with ProConnect Tax](https://accountants.intuit.com/support/en-us/help-article/product-preferences/new-proconnect-tax/L78DbHwg9_US_en_US)
- [Digital workflow in Intuit ProConnect Tax — Tax Pro Center](https://accountants.intuit.com/taxprocenter/practice-management/workflow-tools/transform-digital-workflow-with-intuit-proconnect-tax/)
- [Connect products and apps — ProConnect Tax help topic](https://accountants.intuit.com/support/en-us/proconnect-tax/help-topic/account-management/connect-products-and-apps/3)
