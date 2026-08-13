# Accountrix Plus

**Product Framework & AI Coding Agent Development Specification**
Version 1.0 · August 10, 2026

> Markdown rendering of `Accountrix_Plus_Development_Spec_v1_0.docx`, committed so
> the specification is version-controlled alongside the code it governs. The
> Google Drive `.docx` remains the source of truth for edits — update it there,
> then refresh this file.

A unified business operating system combining simple daily bookkeeping, professional
accounting, client/proposal management, marketing, design tools, and optional AI services.

---

## 1. Product Vision

Accountrix Plus is designed to give business owners one simple operating environment for the
financial and client-facing work that is normally fragmented across accounting software,
spreadsheets, proposal tools, email marketing systems, and design applications. The
owner-facing experience must remain simple enough for daily use on desktop or mobile, while the
Accounting area must provide the controls, auditability, reports, and permissions expected by
professional accountants and bookkeepers.

The central design principle is one connected data model: a lead can become a proposal, a
proposal can become a client/job, the resulting invoices and payments can flow into bookkeeping,
and lost opportunities can automatically move into an appropriate marketing pipeline.

## 2. Product Architecture: Primary Workspaces

| Workspace | Primary User | Purpose |
| --- | --- | --- |
| Dashboard | Owner / Manager | At-a-glance cash, uncategorized transactions, proposals, wins/losses, receivables, marketing activity, and action items. |
| Bookkeeping | Owner / Staff / Bookkeeper | Bank feeds, transaction review, rules, categorization, receipts, transfers, splits, matching, and daily books. |
| Reconciliation | Owner / Bookkeeper / Accountant | Fast bank and credit-card reconciliation with statement balances, exceptions, and completion history. |
| Clients & CRM | Owner / Sales / Staff | Leads, prospects, clients, contacts, communications, jobs/projects, notes, documents, and relationship history. |
| Proposals & Design | Owner / Sales / Designer | Create branded estimates/proposals/contracts with reusable content, legal clauses, pricing, e-signature, and rich visual design. |
| Marketing | Owner / Marketing | Segment prospects and clients, nurture strategic accounts, create campaigns and collateral, and measure engagement. |
| Accounting | Accountant / Bookkeeper / Controller | General ledger, journals, financial statements, closing controls, tax-ready reporting, audit trail, and professional tools. |
| Company Studio | Owner / Admin | Company profile, brand kit, logos, colors, fonts, standard terms, proposal templates, marketing templates, and reusable assets. |
| AI Module | Optional paid add-on | AI bookkeeping assistance, drafting, design assistance, marketing intelligence, business insights, and automation. |

## 3. MVP Priority: Daily Bookkeeping

The first build should make routine bookkeeping dramatically easier than conventional accounting
software.

- Secure bank and credit-card connection through an aggregation provider; use a provider
  abstraction layer so Plaid or another vendor can be replaced without rewriting the bookkeeping
  domain.
- Import posted and pending transactions with source account, date, amount, merchant/description,
  transaction identifier, and available metadata.
- Deduplicate imports and maintain immutable source identifiers.
- Transaction Inbox optimized for rapid review on desktop and mobile.
- Standard chart of accounts automatically installed during onboarding, with industry-specific
  additions.
- One-tap category selection from the chart of accounts, searchable by account name/number.
- User-created categorization rules based on merchant, description, amount, account, transaction
  type, or combinations.
- Recurring vendor memory: after confirmation, future matching transactions can be suggested or
  automatically categorized according to user preference.
- Split transactions across multiple accounts/classes/jobs; identify transfers; match payments to
  invoices; attach receipts/documents.
- Bulk categorization and bulk rule creation.
- Review states: New, Suggested, Needs Review, Categorized, Matched, Excluded, Reconciled.
- Undo/history for user actions and a complete audit trail.
- Mobile workflow designed for several transactions at a time so bookkeeping becomes a continuous
  habit rather than a month-end project.

## 4. Reconciliation

- Separate reconciliation workspace for every bank/credit-card account.
- Enter statement ending date and ending balance; calculate cleared balance and difference in real
  time.
- Filter/search transactions, mark cleared, identify duplicates/missing items, and surface
  unresolved differences.
- Lock completed reconciliation periods according to permissions, with controlled reopen
  capability.
- Store reconciliation reports and history.
- AI add-on may explain likely causes of discrepancies, but must never silently alter books.

## 5. Chart of Accounts & Industry Onboarding

Every company begins with a conventional accounting structure (Assets, Liabilities, Equity,
Revenue, Cost of Goods Sold/Cost of Sales, Operating Expenses, Other Income, Other Expense) and
can customize it. Industry selection configures suggested accounts, terminology, dashboard cards,
and optional modules without creating incompatible accounting systems.

| Business Type | Initial Specialized Capabilities |
| --- | --- |
| Professional Services | Projects, retainers, reimbursable expenses, time/expense billing |
| Construction / Trades | Job costing, estimates, change orders, progress billing, retainage, subcontractors |
| Retail | Inventory, COGS, sales channels, sales tax, purchase orders |
| Restaurant / Food Service | Inventory/food cost, POS imports, tips, daily sales summaries |
| Manufacturing | Raw materials, WIP, finished goods, BOM/costing |
| Real Estate / Property | Properties, tenants, rents, CAM/expenses, property-level reporting |
| Creative / Media | Projects/productions, contractors, rights/assets, project budgets |
| Healthcare / Practice | Service revenue, providers, locations, payment categories; compliance integrations handled separately |
| Nonprofit | Funds/restrictions, grants, donors, program reporting |
| E-commerce | Marketplace/payment processor feeds, inventory, fees, returns |
| Automotive / Repair | Jobs, parts, labor, estimates, customer vehicles |
| Personal Care / Appointment Services | Appointments/service revenue, staff/contractor splits, products |
| Wholesale / Distribution | Inventory, purchasing, customers, warehouses |
| General / Other | Standard accounting + configurable modules |

## 6. Clients, Leads & Opportunity Pipeline

- Unified contact/company records with lead, prospect, active client, former client, vendor, or
  strategic-target status.
- Website lead intake endpoint/widget/API so requests for proposals can enter Accountrix Plus
  automatically.
- Opportunity pipeline: New Inquiry → Qualified → Proposal Draft → Proposal Sent → Viewed →
  Follow-up → Negotiation → Won / Lost / Dormant.
- Every opportunity stores source, owner, expected value, probability, proposed services/products,
  dates, communications, files, and activity history.
- Won proposal can create a client, job/project, contract, invoice schedule, and accounting
  dimensions without re-entry.
- Lost/no-decision opportunities retain permitted contact information and can be routed into
  marketing segments based on consent and communication rules.
- Loss-reason capture (price, timing, competitor, no response, scope, internal cancellation,
  other) for analytics.

## 7. Proposal / Estimate / Document Designer

Build a shared visual design engine used by both Proposals and Marketing. The goal is a powerful
browser-based vector/layout environment inspired by professional design tools, while keeping
common business tasks approachable.

- Artboard/page system with multiple page sizes, guides, rulers, snapping, grids, zoom, layers,
  grouping, alignment/distribution, lock/hide, undo/redo.
- Vector primitives: text, lines, rectangles, ellipses, paths/shapes, fills, strokes, gradients,
  opacity, shadows, corner controls, transforms, and reusable components.
- Image and logo placement, crop/mask, SVG import/export where practical, PDF export,
  print-quality output, and web-view proposal output.
- Rich typography, paragraph/character styles, tables, pricing tables, headers/footers, page
  numbering, brand styles, reusable blocks, and master templates.
- Dynamic merge fields for company/client/contact/project/proposal data.
- Proposal components: cover, executive summary, scope, deliverables, schedule, exclusions,
  assumptions, fee table, optional items, terms, legal clauses, signature/acceptance.
- Reusable legal/terms library with versioning and company-approved clauses.
- Estimate calculations, taxes/discounts, optional selections, deposits, milestones, and
  expiration dates.
- Client-facing link with view tracking, acceptance/e-signature integration, comments/questions,
  version history, and PDF download.
- Template gallery by industry and company-specific template library.

The first release should prioritize business-document layout features; advanced Illustrator-class
path editing can be phased in after the core proposal workflow is stable.

## 8. Shared Marketing Creative Studio

- Reuse the same design engine for flyers, one-sheets, capability statements, email graphics,
  social graphics, presentations, and campaign assets.
- Company Studio provides a single brand kit so proposal and marketing assets remain consistent.
- Support images, embedded/linked video for digital collateral, buttons/links, QR codes, and
  reusable campaign templates.
- Assets can be associated with campaigns, contacts, companies, opportunities, or client records.

## 9. Proposal Analytics & Sales Dashboard

- Proposal counts and value by Draft, Sent, Viewed, Won, Lost, Expired, and No Decision.
- Win rate by count and dollar value; average proposal size; average time to decision; pipeline
  value; forecast value.
- Performance by salesperson, service/product, industry, lead source, geography, and time period.
- Track proposal opens/views and follow-up activity where technically and legally appropriate.
- Lost-opportunity dashboard with loss reasons and re-engagement eligibility.
- Automatic handoff from qualified lost/dormant opportunities to marketing nurture segments.

## 10. Marketing & Strategic Prospecting

- Contact/company segmentation using tags, saved filters, lifecycle stage, industry, size,
  opportunity history, geography, and strategic importance.
- Allow users to identify high-value recurring-service targets ("strategic accounts") separately
  from ordinary contacts.
- Campaign calendar and recurring nurture sequences.
- Email campaign integration should use a dedicated email delivery provider; maintain
  unsubscribe/suppression/consent status.
- Track campaign sends, delivery, opens/clicks where available, replies, conversions, and
  opportunities generated.
- Marketing-to-sales loop: engagement can create tasks or reopen opportunities; sales outcomes feed
  campaign analytics.

## 11. Optional AI Module

AI should be sold as an optional module so provider usage costs can be covered by subscription
and/or metered limits. The core accounting product must remain fully functional without AI.

| AI Capability | Function |
| --- | --- |
| AI Bookkeeping Assistant | Suggest categories, explain transactions, identify likely duplicates/anomalies, propose rules, summarize uncategorized activity. User approval required for material accounting actions. |
| AI Reconciliation Assistant | Explain differences, suggest missing/duplicate transactions, summarize reconciliation issues. |
| AI Proposal Writer | Draft scope, executive summaries, exclusions, follow-up language, and reusable proposal content from structured company/service data. |
| AI Design Assistant | Generate layout suggestions, brand-consistent variations, background/graphic concepts, image prompts, and logo ideation; preserve user control and provenance. |
| AI Marketing Assistant | Draft personalized campaigns, segment audiences, suggest follow-up timing, create nurture sequences, and adapt content to company voice. |
| AI Strategic Account Assistant | Summarize relationship history, identify neglected high-value prospects, recommend next actions, and draft personalized outreach. |
| AI Business Insights | Explain cash-flow trends, receivables, proposal conversion, revenue concentration, expense changes, and operational trends in plain language. |

## 12. AI Technical Architecture

- Create an internal AI Gateway service rather than calling a model provider directly from the
  client application.
- Provider adapters allow one or more external model APIs to be selected by capability, price,
  latency, or customer plan.
- Central prompt/template registry with versioning, testing, and rollback.
- Tool/function layer exposes only approved application operations to AI; enforce the same
  permissions as the human user.
- Retrieval layer supplies only relevant company records and documents after tenant and permission
  checks.
- Structured outputs (JSON schemas) for categorization suggestions, campaign plans, proposal
  sections, and actions; validate before use.
- Human-in-the-loop approval for journal entries, reconciliations, bulk marketing actions,
  payments, account changes, and other consequential actions.
- AI usage ledger records tenant, user, feature, provider/model, token/usage units, cost estimate,
  latency, and outcome for billing and monitoring.
- Per-plan quotas, rate limits, cost ceilings, caching where safe, and feature-level metering.
- Do not use customer financial data to train shared models unless an explicit, legally appropriate
  opt-in program is created.
- Secrets/API keys remain server-side in a secrets manager; never expose provider credentials to
  browser/mobile clients.

## 13. Professional Accounting Workspace

- Double-entry general ledger and journal entry system with balanced-entry validation.
- General journal, general ledger, trial balance, chart of accounts, account registers, recurring
  entries, adjusting entries, and closing entries.
- Accounts receivable: customers, invoices, credits, payments, aging, statements, write-offs.
- Accounts payable: vendors, bills, credits, payments, aging, 1099-related vendor data fields as
  applicable.
- Cash/bank, credit cards, transfers, deposits, undeposited funds, and reconciliation.
- Financial statements: Balance Sheet, Profit & Loss/Income Statement, Cash Flow, Trial Balance,
  General Ledger, AR/AP aging, transaction detail, and comparative periods.
- Cash and accrual reporting modes where supported by the underlying transaction model.
- Classes/departments/locations/projects/jobs or equivalent accounting dimensions.
- Fixed asset register/depreciation support can be a later professional module if not in MVP.
- Sales tax and payroll should use modular/integration architecture due to jurisdictional and
  compliance complexity.
- Period close/lock controls, audit trail, accountant notes, attachments, exports, and
  tax-workpaper-friendly reports.

## 14. Roles, Permissions & Accountant Access

| Role | Default Scope |
| --- | --- |
| Owner/Admin | All company settings, billing, users, books, clients, marketing, proposals, integrations. |
| Manager | Operational access; configurable financial visibility; no ownership/billing changes unless granted. |
| Bookkeeper | Transactions, categorization, reconciliation, AR/AP, reports; optional journal permissions. |
| Accountant/Controller | Full accounting workspace, adjusting entries, close/reopen periods, financial reports, audit trail. |
| Sales/Client Staff | CRM, opportunities, proposals, client communications; limited/no accounting visibility. |
| Marketing | Segments, campaigns, creative studio, permitted CRM data; no ledger access. |
| Read-only/Auditor | Selected reports and records without edit rights. |

Permission model requirements:

- Invite each professional using an individual account; never share owner credentials.
- Role-based permissions plus optional granular overrides by workspace/action.
- Tenant isolation at every query and storage boundary.
- MFA support, session/device controls, login history, and revocation.
- Audit log for logins, exports, changes to transactions/journals, reconciliations, permissions,
  and sensitive settings.
- Accountant practice mode can later allow one accountant to switch securely among multiple client
  companies.

## 15. Company Studio / Brand Profile

- Legal company name, DBA, addresses, tax/contact information, website, phone, email, payment
  instructions.
- Logo library, brand colors, fonts, imagery, company description, service catalog, team bios,
  certifications, licenses, insurance information.
- Standard proposal terms, legal clauses, disclaimers, warranties, payment terms, signatures, and
  footer language.
- Reusable products/services with descriptions, units, rates, taxes, cost assumptions, and default
  proposal content.
- Brand assets feed both the Proposal Designer and Marketing Creative Studio.

## 16. Core Data Model

Tenant/Company, User, Role, Permission, BankConnection, FinancialAccount, BankTransaction,
ChartAccount, CategorizationRule, JournalEntry, JournalLine, Reconciliation, Vendor, Customer,
Contact, Lead, Opportunity, Proposal, ProposalVersion, ProposalItem, Template, DesignDocument,
Asset, Invoice, Payment, Bill, Project/Job, Campaign, Segment, MarketingEvent, Communication, Task,
AIRequest, AIUsage, AuditEvent.

All business-domain records must carry tenant/company ownership. Financial records should favor
append-only/auditable patterns; destructive edits should be avoided where accounting integrity
requires reversals or correcting entries.

## 17. Recommended Service Boundaries

- Identity & Tenant Service
- Banking/Feed Integration Service
- Accounting Ledger Service
- Bookkeeping Rules & Transaction Review Service
- CRM/Opportunity Service
- Proposal/Document Service
- Design/Asset Service
- Marketing Service
- Notification/Task Service
- AI Gateway & Usage Metering Service
- Reporting/Analytics Service
- Audit/Compliance Service

For an initial build, these may be implemented as well-separated modules inside a modular monolith
rather than separate microservices. Preserve clear domain interfaces so high-volume services can be
extracted later.

## 18. Suggested Initial Technology Direction

The coding agent should first inspect the existing repository and preserve the established stack
where reasonable. If this is a greenfield implementation, use a modern typed web stack with a
relational database suitable for transactional accounting data, background jobs for
imports/campaigns, object storage for documents/assets, and a responsive web/PWA interface before
committing to separate native mobile apps.

- Relational database with strict constraints and transactional integrity.
- API layer with schema validation and versioned contracts.
- Background worker/queue for bank sync, document generation, campaign sends, and AI jobs.
- Object storage for receipts, proposal assets, PDFs, and marketing media.
- Server-side PDF generation and immutable proposal-version snapshots.
- Event/outbox pattern for reliable cross-module handoffs (e.g., Proposal Won → Client/Project
  creation).
- Automated tests for ledger balance invariants, permissions, tenant isolation, reconciliation,
  bank-feed deduplication, and proposal state transitions.

## 19. Security & Financial Integrity Requirements

- Encryption in transit and at rest; server-side secret management.
- Strong tenant isolation and least-privilege authorization.
- Never store bank login credentials directly; rely on tokenized bank-connection providers.
- Idempotent bank imports and payment/accounting operations.
- Complete auditability of accounting changes and privileged actions.
- Backups, point-in-time recovery strategy, retention policy, and tested restore procedure.
- Exportability: users must be able to export their accounting records and key business data.
- Privacy/consent controls for marketing contacts and suppression lists.
- Security review before production use of financial integrations, payment features, payroll, tax
  filing, or automated financial actions.

## 20. Development Phases

| Phase | Deliverable |
| --- | --- |
| Phase 0 — Foundation | Repository audit, architecture, auth/tenant model, permissions, database conventions, audit logging, CI/CD, design system. |
| Phase 1 — Bookkeeping MVP | COA, bank connections, transaction import/inbox, categorization, rules, recurring memory, splits/transfers, mobile-responsive review. |
| Phase 2 — Reconciliation + Accounting Core | Reconciliation, ledger/journals, trial balance, core statements, AR/AP basics, accountant role. |
| Phase 3 — CRM + Proposal Pipeline | Lead intake, clients/contacts, opportunities, proposal statuses, win/loss analytics, website intake API/widget. |
| Phase 4 — Proposal Designer + Company Studio | Brand kit, templates, dynamic fields, pricing, PDF/web proposal, acceptance/versioning, core vector/layout engine. |
| Phase 5 — Marketing | Segments, strategic accounts, campaigns, creative reuse, lost-opportunity nurture, analytics. |
| Phase 6 — AI Add-on | AI gateway, usage metering, bookkeeping suggestions, proposal/marketing drafting, business insights, design assistance. |
| Phase 7 — Industry Modules | Construction first or based on market validation; add specialized workflows without forking the core ledger. |
| Phase 8 — Payroll/Tax/Advanced Integrations | Partner integrations and compliance-heavy features after the accounting foundation is stable. |

## 21. First Coding-Agent Assignment

The coding agent should NOT attempt to build the entire product in one pass. Its first assignment
is to establish the foundation and produce a demonstrable bookkeeping vertical slice.

1. Inspect the existing Accountrix Plus repository and document current stack, routes, database
   schema, authentication, UI components, tests, deployment, and known gaps. Do not replace working
   architecture without justification.
2. Create/update an Architecture Decision Record describing the proposed modular boundaries and
   tenant/permission strategy.
3. Implement or normalize Company/Tenant, User, Role, Permission, ChartAccount, FinancialAccount,
   BankTransaction, CategorizationRule, and AuditEvent models.
4. Seed a standard chart of accounts and implement industry-selection hooks so specialized
   account/module packs can be added later.
5. Build the responsive Bookkeeping Transaction Inbox using mocked bank data first, including
   search, filter, category assignment, rule creation, bulk actions, review state, and undo/audit
   history.
6. Create a bank-provider interface and sandbox adapter. Keep provider-specific code isolated.
7. Add automated tests for tenant isolation, permissions, transaction deduplication, rule matching,
   and accounting-data integrity.
8. Produce setup instructions, environment-variable template, database migration instructions, test
   instructions, and a short demo checklist.
9. After the mocked vertical slice passes tests, connect the selected bank aggregation sandbox and
   verify import/deduplication end-to-end.

## 22. Definition of Done for the First Milestone

- A new company can register/onboard and select an industry.
- A standard chart of accounts is created automatically.
- A user can view imported/mock bank transactions on desktop and phone-sized layouts.
- A user can categorize, split, exclude, and create a repeat rule.
- A repeated transaction is correctly suggested/auto-categorized according to the rule setting.
- Every change is attributable to a user and visible in an audit history.
- Permissions prevent unauthorized users from seeing or changing financial data.
- Automated tests pass and setup can be reproduced from documentation.
- No AI provider is required for the core bookkeeping workflow.

## 23. Product Rules the Coding Agent Must Preserve

- Simplicity for the business owner; professional depth is available without cluttering the daily
  workflow.
- One source of truth across bookkeeping, accounting, clients, proposals, and marketing.
- AI is optional and additive, never required for basic accounting functionality.
- Consequential financial actions require explicit authorization and must be auditable.
- Industry customization extends the common platform rather than creating separate products.
- Proposal and marketing design share one creative engine and one company brand system.
- Lost proposals are not dead data: where permitted, they become structured marketing
  opportunities.
- The platform should reduce duplicate entry: data entered once should flow through the business
  lifecycle.

## 24. Recommended Next Product-Definition Step

Before expanding into every module, define the Bookkeeping MVP screen-by-screen and
transaction-state-by-transaction-state. That should include onboarding, chart-of-accounts setup,
bank connection, transaction inbox, rule creation, transaction detail, reconciliation, mobile
quick-review, and accountant handoff. Once those screens and acceptance criteria are fixed, the
coding agent can build against a stable target rather than interpreting a broad product vision.

---

*Accountrix Plus • Development Specification v1.0*
