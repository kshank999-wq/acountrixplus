# Caseware Cloud / Caseware Engagements

**Status:** draft — not verified against a page anybody opened
**Priority:** 1 · **Kind:** workpapers · **Finding:** programmatic
**Vendor:** Caseware International · **Deployment:** Cloud

---

## §13's twelve questions

| Question | Answer | |
| --- | --- | :-: |
| Public API? | **Yes.** Cloud API is *"structured around REST"*; you register an API client, acquire a token, and call endpoints. | V |
| Private/partner API? | Not needed — see the approval row. | V |
| Desktop SDK or local bridge? | No. | V |
| Imports a trial balance directly? | **Yes, both ways.** A documented CSV/Excel import in the product, and the API. | V |
| Imports GL detail? | The product imports general ledger detail as a separate component (as the desktop Working Papers does). Over the API, not established. | V · — |
| Imports adjusting journal entries? | Caseware Cloud **exports** adjustments and trial balance data; importing them is not established. | V |
| File formats | `.xlsx` or `.csv`. JSON over REST for the API. | V |
| Tax/account codes required? | Not for import. Columns are mapped in an *Assign Fields* step, with *Assign columns* offering automatic assignment and an *Import as* drop-down per column. Tax export codes are assigned afterwards, for the onward export to tax. | V |
| Approval, licence, NDA, certification? | **None from Caseware to Accountrix.** The *customer* registers the API client in Cloud API settings and issues the credentials; Caseware's API Usage Policy explicitly permits customers to *"engage third-party developers to build integrations using customer-issued API credentials, provided that the work is performed solely on the customer's behalf and for the customer's internal business purposes."* | V |
| Recommended Accountrix path | **The CSV/Excel import first, the API second** — and the API here is a genuinely realistic second step, unlike every other target. | — |
| Fallback manual path | The same CSV, with the firm driving the *Assign Fields* step. | V |
| Supporting documentation | Caseware Cloud documentation and the API usage policy, below. | V |

## Why this is the only target whose API is reachable without permission

Every other programmatic path in the fourteen runs through a vendor's approval
queue: Wolters Kluwer approves credentials and their scope; Thomson Reuters
processes an API request form. Caseware inverts it — **the firm generates the
client ID and secret itself**, in its own Cloud settings, and the usage policy
says in as many words that it may then have a third party build against them.

That removes the thing §13 exists to surface. There is no programme to join, no
tier, no certification, and no commercial conversation standing between research
and code. Authentication is **OAuth 2.0 client credentials** — *"designed for
confidential, server-to-server communication with no end-user"* — which is
exactly the shape a server-side exporter needs, and notably *not* a user-consent
flow that a web app would have to host a redirect for.

So the build order across all fourteen is: Caseware Working Papers (file, no
gate), then Caseware Cloud (API, no gate), then the CCH engagement products
(file, no gate). Three adapters, no permissions, and between them the place a
firm actually receives a client's trial balance.

## What must be confirmed before this becomes an adapter

1. **Which endpoint takes a trial balance.** The API is documented as REST with
   a token; *that there is a trial balance endpoint* is an inference from the
   product's capabilities, not something the research established. This is the
   single thing to check first, and if it is wrong this target collapses to
   `file-import` like the desktop product.
2. **The CSV column vocabulary.** The *Import as* drop-down implies a fixed set
   of field names. Caseware's docs reference a "Trial balance described" page
   listing the dataset's fields; that page was not reached.
3. **`Include zero-balance accounts`** is an option on import — so unlike the
   desktop product, zero rows are the firm's choice. Accountrix's
   `opening_balances.csv` includes them deliberately, which fits.
4. **Rate limits and token lifetime**, neither established.
5. **Whether "Caseware Engagements" and "Caseware Cloud" are one product** for
   this purpose. §3 names them together and the documentation uses both.

## Sources

- [Get started with Cloud API — Caseware](https://www.caseware.com/docs/en/cloud/cloud-time/cloud-api/get-started-with-cloud-api)
- [API Settings — Caseware Cloud](https://www.caseware.com/docs/en/cloud/caseware-cloud/api-settings)
- [Caseware API Usage Policy](https://www.caseware.com/legal/api-usage-policy)
- [Develop cloud apps — Caseware Developers](https://developers.caseware.com/develop-cloud-apps)
- [Import the client's data from a CSV or Excel file — Caseware Cloud](https://www.caseware.com/docs/en-us/cloud/caseware-cloud/engagement-management/data-import/import-the-trial-balance-from-a-csv-or-excel-file)
- [Export adjustments and trial balance data — Caseware Cloud](https://www.caseware.com/docs/en/cloud/caseware-cloud/engagement-management/accounts-and-analysis/export-adjustments-and-trial-balance-data)
- [Set up and import a trial balance containing dimensions](https://www.caseware.com/docs/en-us/cloud/caseware-cloud/engagement-management/planning/set-up-trial-balance-with-dimensions)
- [Import the trial balance from a CSV or Excel file (web apps)](https://docs.caseware.com/2020/webapps/31/en/Engagements/File-Preparation/Import-the-trial-balance-from-a-CSV-or-Excel-file.htm?region=us)
