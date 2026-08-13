/**
 * Seeds a demo company with mock bank data.
 *
 * Run with `npm run db:seed`. Everything it creates goes through the same
 * services the application uses, so the seeded state is reachable by a real
 * user rather than a special case.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { brandKits, campaignRecipients, financialAccounts } from '@/db/schema'
import { registerCompany } from '@/modules/tenancy/onboarding'
import { connectInstitution, syncConnection } from '@/modules/banking/sync'
import { createRule } from '@/modules/bookkeeping/rules-engine'
import { categorize, listInbox } from '@/modules/bookkeeping/transactions'
import { accountByNumber } from '@/modules/coa/service'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  recordPayment,
} from '@/modules/receivables/service'
import {
  changeStage,
  createContact,
  createOpportunity,
  createOrganization,
} from '@/modules/crm/opportunities'
import {
  createProposal,
  decideProposal,
  recordView,
  sendProposal,
} from '@/modules/crm/proposals'
import { convertWonOpportunity } from '@/modules/crm/conversion'
import { createIntakeKey } from '@/modules/crm/intake'
import {
  createClause,
  createServiceItem,
  saveProfile,
  updateBrandKit,
} from '@/modules/studio/service'
import {
  createDocumentForProposal,
  createMarketingDocument,
  saveDocument,
} from '@/modules/design/documents'
import { createSegment } from '@/modules/marketing/audience'
import { addStep, createCampaign, sendStep } from '@/modules/marketing/campaigns'
import { recordClick, recordOpen } from '@/modules/marketing/engagement'
import { updateSettings } from '@/modules/ai/settings'
import { installDefaultCostCodes, listCostCodes } from '@/modules/jobs/cost-codes'
import { approveChangeOrder, createChangeOrder, setJobBudget } from '@/modules/jobs/budgets'
import { createProgressBilling, scheduleFor, setScheduleOfValues } from '@/modules/jobs/billing'
import { createSubcontractor, recordComplianceDocument } from '@/modules/jobs/compliance'
import { wipSummary } from '@/modules/jobs/reports'
import { moduleEnabled } from '@/modules/industry/modules'
import { postManualEntry } from '@/modules/ledger/journal'
import { suggestCategory, summarizeInbox } from '@/modules/ai/bookkeeping'
import type { ActorContext } from '@/modules/tenancy/context'

/** The checking account the demo payments move through. */
async function firstCheckingAccountId(companyId: string): Promise<string | null> {
  const [account] = await db
    .select({ id: financialAccounts.id })
    .from(financialAccounts)
    .where(eq(financialAccounts.companyId, companyId))
    .limit(1)

  return account?.id ?? null
}

const DEMO_EMAIL = 'owner@ridgeline.test'
const DEMO_PASSWORD = 'correct-horse-battery'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
    process.exit(1)
  }

  console.log('Creating demo company…')
  const { company, user, accountsCreated } = await registerCompany({
    companyName: 'Ridgeline Construction',
    industry: 'construction',
    userName: 'Dana Owner',
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  })
  console.log(`  ${company.name} created with ${accountsCreated} accounts.`)

  const ctx: ActorContext = {
    userId: user.id,
    userName: user.name,
    companyId: company.id,
    role: 'owner',
  }

  // A rule created before the import, so the sync demonstrates auto-
  // categorization rather than leaving everything uncategorized.
  const fuel = await accountByNumber(company.id, '6800')
  if (fuel) {
    await createRule(ctx, {
      name: 'Fuel at Shell',
      conditions: [{ field: 'description', operator: 'contains', value: 'SHELL OIL' }],
      chartAccountId: fuel.id,
      action: 'auto',
    })
    console.log('  Added an auto-categorization rule for Shell fuel.')
  }

  const rent = await accountByNumber(company.id, '6400')
  if (rent) {
    await createRule(ctx, {
      name: 'Monthly rent',
      conditions: [{ field: 'description', operator: 'contains', value: 'NORTHGATE PROP' }],
      chartAccountId: rent.id,
      action: 'suggest',
    })
    console.log('  Added a suggestion rule for rent.')
  }

  console.log('Connecting the sandbox bank feed…')
  const { connectionId, accountsCreated: bankAccounts } = await connectInstitution(ctx, {
    publicToken: 'demo',
  })
  console.log(`  Linked ${bankAccounts} bank accounts.`)

  const summary = await syncConnection(ctx, connectionId)
  console.log(
    `  Imported ${summary.imported} transactions ` +
      `(${summary.autoCategorized} auto-categorized, ${summary.suggested} suggested).`,
  )

  // --- Phase 2: receivables, payables, and a partly-reviewed ledger --------

  console.log('Categorizing a sample of the feed…')
  const materials = await accountByNumber(company.id, '5110')
  const inbox = await listInbox(ctx, { states: ['new'], limit: 12 })
  let categorized = 0
  for (const row of inbox.rows) {
    // Deposits to contract revenue, spending to job materials.
    const target = row.amountCents >= 0 ? await accountByNumber(company.id, '4200') : materials
    if (!target) continue
    await categorize(ctx, row.id, target.id)
    categorized++
  }
  console.log(`  Categorized ${categorized} transactions into the ledger.`)

  console.log('Creating receivables and payables…')
  const contractRevenue = await accountByNumber(company.id, '4200')
  const subcontractors = await accountByNumber(company.id, '5130')

  const harborview = await createCustomer(ctx, {
    name: 'Harborview Development LLC',
    email: 'ap@harborview.test',
    paymentTermsDays: 30,
  })
  const cityWorks = await createCustomer(ctx, {
    name: 'City Works Authority',
    paymentTermsDays: 45,
  })
  const supplyDepot = await createVendor(ctx, { name: 'Supply Depot', paymentTermsDays: 30 })

  if (contractRevenue) {
    // One paid, one outstanding, one well past due — so the aging report has
    // something in more than one bucket.
    const paid = await createInvoice(ctx, {
      customerId: harborview.id,
      issueDate: '2026-06-01',
      lines: [
        { chartAccountId: contractRevenue.id, description: 'Foundation phase', unitPriceCents: 1_850_000 },
      ],
    })
    await recordPayment(ctx, {
      kind: 'receipt',
      customerId: harborview.id,
      paymentDate: '2026-06-28',
      amountCents: 1_850_000,
      financialAccountId: (await firstCheckingAccountId(company.id))!,
      applications: [{ invoiceId: paid.id, amountCents: 1_850_000 }],
    })

    await createInvoice(ctx, {
      customerId: harborview.id,
      issueDate: '2026-07-15',
      lines: [
        { chartAccountId: contractRevenue.id, description: 'Framing phase', unitPriceCents: 2_400_000 },
      ],
    })
    await createInvoice(ctx, {
      customerId: cityWorks.id,
      issueDate: '2026-05-01',
      dueDate: '2026-05-15',
      lines: [
        { chartAccountId: contractRevenue.id, description: 'Sidewalk replacement', unitPriceCents: 940_000 },
      ],
    })
    console.log('  3 invoices (1 paid, 1 open, 1 overdue).')
  }

  if (subcontractors) {
    await createBill(ctx, {
      vendorId: supplyDepot.id,
      issueDate: '2026-07-20',
      lines: [
        { chartAccountId: subcontractors.id, description: 'Electrical subcontract', unitPriceCents: 620_000 },
      ],
    })
    console.log('  1 open vendor bill.')
  }

  // --- Phase 3: CRM pipeline, proposals, and lead intake -------------------

  console.log('Building the sales pipeline…')

  const harborviewOrg = await createOrganization(ctx, {
    name: 'Harborview Development LLC',
    lifecycleStage: 'prospect',
    industry: 'Real estate',
    region: 'WA',
    source: 'referral',
    email: 'ap@harborview.test',
  })
  const cityOrg = await createOrganization(ctx, {
    name: 'City Works Authority',
    lifecycleStage: 'prospect',
    industry: 'Public sector',
    region: 'WA',
    source: 'tender',
  })
  const summitOrg = await createOrganization(ctx, {
    name: 'Summit Property Group',
    lifecycleStage: 'strategic_target',
    industry: 'Real estate',
    region: 'OR',
    source: 'website',
    isStrategicAccount: true,
  })

  const harborviewContact = await createContact(ctx, {
    organizationId: harborviewOrg.id,
    firstName: 'Jo',
    lastName: 'Rivera',
    email: 'jo@harborview.test',
    isPrimary: true,
    emailConsent: 'subscribed',
    consentSource: 'manual_entry',
  })

  // A spread across the pipeline, so the board and dashboard have shape.
  const negotiating = await createOpportunity(ctx, {
    organizationId: summitOrg.id,
    title: 'Mixed-use foundation package',
    expectedValueCents: 4_200_000,
    source: 'website',
  })
  await changeStage(ctx, negotiating.id, { stage: 'qualified' })
  await changeStage(ctx, negotiating.id, { stage: 'negotiation' })

  const qualified = await createOpportunity(ctx, {
    organizationId: cityOrg.id,
    title: 'Sidewalk replacement — phase 2',
    expectedValueCents: 1_150_000,
    source: 'tender',
  })
  await changeStage(ctx, qualified.id, { stage: 'qualified' })

  // Consent on the contact is what makes the lost deal eligible for nurture
  // later — see `contactAllowsMarketing`.
  const cityContact = await createContact(ctx, {
    organizationId: cityOrg.id,
    firstName: 'Dana',
    lastName: 'Okafor',
    email: 'dana@cityworks.test',
    isPrimary: true,
    emailConsent: 'subscribed',
    consentSource: 'manual_entry',
  })

  await createContact(ctx, {
    organizationId: summitOrg.id,
    firstName: 'Priya',
    lastName: 'Raman',
    email: 'priya@summitproperty.test',
    isPrimary: true,
    emailConsent: 'subscribed',
    consentSource: 'web_form',
  })

  // Someone who never opted in, so the send pipeline has a reason to skip.
  await createContact(ctx, {
    organizationId: summitOrg.id,
    firstName: 'Alex',
    lastName: 'Whitfield',
    email: 'alex@summitproperty.test',
    emailConsent: 'unknown',
  })

  const lost = await createOpportunity(ctx, {
    organizationId: cityOrg.id,
    primaryContactId: cityContact.id,
    title: 'Parking structure repair',
    expectedValueCents: 2_800_000,
    source: 'tender',
  })
  await changeStage(ctx, lost.id, {
    stage: 'lost',
    lossReason: 'price',
    lossNotes: 'Came in 12% above the winning bid.',
  })

  const won = await createOpportunity(ctx, {
    organizationId: harborviewOrg.id,
    primaryContactId: harborviewContact.id,
    title: 'Foundation and framing',
    expectedValueCents: 3_500_000,
    source: 'referral',
  })
  console.log('  4 opportunities across the pipeline.')

  const contractRevenueAccount = await accountByNumber(company.id, '4200')
  // Captured so documents can be composed once the studio is set up.
  let wonProposalId: string | null = null
  let jobProjectId: string | null = null
  let jobCustomerId: string | null = null
  let openProposalId: string | null = null
  let openProposalToken: string | null = null

  if (contractRevenueAccount) {
    const proposal = await createProposal(ctx, {
      opportunityId: won.id,
      title: 'Foundation and framing proposal',
      expiresOn: '2026-10-15',
      executiveSummary:
        'A two-phase package covering excavation, foundation, and structural framing.',
      scope: 'Site preparation, excavation, footings, foundation walls, and framing to lock-up.',
      exclusions: 'Permits, utility connections, and finish carpentry.',
      terms: 'Net 30. 25% deposit on acceptance.',
      items: [
        {
          description: 'Excavation and foundation',
          unitPriceCents: 2_100_000,
          chartAccountId: contractRevenueAccount.id,
        },
        {
          description: 'Structural framing',
          unitPriceCents: 1_400_000,
          chartAccountId: contractRevenueAccount.id,
        },
        {
          description: 'Drainage upgrade',
          unitPriceCents: 380_000,
          isOptional: true,
          isSelected: false,
          chartAccountId: contractRevenueAccount.id,
        },
      ],
    })

    wonProposalId = proposal.id
    await sendProposal(ctx, proposal.id)
    await recordView(proposal.publicToken, { ipPrefix: '203.0.113.0/24' })
    await decideProposal(ctx, proposal.id, 'won')
    await changeStage(ctx, won.id, { stage: 'won' })

    // No invoice at conversion: this is a construction demo, and a contractor
    // does not bill the whole contract on the day it is signed. The job is
    // billed by progress billing in the Phase 7 section below, which is what
    // makes the WIP schedule tell a coherent story.
    const converted = await convertWonOpportunity(ctx, won.id, { createInvoice: false })
    jobProjectId = converted.projectId
    jobCustomerId = converted.customerId
    console.log(`  Proposal ${proposal.number} sent, viewed, and won.`)
    console.log('  Converted to a client and a job, to be billed by application.')
    console.log(`  Client proposal link: /p/${proposal.publicToken}`)

    // A second proposal still out with a client, so the dashboard has one open.
    const openProposal = await createProposal(ctx, {
      opportunityId: negotiating.id,
      title: 'Mixed-use foundation proposal',
      expiresOn: '2026-11-30',
      scope: 'Excavation and foundation for the mixed-use block.',
      items: [
        {
          description: 'Excavation and foundation',
          unitPriceCents: 4_200_000,
          chartAccountId: contractRevenueAccount.id,
        },
      ],
    })
    await sendProposal(ctx, openProposal.id)
    openProposalId = openProposal.id
    openProposalToken = openProposal.publicToken
    console.log(`  Proposal ${openProposal.number} sent and awaiting a decision.`)
  }

  const intakeKey = await createIntakeKey(ctx, {
    name: 'Website contact form',
    hourlyLimit: 60,
  })
  console.log(`  Lead intake key: ${intakeKey.publicKey}`)

  // --- Phase 4: Company Studio and the proposal designer -------------------

  console.log('Filling in Company Studio…')

  await saveProfile(ctx, {
    legalName: 'Ridgeline Construction LLC',
    tagline: 'Foundations, framing, and finish work since 2009.',
    addressLine1: '412 Mill Street',
    city: 'Bellingham',
    region: 'WA',
    postalCode: '98225',
    phone: '(360) 555-0148',
    email: 'hello@ridgeline.test',
    website: 'ridgeline.test',
    paymentInstructions:
      'A 25% deposit is due on acceptance. Progress billing is monthly on work in place, net 30. Retainage of 10% is released at substantial completion.',
    documentFooter: 'Ridgeline Construction LLC · WA contractor licence RIDGEC*781QK',
  })

  // A brand kit in the company's own colours rather than the product default.
  const [defaultKit] = await db
    .select()
    .from(brandKits)
    .where(eq(brandKits.companyId, company.id))
    .limit(1)

  if (defaultKit) {
    await updateBrandKit(ctx, defaultKit.id, {
      name: 'Ridgeline',
      primaryColor: '#1e3a5f',
      accentColor: '#c2703d',
      textColor: '#1a1a1a',
      mutedColor: '#6b7280',
      surfaceColor: '#ffffff',
      headingFont: 'Georgia, serif',
      bodyFont: 'system-ui, sans-serif',
      baseSizePt: 11,
    })
    console.log('  Brand kit set to the company colours.')
  }

  await createClause(ctx, {
    title: 'Payment terms',
    category: 'payment',
    body: 'A deposit of 25% is due on acceptance. Progress invoices are issued monthly for work in place and are due net 30. Retainage of 10% is held until substantial completion.',
    approve: true,
  })
  await createClause(ctx, {
    title: 'Change orders',
    category: 'terms',
    body: 'Any change to the scope described in this proposal requires a written change order signed by both parties before the work is performed. Change orders are billed at the rates in effect at the time of the change.',
    approve: true,
  })
  await createClause(ctx, {
    title: 'Warranty',
    category: 'warranty',
    body: 'Workmanship is warranted for one year from substantial completion. Manufacturer warranties on materials are passed through to the owner.',
    approve: true,
  })
  console.log('  3 approved clauses in the legal library.')

  await createServiceItem(ctx, {
    name: 'Excavation and site preparation',
    unit: 'day',
    unitPriceCents: 285_000,
    chartAccountId: contractRevenueAccount?.id ?? null,
    description: 'Machine and operator, including haul-off.',
  })
  await createServiceItem(ctx, {
    name: 'Foundation forming and pour',
    unit: 'sq ft',
    unitPriceCents: 1_450,
    chartAccountId: contractRevenueAccount?.id ?? null,
  })
  console.log('  2 items in the service catalog.')

  // Compose the proposal documents now that the brand and clauses exist, so
  // the client-facing pages render in the company's own colours.
  for (const [proposalId, templateKey, label] of [
    [wonProposalId, 'construction-bid', 'won'],
    [openProposalId, 'construction-bid', 'open'],
  ] as const) {
    if (!proposalId) continue
    await createDocumentForProposal(ctx, proposalId, templateKey)
    console.log(`  Composed the ${label} proposal from the "${templateKey}" template.`)
  }

  if (openProposalToken) {
    console.log(`  Open proposal, ready to accept: /p/${openProposalToken}`)
  }

  // --- Phase 5: segments, creative, and a sent campaign --------------------

  console.log('Setting up marketing…')

  const prospects = await createSegment(ctx, {
    name: 'Prospects in real estate',
    description: 'Everyone at a real-estate client we have not won yet.',
    definition: {
      matchType: 'all',
      rules: [{ field: 'industry', operator: 'is', value: 'Real estate' }],
      lostOpportunityNurture: false,
    },
  })

  const nurture = await createSegment(ctx, {
    name: 'Lost deals worth another try',
    description: 'Closed lost or dormant, with consent on record at close.',
    definition: { matchType: 'all', rules: [], lostOpportunityNurture: true },
  })
  console.log('  2 segments.')

  // A piece of creative built from the same blocks a proposal uses — the
  // button and QR blocks are the only ones marketing added (spec §8).
  const creative = await createMarketingDocument(ctx, { name: 'Year-end planning note' })
  await saveDocument(ctx, creative.id, {
    blocks: [
      {
        id: randomUUID(),
        type: 'cover',
        title: 'Three things worth doing before year-end',
        subtitle: 'A short note from {{company.name}}',
      },
      {
        id: randomUUID(),
        type: 'text',
        text: 'Hello {{client.contactName}},\n\nEvery year the same three items catch people out. None of them take long, and all of them are cheaper to handle now than in March.',
        align: 'left',
        emphasis: false,
      },
      {
        id: randomUUID(),
        type: 'list',
        ordered: true,
        items: [
          'Reconcile the last two months so the year closes clean.',
          'Confirm which jobs finish this year and which roll over.',
          'Book equipment purchases before the cut-off if you plan to make them.',
        ],
      },
      {
        id: randomUUID(),
        type: 'button',
        label: 'Book a 20-minute review',
        url: 'https://example.com/book',
        align: 'center',
        style: 'solid',
      },
    ],
  })
  console.log(`  1 piece of creative: "${creative.name}".`)

  const campaign = await createCampaign(ctx, {
    name: 'Year-end planning note',
    kind: 'broadcast',
    segmentId: prospects.id,
    fromName: 'Ridgeline Construction',
    fromEmail: 'hello@ridgeline.test',
    scheduledFor: new Date(Date.now() + 7 * 86_400_000),
  })

  await addStep(ctx, campaign.id, {
    subject: 'Three things worth doing before year-end',
    previewText: 'None of them take long.',
    designDocumentId: creative.id,
  })

  const sendSummary = await sendStep(ctx, campaign.id, 1)
  console.log(
    `  Campaign sent: ${sendSummary.matched} matched, ${sendSummary.sent} emailed, ` +
      `${sendSummary.skipped} skipped.`,
  )

  // Simulate the reader's side of the loop, so the dashboard has engagement
  // and the sales team has a follow-up task waiting.
  const [firstRecipient] = await db
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id))
    .limit(1)

  if (firstRecipient && firstRecipient.status === 'sent') {
    await recordOpen(firstRecipient.unsubscribeToken, { ipPrefix: '198.51.100.0/24' })
    await recordClick(firstRecipient.unsubscribeToken, 'https://example.com/book', {
      ipPrefix: '198.51.100.0/24',
    })
    console.log(`  ${firstRecipient.email} opened and clicked — a follow-up task is waiting.`)
  }

  // The lost-opportunity nurture path (spec §9, §10): a deal closed as lost,
  // whose contact had consented, gets a second approach — and their click puts
  // the deal in front of sales again.
  const nurtureCampaign = await createCampaign(ctx, {
    name: 'Still worth a conversation',
    kind: 'nurture',
    segmentId: nurture.id,
    fromName: 'Ridgeline Construction',
    fromEmail: 'hello@ridgeline.test',
  })
  await addStep(ctx, nurtureCampaign.id, {
    subject: 'Six months on — has the parking structure moved?',
    designDocumentId: creative.id,
  })
  const nurtureSummary = await sendStep(ctx, nurtureCampaign.id, 1)
  console.log(
    `  Nurture campaign sent: ${nurtureSummary.matched} matched, ${nurtureSummary.sent} emailed.`,
  )

  const [nurtureRecipient] = await db
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, nurtureCampaign.id))
    .limit(1)

  if (nurtureRecipient && nurtureRecipient.status === 'sent') {
    await recordClick(nurtureRecipient.unsubscribeToken, 'https://example.com/book', {
      ipPrefix: '203.0.113.0/24',
    })
    console.log(`  ${nurtureRecipient.email} clicked — their lost deal is worth reopening.`)
  }

  // --- Phase 6: the optional AI module -------------------------------------

  console.log('Switching on the AI module…')

  // Enabled here so the demo has something to show. A real company starts
  // with it off — `registerCompany` writes no settings row at all, and no
  // settings row means off (spec §23).
  await updateSettings(ctx, {
    enabled: true,
    provider: 'mock',
    monthlyCeilingMicros: 5_000_000,
  })
  console.log('  Enabled with the built-in heuristic provider — no API key needed.')

  // A couple of suggestions, left pending, so the inbox shows the approval
  // flow. Several are tried because the heuristic provider declines anything
  // it cannot place confidently — which is the behaviour we want, but means
  // the first transaction in the list is not always one it will answer for.
  const candidates = (await listInbox(ctx, { states: ['new'], limit: 20 })).rows
  let suggested = 0

  for (const candidate of candidates) {
    if (suggested >= 2) break

    const suggestion = await suggestCategory(ctx, candidate.id)
    if (!suggestion.ok) continue

    suggested++
    console.log(
      `  Suggested ${suggestion.account.name} for "${candidate.description}" ` +
        `(${(suggestion.confidenceBp / 100).toFixed(0)}% sure) — awaiting your decision.`,
    )
  }

  if (suggested === 0) {
    console.log('  Nothing in the inbox was clear enough to suggest a category for.')
  }

  const inboxSummary = await summarizeInbox(ctx)
  if (inboxSummary.ok) console.log(`  Inbox summary: ${inboxSummary.summary}`)

  // --- Phase 7: job costing, change orders, and progress billing -----------

  // Nothing switches job costing on here: the construction industry pack asks
  // for it, so it is already on. That is the point of the module registry.
  console.log('Setting up job costing…')
  console.log(
    `  Job costing is ${(await moduleEnabled(company.id, 'job_costing')) ? 'on' : 'off'} — ` +
      'the construction pack enables it, with nothing configured.',
  )

  const costCodesCreated = await installDefaultCostCodes(ctx)
  console.log(`  Loaded ${costCodesCreated} starter cost codes.`)

  if (jobProjectId && jobCustomerId && contractRevenueAccount) {
    const codes = await listCostCodes(ctx, { activeOnly: true })
    const codeFor = (value: string) => codes.find((code) => code.code === value)

    const framing = codeFor('06-100')
    const lumber = codeFor('06-900')
    const electrical = codeFor('16-100')

    if (framing && lumber && electrical) {
      // Roughly 80% of the $35,000 contract, which is what a contractor's
      // estimate actually looks like — the demo should not imply a 70% margin.
      await setJobBudget(ctx, jobProjectId, [
        { costCodeId: framing.id, originalAmountCents: 1_180_000 },
        { costCodeId: lumber.id, originalAmountCents: 940_000 },
        { costCodeId: electrical.id, originalAmountCents: 760_000 },
      ])
      console.log('  Budgeted the job across three cost codes.')

      // Real cost, through the same journal the rest of the books use.
      const laborAccount = await accountByNumber(company.id, '5120')
      const cashAccount = await accountByNumber(company.id, '1000')
      if (laborAccount && cashAccount) {
        await postManualEntry(ctx, {
          entryDate: '2026-07-15',
          memo: 'Framing crew — weeks 1-3',
          lines: [
            {
              chartAccountId: laborAccount.id,
              debitCents: 268_000,
              projectId: jobProjectId,
              costCodeId: framing.id,
              memo: 'Framing labor',
            },
            { chartAccountId: cashAccount.id, creditCents: 268_000 },
          ],
        })
        console.log('  Posted framing labor to the job — an ordinary journal entry.')
      }

      // A subcontractor bill with retainage withheld.
      const electrician = await createVendor(ctx, {
        name: 'Delta Electrical',
        paymentTermsDays: 30,
      })
      const subcontractAccount = await accountByNumber(company.id, '5130')
      if (subcontractAccount) {
        await createBill(ctx, {
          vendorId: electrician.id,
          issueDate: '2026-07-28',
          projectId: jobProjectId,
          retainageCents: 14_200,
          lines: [
            {
              chartAccountId: subcontractAccount.id,
              description: 'Rough electrical',
              unitPriceCents: 142_000,
              costCodeId: electrical.id,
            },
          ],
        })
        console.log('  Recorded a subcontractor bill with 10% retainage withheld.')
      }

      const sub = await createSubcontractor(ctx, {
        vendorId: electrician.id,
        trade: 'Electrical',
        licenseNumber: 'EC-448120',
        defaultRetainageBp: 1000,
      })

      // One current certificate and one about to lapse, so the compliance
      // page has something to warn about.
      await recordComplianceDocument(ctx, {
        subcontractorId: sub.id,
        kind: 'workers_comp',
        carrier: 'Statewide Mutual',
        reference: 'WC-772104',
        expiresOn: '2027-03-31',
      })
      await recordComplianceDocument(ctx, {
        subcontractorId: sub.id,
        kind: 'general_liability',
        carrier: 'Statewide Mutual',
        reference: 'GL-118203',
        coverageAmountCents: 200_000_000,
        expiresOn: '2026-09-05',
      })
      console.log('  Tracked Delta Electrical, with a certificate expiring in three weeks.')
    }

    // The contract broken into billable items.
    await setScheduleOfValues(ctx, jobProjectId, [
      {
        itemNumber: '1',
        description: 'Site preparation and demolition',
        scheduledValueCents: 800_000,
        chartAccountId: contractRevenueAccount.id,
        costCodeId: codeFor('02-100')?.id ?? null,
      },
      {
        itemNumber: '2',
        description: 'Framing and structure',
        scheduledValueCents: 1_600_000,
        chartAccountId: contractRevenueAccount.id,
        costCodeId: framing?.id ?? null,
      },
      {
        itemNumber: '3',
        description: 'Mechanical and electrical',
        scheduledValueCents: 1_100_000,
        chartAccountId: contractRevenueAccount.id,
        costCodeId: electrical?.id ?? null,
      },
    ])
    console.log('  Set a three-item schedule of values totalling the contract.')

    // A change order the client approved. It revises the contract and the
    // budget — and posts nothing.
    const changeOrder = await createChangeOrder(ctx, {
      projectId: jobProjectId,
      title: 'Upgraded electrical service',
      description: 'Client requested a 400A service in place of the specified 200A.',
      contractAmountCents: 86_000,
      requestedOn: '2026-07-20',
      lines: electrical ? [{ costCodeId: electrical.id, amountCents: 61_000 }] : [],
    })
    await approveChangeOrder(ctx, changeOrder.id, { decidedOn: '2026-07-24' })
    console.log(
      `  Change order ${changeOrder.number} approved: contract and budget revised, ledger untouched.`,
    )

    // An application for payment, issued as an ordinary invoice.
    const schedule = await scheduleFor(ctx, jobProjectId)
    const { invoice, billing } = await createProgressBilling(ctx, {
      projectId: jobProjectId,
      customerId: jobCustomerId,
      periodEnd: '2026-07-31',
      billingDate: '2026-07-31',
      retainagePercentBp: 1000,
      lines: [
        { scheduleOfValuesId: schedule[0].id, percentCompleteBp: 5000 },
        { scheduleOfValuesId: schedule[1].id, percentCompleteBp: 1000 },
      ],
    })
    console.log(
      `  Application ${billing.applicationNumber} issued as invoice ${invoice.number}: ` +
        `${(billing.thisPeriodCents / 100).toFixed(2)} billed, ` +
        `${(billing.retainedCents / 100).toFixed(2)} retained, ` +
        `${(billing.netDueCents / 100).toFixed(2)} due now.`,
    )

    const wip = await wipSummary(ctx)
    console.log(
      `  WIP: ${(wip.costToDateCents / 100).toFixed(2)} cost, ` +
        `${(wip.billedToDateCents / 100).toFixed(2)} billed, ` +
        `${(wip.costsInExcessCents / 100).toFixed(2)} underbilled, ` +
        `${(wip.billingsInExcessCents / 100).toFixed(2)} overbilled.`,
    )
  }

  console.log('\nDone. Sign in with:')
  console.log(`  Email:    ${DEMO_EMAIL}`)
  console.log(`  Password: ${DEMO_PASSWORD}`)
  console.log('\nTry:')
  console.log('  /bookkeeping          the transaction inbox')
  console.log('  /accounting/reports   trial balance and statements')
  console.log('  /crm                  the sales pipeline')
  console.log('  /crm/dashboard        win/loss analytics')
  console.log('  /marketing            campaign results and the sales loop')
  console.log('  /marketing/segments   the audience builder')
  console.log('  /ai                   the AI module, its meter, and its prompts')
  console.log('  /jobs                 the WIP schedule')
  console.log('  /jobs/subcontractors  insurance and W-9 compliance')
  console.log('  /settings/modules     industry modules, on and off')

  process.exit(0)
}

main().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
