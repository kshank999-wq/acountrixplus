# 0159 — Fourteen worksheets, and what they found

**Status:** accepted
**Date:** 2026-10-05
**Phase:** 159

---

## What was asked for

ADR 0158 said that Priority 1 adapters require §13's integration worksheets
first, and that the research could not be done from training knowledge without
inventing vendor facts. The instruction was to do the research and write them.

Fourteen Priority 1 targets, twelve questions each, in
`docs/exporter/worksheets/`, registered in `src/modules/exporter/worksheets.ts`.

## The constraint that shaped the result

**Every vendor documentation host is blocked by this session's egress policy.**
`accountants.intuit.com`, `developer.intuit.com`, `tax.thomsonreuters.com`,
`cs.thomsonreuters.com`, `support.cch.com`, `help-engagement.cchaxcess.com`,
`download.cchaxcess.com`, `drakesoftware.com`, `kb.drakesoftware.com`,
`documentation.caseware.com`, `www.caseware.com`, `my.caseware.com`,
`riahelp.com`. Also `en.wikipedia.org`, which is how comprehensively: `WebFetch`
returned `EGRESS_BLOCKED` for every domain tried. Web *search* worked, and
returns a summary of each page it finds.

So the research is real and its evidence is second-hand. Every answer rests on a
summary of a page nobody on this side opened.

That could have been handled two ways. The worksheets could have been written as
though the pages had been read, with the citations standing in for having read
them — which is what a worksheet looks like when it is wrong, and §13's last
question (*"what official vendor documentation supports the decision"*) is a
clause about precisely this. Or the distinction could be made structural.

It is structural. Every answer carries a provenance mark — **V** for a vendor
page about that product, **X** for another vendor's documentation of it, **S**
for secondary, **—** for not established. Every worksheet is `status: 'draft'`.
`adapterMayBeBuilt` refuses all fourteen, and `tests/export-worksheets.test.ts`
asserts that `verifiedWorksheets()` is empty, so promoting one means coming here
and changing an assertion on purpose.

Phases 110 and 125 named the defect this avoids: a declaration argued from a
fact that is not a fact. Doing it in the register whose entire job is to be the
thing a reader trusts would have been the worst available version of it.

## The findings, and which ones change the design

### §7's warning, measured

> Do not assume an API exists.

| Finding | Count |
| --- | --- |
| File import | 10 |
| Programmatic | 2 |
| No third-party route at all | 2 |

**An exporter built on the assumption that professional software is reached
through APIs would have been wrong about twelve of fourteen.** And of the two
programmatic paths, one needs a form processed by a human at the vendor. That is
the single most valuable thing this research produced, because it is the
assumption a competent engineer would otherwise have made.

### A third finding value, argued rather than bent

`no-third-party-path` is new, and Phase 130's rule says argue a new enum value
rather than bending the nearest. The nearest was `unresearched`, and it would
have been wrong in the way that matters: it says *nobody has looked*, when the
truth for two targets is *somebody looked and the answer is that the vendor has
to open a door*. Those have different next steps — one is research, the other is
a phone call — and `mayExportTo` now gives them different sentences.

**UltraTax CS** does not appear to have a generic trial balance import. It has
`Utilities → Third Party → <vendor>`, where the vendor *is* the menu item, and
the documented list is Dillner's FCAS, Universal Business Computing, CaseWare
Working Papers, Client Ledger System, ProSystem fx Engagement, Accounting for
Practitioners and Accountant's Relief. Accountrix is not on it and nothing found
says how a product joins. §7 called this shape a *"controlled integration"*.

Writing a `.dwi` file and hoping UltraTax reads it under Caseware's menu item
would be impersonating another vendor's export — a technical guess and the wrong
thing to do besides. So UltraTax is reached **indirectly**, through Caseware
Working Papers or Workpapers CS, both of which export onward by routes their own
vendors document. That is a real capability available today, and it should be
told to a customer as one rather than described as unsupported.

Worth flagging against this ADR's own standard: **the closed-list claim is the
most consequential finding in the research and the least well sourced.** It came
through **S**. The worksheet says so and names confirming it as the first step.

**ProConnect Tax**'s only documented trial-balance ingress is QuickBooks Online
Accountant → *Prep for Taxes* → *Books to Tax*, inside Intuit's own stack.
Noting without resolving: §2 excludes QuickBooks Online as a *destination*
because it is a competitor, and ProConnect's one documented import is from it.
There is nothing to work around — §2 is about not building the way off
Accountrix as a feature of Accountrix, and it says nothing about ProConnect.
What it means is that this target waits on Intuit.

### One vendor, two conventions

**CCH ProSystem fx Engagement** wants debits and credits in a *single signed
column*, credits negative or parenthesised, with `Account #` and `Description`
fixed as the first two columns, account numbers capped at 64 characters and a
documented forbidden-character set.

**CCH Axcess Engagement** — the same vendor's cloud successor — wants *separate*
current-period debit and credit columns, both required, in a `.xlsx` with one
worksheet, accounts from row 2, unique account names, zero balances left blank,
up to 40,000 accounts.

Same vendor. Opposite conventions. This is why §7 asks the debit/credit question
of every target individually, and it is the best evidence yet that ADR 0158 was
right to declare §8's adapter seam before the second adapter existed: the first
two targets examined closely need different files, and neither is the universal
package with a different name.

Two smaller things fall out of it. Accountrix guarantees unique account *numbers*
per company and not unique *names*, so Axcess Engagement's uniqueness rule is a
genuine new destination-specific check rather than one borrowed from §11. And the
64-character limit is real: §11's `account_identifiers_portable` tests
characters, not length, and its `[A-Za-z0-9.-]` set is strictly inside what
ProSystem fx forbids, so the universal check is sound but silent on length.

### The one that cannot be a format

**Drake Tax**'s trial balance import takes Drake's own template, which is
generated per client, lives in the installed software's `TB` folder as
`<client>TB.xlsx`, requires macros enabled, and — documented in those words —
*"modifying the provided template results in a corrupt import."*

So the usual adapter shape does not apply. The file Drake wants is one Accountrix
would have to be handed, not one it can implement from a specification. The
honest adapter produces a sheet shaped like the template's data region for the
preparer to paste in, which means `generateManualImportInstructions` does more
work than the file — §8's optional-members design earning itself on the second
target examined.

### The one with no gate

**Caseware Cloud** is the only programmatic path in the fourteen that needs
nobody's permission. The *firm* registers its own API client and copies the
client ID and secret; authentication is OAuth 2.0 client credentials, described
as *"designed for confidential, server-to-server communication with no
end-user"* — the exact shape a server-side exporter wants, and notably not a
consent flow needing a hosted redirect. Caseware's API usage policy says in as
many words that customers may *"engage third-party developers to build
integrations using customer-issued API credentials."*

Every other programmatic path runs through an approval queue: Wolters Kluwer
approves credentials and their scope; Thomson Reuters processes an API request
form.

### The SDK that is the wrong answer

**Lacerte** has a published Intuit SDK — an ODBC driver and a COM/.NET library,
*"required in order to interact with Lacerte's encrypted tax data."* It is the
technically superior path and it is wrong here, for a deployment reason rather
than a preference: it runs on the machine where Lacerte is installed, and
Accountrix is a web application. Reaching it means shipping a Windows agent the
firm installs and keeps updated beside their tax software — a second product with
its own release cycle, support burden and security review, to deliver a file the
Trial Balance Utility reads anyway.

Recorded so it is a decision rather than an omission, and so the next person does
not spend a day rediscovering that it exists.

### The one to leave alone

**ProSeries** is the weakest of the fourteen and the recommendation is not to
build it. Every substantive answer is **S** — a 2012 trade review and community
threads — no current vendor page describing its trial balance import was reached,
and three separate community threads report the feature breaking across the 2020,
2022 and 2023 products. Its one promising lead is `.txf`, a published interchange
format, and that claim is from 2012.

Noting the asymmetry: Lacerte and ProSeries are both Intuit Windows tax products,
and Lacerte has an SDK and a documented Excel import while ProSeries has neither.
Second time in this research that one vendor's two products needed separate
worksheets.

## What this changed in the code

**`integration` came off `ExportDestination`.** Phase 158 stored it there; once
worksheets existed that was a second answer to a question the worksheet answers,
and the copy is the one that drifts — into a product decision about what to offer
a firm. `integrationFor(key)` reads it from the worksheet. `researched-unverified`
is a new state between `unresearched` and a verified finding.

**`mayExportTo` has four refusals where it had two**, and the four are the point:
an exclusion is a decision, no worksheet is an absence of research, a draft
worksheet is an absence of verification *and can name the outstanding question*,
and `no-third-party-path` is a finding. Each says something different about what
would change it, which is Phase 119's rule for when a refusal is worth writing.

## What was deliberately not added

A refusal for *verified worksheet, no adapter registered*. It is the obvious next
branch and it cannot fire today, because nothing is verified — and a branch that
cannot fire is Phase 121's defect from the other side. It belongs in `service.ts`
beside `adapterFor`, and **the first verified worksheet must add it**, because
until then that path throws `RegistryError` rather than a `Refusal` and so
reaches a person as "Something went wrong."

Written down here rather than built, which is the trade: a latent hole named in
an ADR against a dead branch asserted by a test.

## What is nominated next

**Spec §19's row-level security**, for the third time (ADRs 0157, 0158). Nothing
in this phase touched tenant isolation and it remains the only outstanding item
with a spec section behind it.

Then, from the Exporter spec and in this order, which the research decided rather
than the specification:

1. **Caseware Working Papers** — file, no gate, takes the CSV that already
   exists, and its component split is the one the universal package already has.
   One adapter here reaches five tax products through paths their vendors
   support.
2. **Caseware Cloud** — API, no gate.
3. **CCH Axcess Engagement** and **CCH ProSystem fx Engagement** — files, no
   gates, the most precisely documented column contracts of the fourteen.

All four are workpaper products, which is where a firm actually receives a
client's trial balance before any return is prepared. §14's own phase order puts
the tax adapters second and the workpaper adapters third; the research says to
swap them, because the tax products are the ones behind closed lists, vendor
templates and approval queues.

Each of those four still needs its worksheet verified first — which means
somebody opening the cited pages from a machine that can reach them.
