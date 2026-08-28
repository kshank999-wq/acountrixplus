/**
 * Seeds a demo company with mock bank data.
 *
 * Run with `npm run db:seed`. Everything it creates goes through the same
 * services the application uses, so the seeded state is reachable by a real
 * user rather than a special case.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  brandKits,
  campaignRecipients,
  chartAccounts,
  contacts,
  customers,
  documents,
  financialAccounts,
  journalEntries,
  invoices as invoicesTable,
  journalLines,
  loginAttempts,
  serviceItems,
  transactionalMessages,
} from '@/db/schema'
import { registerCompany, registerUser } from '@/modules/tenancy/onboarding'
import {
  addPracticeMember,
  createPractice,
  offerEngagement,
  respondToEngagement,
} from '@/modules/practice/service'
import { practiceWorkQueue } from '@/modules/practice/switching'
import { assignToEngagement, setEngagementStaffing } from '@/modules/practice/service'
import { attachDocument, storeDocument } from '@/modules/evidence/service'
import { logCommunication } from '@/modules/engagement/communications'
import { createTask, workSummary } from '@/modules/engagement/tasks'
import { writeNote } from '@/modules/evidence/notes'
import {
  createLease,
  createProperty,
  createUnit,
} from '@/modules/properties/service'
import { runRent } from '@/modules/properties/billing'
import { applyDeposit, depositsHeld, receiveDeposit } from '@/modules/properties/deposits'
import { occupancy } from '@/modules/properties/reporting'
import { createFund, fundDimensionId } from '@/modules/funds/service'
import { recordContribution } from '@/modules/funds/contributions'
import { runReleases } from '@/modules/funds/releases'
import { netAssets } from '@/modules/funds/reporting'
import {
  absorbCost,
  completeWorkOrder,
  createBom,
  createWorkOrder,
  issueMaterial,
} from '@/modules/manufacturing/service'
import { wipPosition } from '@/modules/manufacturing/reporting'
import { importDay, listDays, tipsPosition } from '@/modules/pos/service'
import {
  addPractitioner,
  book,
  closeWithoutDelivery,
  completeAppointment,
  redeemGiftCard,
  sellGiftCard,
} from '@/modules/appointments/service'
import {
  diarySummary,
  giftCardPosition,
  payoutPosition,
} from '@/modules/appointments/reporting'
import {
  addLine,
  addVehicle,
  authorise,
  completeRepairOrder,
  openRepairOrder,
} from '@/modules/vehicles/service'
import { authorisationsAgree, openOrders, shopMix } from '@/modules/vehicles/reporting'
import { listRentCharges } from '@/modules/properties/billing'
import { inviteToCompany } from '@/modules/notify/invitations'
import { mockTransactionalProvider } from '@/modules/notify/transactional'
import { connectInstitution, syncConnection } from '@/modules/banking/sync'
import { createRule } from '@/modules/bookkeeping/rules-engine'
import { categorize, listInbox } from '@/modules/bookkeeping/transactions'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import {
  createDimension,
  createDimensionValue,
  reclassifyLines,
} from '@/modules/dimensions/service'
import { dimensionalProfitAndLoss } from '@/modules/dimensions/reporting'
import {
  depreciationDue,
  reconcileFixedAssets,
  registerAsset,
  runDepreciation,
} from '@/modules/assets/service'
import {
  createBill,
  createCustomer,
  createInvoice,
  createVendor,
  listInvoices,
  recordPayment,
} from '@/modules/receivables/service'
import { sendInvoice } from '@/modules/receivables/send'
import { cashFlowStatement } from '@/modules/ledger/cash-flow'
import { balanceForAccount } from '@/modules/ledger/balances'
import { putRate } from '@/modules/fx/service'
import { approveBudget, createBudget, setAccountBudget } from '@/modules/budget/service'
import { budgetVsActual } from '@/modules/budget/reporting'
import { createSchedule, runDueSchedules } from '@/modules/billing/service'
import { billingForecast } from '@/modules/billing/reporting'
import { setModuleEnabled } from '@/modules/industry/modules'
import { adjustStock, receiveStock, reconcileInventory, stockOnHand } from '@/modules/inventory/service'
import { receiveGoods, unbilledReceipts } from '@/modules/inventory/purchasing'
import {
  approveTime,
  logTime,
  recordBillableExpense,
  setPersonRate,
  unbilledWork,
} from '@/modules/timebilling/service'
import { listProjects } from '@/modules/crm/conversion'
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
import { registerDevice } from '@/modules/mobile/devices'
import { subscribe, nudgeReviewQueue } from '@/modules/mobile/notifications'
import { uploadReceipt, attachReceipt } from '@/modules/mobile/receipts'
import { applyOperation } from '@/modules/mobile/operations'
import { listInbox as listInboxForMobile } from '@/modules/bookkeeping/transactions'
import { postManualEntry } from '@/modules/ledger/journal'
import { suggestCategory, summarizeInbox } from '@/modules/ai/bookkeeping'
import { createEmployee, createPayrollRun } from '@/modules/payroll/service'
import { recordRemittance } from '@/modules/payroll/remittance'
import { createTaxCode } from '@/modules/payroll/sales-tax'
import { setVendorReporting } from '@/modules/payroll/vendor-reporting'
import { workpaperPack } from '@/modules/payroll/workpapers'
import { installCompanySchedules, installGlobalSchedules } from '@/modules/worker/defaults'
import {
  addDrawer,
  drawerPosition,
  openShift,
  openShiftFor,
  payOut,
} from '@/modules/drawer/service'
import { retentionReport } from '@/modules/retention/sweep'
import { enqueue } from '@/modules/worker/queue'
import { runOnce } from '@/modules/worker/runner'
import { listDraftEntries } from '@/modules/ledger/journal'
import { createCreditNote, writeOffInvoice } from '@/modules/receivables/credits'
import { saveStatement } from '@/modules/receivables/statements'
import { createRecurringEntry, runDueRecurringEntries } from '@/modules/ledger/recurring'
import { profitAndLoss } from '@/modules/ledger/reports'
import type { ActorContext } from '@/modules/tenancy/context'

/** Cents as plain dollars, for the seed's console output. */
function formatCentsPlain(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
}

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

  // --- Phase 22: what was said, and what is owed ----------------------------
  //
  // A relationship is a sequence of exchanges and promises, and neither is in
  // the ledger. The invitation the seed sends further down — to Alex Whitfield,
  // whose address the CRM knows — lands here too, automatically, beside the
  // calls somebody logged by hand.
  if (negotiating) {
    const [summitContact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.companyId, company.id))
      .limit(1)

    await logCommunication(ctx, {
      opportunityId: negotiating.id,
      contactId: summitContact?.id ?? null,
      channel: 'call',
      direction: 'inbound',
      summary: 'Rang about the foundation bid — wants the copper valley priced separately.',
      body: 'Asked whether we could hold the price to the end of the quarter. Said we would come back on Friday.',
      occurredAt: new Date('2026-08-10T09:20:00Z'),
    })

    await logCommunication(ctx, {
      opportunityId: negotiating.id,
      channel: 'meeting',
      direction: 'outbound',
      summary: 'Site walk with their project manager.',
      occurredAt: new Date('2026-08-12T14:00:00Z'),
    })

    await createTask(ctx, {
      title: 'Come back on holding the price to quarter end',
      detail: 'Promised on the call of 10 August. Needs a decision from Dana first.',
      opportunityId: negotiating.id,
      dueOn: '2026-08-14',
      priority: 'high',
      assignedTo: user.id,
    })

    await createTask(ctx, {
      title: 'Chase the signed bid',
      opportunityId: negotiating.id,
      dueOn: '2026-08-28',
    })

    // Deliberately unowned, to show the state: "somebody should do this" is
    // real, and a list that hides it until claimed is how it stops being
    // anybody's.
    await createTask(ctx, { title: 'Ask them who signs off on change orders' })

    const work = await workSummary(ctx, '2026-08-16')
    console.log(
      `  Engagement: 2 exchanges logged, ${work.open} follow-ups open ` +
        `(${work.overdue} late, ${work.unassigned} unclaimed).`,
    )
  }

  // --- Phase 23: property management ---------------------------------------
  //
  // Ridgeline is a contractor who bought the yard next door and let the two
  // units in it. Switched on here rather than seeding a fourth company,
  // because that is the point the module registry keeps making: industry is a
  // starting point, not a cage — and the four accounts the real-estate pack
  // would have installed are created on demand for a chart that never had
  // them.
  await setModuleEnabled(ctx, 'properties', true)

  const yard = await createProperty(ctx, {
    code: 'DEPOT',
    name: 'Depot Road Units',
    addressLine1: '48 Depot Road',
    city: 'Portland',
    acquiredOn: '2026-01-15',
  })

  const unitA = await createUnit(ctx, {
    propertyId: yard.id,
    code: 'A',
    name: 'Front workshop',
    marketRentCents: 180_000,
    areaUnits: 1_800,
  })
  const unitB = await createUnit(ctx, {
    propertyId: yard.id,
    code: 'B',
    name: 'Rear store',
    marketRentCents: 95_000,
    areaUnits: 900,
  })

  const workshopTenant = await createCustomer(ctx, {
    name: 'Foxglove Cabinetry',
    email: 'accounts@foxglovecabinetry.test',
    paymentTermsDays: 5,
  })

  const workshopLease = await createLease(ctx, {
    unitId: unitA.id,
    customerId: workshopTenant.id,
    startsOn: '2026-03-10',
    rentCents: 175_000,
    dueDay: 1,
    depositRequiredCents: 175_000,
    activate: true,
  })

  // Unit B is deliberately left empty. A rent roll where every unit is let is
  // a rent roll that never shows the row that matters — occupancy is measured
  // against units, so the void is the point.
  void unitB

  const depotBank = await firstCheckingAccountId(company.id)
  if (depotBank) {
    await receiveDeposit(ctx, {
      leaseId: workshopLease.id,
      amountCents: 175_000,
      occurredOn: '2026-03-06',
      financialAccountId: depotBank,
      memo: 'One month, held under the tenancy agreement',
    })
  }

  // March is prorated — the tenancy starts on the 10th, so 22 of 31 days.
  for (const month of ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']) {
    await runRent(ctx, { month })
  }

  // Running one of them again on purpose: it bills nothing, because the
  // unique index has already spoken.
  const repeated = await runRent(ctx, { month: '2026-04-01' })

  const charges = await listRentCharges(ctx, { limit: 10 })
  const held = await depositsHeld(ctx, { asOf: '2026-06-30' })
  const let_ = await occupancy(ctx, { asOf: '2026-06-30' })

  console.log(
    `  Properties: ${charges.length} rent charges raised (one prorated), ` +
      `a repeat run billed ${repeated.invoicesRaised}.`,
  )
  console.log(
    `  Deposits held ${formatCentsPlain(held.registerCents)} against account 2580 ` +
      `at ${formatCentsPlain(held.ledgerCents)} — ${held.agrees ? 'agrees' : 'DISAGREES'}. ` +
      `${let_.occupied}/${let_.units} units let.`,
  )

  // --- Phase 24: retention, and the work nobody was doing --------------------
  //
  // Something for the sweep to find, and something for the digest to report.
  // Both are deliberately the shapes that are hardest to notice in production:
  // a failed sign-in from four years ago that nobody will ever look at, and an
  // invitation to a mistyped address that simply never arrived.
  await db.insert(loginAttempts).values([
    {
      email: 'someone@example.test',
      outcome: 'wrong_password',
      ipPrefix: '203.0.113.0/24',
      createdAt: new Date('2022-04-02T03:14:00Z'),
    },
    {
      email: 'someone@example.test',
      outcome: 'unknown_email',
      ipPrefix: '203.0.113.0/24',
      createdAt: new Date('2022-04-02T03:15:00Z'),
    },
  ])

  await db.insert(transactionalMessages).values({
    companyId: company.id,
    kind: 'company_invitation',
    email: 'jordan@ridgelien.test',
    subject: 'Dana Owner invited you to Ridgeline Construction',
    outcome: 'failed',
    providerKey: 'mock',
    error: 'No mail server for ridgelien.test — the domain does not exist.',
  })

  const holding = await retentionReport()
  const expiring = holding.reduce((sum, row) => sum + row.expired, 0)
  console.log(
    `  Retention: ${holding.length} policies, holding ${holding.reduce((sum, row) => sum + row.held, 0)} rows, ` +
      `${expiring} past their window and waiting for the 3am sweep.`,
  )
  console.log(
    '  One invitation bounced, to a mistyped domain — recorded since Phase 19 and shown to nobody until now.',
  )

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

  // --- Phase 21: the PDF a client actually receives -------------------------
  //
  // The proposals above were sent before the brand kit and the clause library
  // existed, so their documents were composed afterwards and those first
  // versions carry no PDF — which is the real "sent before it had a document"
  // case, left in on purpose.
  //
  // Re-sending the open one now issues version 2 *with* a snapshot, and that
  // snapshot is what the client link serves from here on, whatever anybody
  // does to the brand or the price list afterwards.
  if (openProposalId) {
    const reissued = await sendProposal(ctx, openProposalId)
    const [snapshot] = reissued.pdfDocumentId
      ? await db
          .select({ filename: documents.filename, sizeBytes: documents.sizeBytes })
          .from(documents)
          .where(eq(documents.id, reissued.pdfDocumentId))
      : []

    console.log(
      snapshot
        ? `  Re-sent as version ${reissued.versionNumber} with a rendered PDF ` +
            `(${snapshot.filename}, ${snapshot.sizeBytes} bytes). Version 1 has none — ` +
            'it was sent before the document existed.'
        : '  Re-sent, but NO PDF WAS RENDERED — the document is missing.',
    )
  }

  if (openProposalToken) {
    console.log(`  Open proposal, ready to accept: /p/${openProposalToken}`)
    console.log(`  The client's copy, exactly as sent: /p/${openProposalToken}/pdf`)
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

  // --- Phase 8: the mobile app --------------------------------------------

  console.log('Setting up the mobile app…')

  await registerDevice({
    userId: user.id,
    companyId: company.id,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
    label: "Dana's iPhone",
  })
  console.log('  Registered a phone, so the devices list has something to revoke.')

  await subscribe(ctx, {
    endpoint: 'https://push.example/demo-owner-endpoint',
    p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbNZ4',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  })
  console.log('  Subscribed that phone to notifications (the mock provider delivers none).')

  // Two transactions categorized the way the phone does it: through the
  // mobile API with an idempotency key, into the same ledger.
  const mobileCandidates = (
    await listInboxForMobile(ctx, { states: ['new'], limit: 2 })
  ).rows
  const mobileAccount = await accountByNumber(company.id, '6800')

  if (mobileAccount) {
    for (const candidate of mobileCandidates) {
      const key = randomUUID()
      const payload = { transactionId: candidate.id, chartAccountId: mobileAccount.id }

      await applyOperation(ctx, { key, operation: 'transaction.categorize', payload })
      // Sent twice on purpose, exactly as a phone that lost the first response
      // would. The second is a replay and changes nothing.
      const replay = await applyOperation(ctx, {
        key,
        operation: 'transaction.categorize',
        payload,
      })

      console.log(
        `  Categorized "${candidate.description}" from the phone, then replayed it — ` +
          `${replay.executed ? 'ran twice (wrong!)' : 'replayed, no second entry'}.`,
      )
    }
  }

  // A receipt on file, so the attachment path has something to show.
  if (mobileCandidates[0]) {
    const receipt = await uploadReceipt(ctx, {
      filename: 'builders-supply.jpg',
      contentType: 'image/jpeg',
      // A minimal valid JPEG header — the store keeps bytes, not pictures.
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    })
    await attachReceipt(ctx, mobileCandidates[0].id, receipt.id)
    console.log('  Attached a receipt to one of them.')
  }

  const nudge = await nudgeReviewQueue({
    companyId: company.id,
    userId: user.id,
    waiting: (await listInboxForMobile(ctx, { states: ['new'], limit: 200 })).rows.length,
  })
  console.log(
    nudge.sent > 0
      ? '  Sent a review nudge — recorded in the notification log, delivered nowhere.'
      : '  Not enough waiting to be worth a nudge.',
  )

  // --- Phase 9: payroll, sales tax, and the workpaper pack -----------------

  console.log('Running payroll and setting up tax…')

  // Entered by hand, the way most small businesses actually run payroll: the
  // bureau works out the withholding, and this records it and posts the entry.
  // Deliberately *not* the illustrative adapter — a demo whose payroll figures
  // are invented teaches the wrong thing about what this system knows.
  const dana = await createEmployee(ctx, {
    name: 'Dana Ruiz',
    reference: 'EMP-001',
    workerType: 'employee',
    payBasis: 'salary',
    baseRateCents: 8_400_000,
    taxIdLast4: '4417',
    startDate: '2024-03-04',
  })
  const marcus = await createEmployee(ctx, {
    name: 'Marcus Bell',
    reference: 'EMP-002',
    workerType: 'employee',
    payBasis: 'hourly',
    baseRateCents: 4_200,
    taxIdLast4: '9082',
    startDate: '2025-11-17',
  })
  console.log('  2 people on payroll, with the last four digits of a tax id and nothing more.')

  const july = await createPayrollRun(ctx, {
    frequency: 'monthly',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    payDate: '2026-07-31',
    sourceReference: 'Bureau report 2026-07',
    memo: 'July payroll — figures from the bureau report',
    payslips: [
      {
        employeeId: dana.id,
        lines: [
          { kind: 'earning', label: 'Salary', amountCents: 700_000 },
          { kind: 'employee_tax', label: 'Income tax withheld', amountCents: 112_400, agency: 'Revenue authority' },
          { kind: 'employee_tax', label: 'Social contribution withheld', amountCents: 43_400, agency: 'Revenue authority' },
          { kind: 'employee_deduction', label: 'Health plan', amountCents: 18_000, agency: 'Meridian Health' },
          { kind: 'employer_tax', label: 'Employer social contribution', amountCents: 43_400, agency: 'Revenue authority' },
          { kind: 'employer_tax', label: 'Unemployment contribution', amountCents: 4_200, agency: 'Unemployment fund' },
        ],
      },
      {
        employeeId: marcus.id,
        hoursMilli: 168_000,
        lines: [
          { kind: 'earning', label: 'Hourly pay', amountCents: 705_600 },
          { kind: 'employee_tax', label: 'Income tax withheld', amountCents: 98_800, agency: 'Revenue authority' },
          { kind: 'employee_tax', label: 'Social contribution withheld', amountCents: 43_700, agency: 'Revenue authority' },
          { kind: 'employer_tax', label: 'Employer social contribution', amountCents: 43_700, agency: 'Revenue authority' },
          { kind: 'employer_tax', label: 'Unemployment contribution', amountCents: 4_200, agency: 'Unemployment fund' },
        ],
      },
    ],
  })
  console.log(
    `  ${july.reference}: ${formatCentsPlain(july.totals.grossPayCents)} gross, ` +
      `${formatCentsPlain(july.totals.employerCostCents)} employer cost, ` +
      `${formatCentsPlain(july.totals.netPayCents)} net — one balanced entry.`,
  )

  // Part of what was withheld, remitted. Leaving the rest outstanding is the
  // point: the liabilities screen should have a real balance to look at.
  const payrollLiability = await accountByNumber(company.id, '2300')
  const checkingId = await firstCheckingAccountId(company.id)

  if (payrollLiability && checkingId) {
    await recordRemittance(ctx, {
      kind: 'payroll',
      agency: 'Revenue authority',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      paidOn: '2026-08-05',
      amountCents: 254_600,
      liabilityAccountId: payrollLiability.id,
      financialAccountId: checkingId,
      reference: 'EFT 88213',
    })
    console.log('  Remitted the income tax withheld — Dr the liability, Cr the bank, no expense.')
  }

  // Sales tax: the codes are the company's, entered with the rates its
  // jurisdictions gave it. Nothing here ships with the software.
  const cityTax = await createTaxCode(ctx, {
    code: 'CITY',
    name: 'City and county combined',
    jurisdiction: 'Springfield City',
    rateBp: 825,
    effectiveFrom: '2026-01-01',
  })
  const stateTax = await createTaxCode(ctx, {
    code: 'STATE',
    name: 'State sales tax',
    jurisdiction: 'State',
    rateBp: 400,
    effectiveFrom: '2026-01-01',
  })
  console.log('  2 tax codes at 8.25% and 4% — the company’s rates, not ours.')

  if (contractRevenue) {
    const taxed = await createInvoice(ctx, {
      customerId: harborview.id,
      issueDate: '2026-08-05',
      lines: [
        {
          chartAccountId: contractRevenue.id,
          description: 'Kitchen fit-out — taxable materials and labour',
          unitPriceCents: 480_000,
        },
      ],
      taxLines: [
        { taxCodeId: cityTax.id, taxableCents: 320_000, exemptCents: 60_000 },
        { taxCodeId: stateTax.id, taxableCents: 160_000 },
      ],
    })
    console.log(
      `  Invoice with tax priced from those codes: ${formatCentsPlain(taxed.taxCents)} across two jurisdictions.`,
    )
  }

  // A contractor paid over the threshold with no identifier on file. This is
  // the exception the workpaper pack exists to surface, and clearing it in the
  // UI is the most instructive thing in this workspace.
  const delta = await createVendor(ctx, { name: 'Delta Electrical' })
  const contractExpense = await accountByNumber(company.id, '5130')

  if (contractExpense && checkingId) {
    const deltaBill = await createBill(ctx, {
      vendorId: delta.id,
      issueDate: '2026-04-02',
      lines: [
        {
          chartAccountId: contractExpense.id,
          description: 'Rough-in electrical, Harborview',
          unitPriceCents: 340_000,
        },
      ],
    })
    await recordPayment(ctx, {
      kind: 'disbursement',
      vendorId: delta.id,
      paymentDate: '2026-04-28',
      amountCents: 340_000,
      financialAccountId: checkingId,
      applications: [{ billId: deltaBill.id, amountCents: 340_000 }],
    })
    await setVendorReporting(ctx, delta.id, { isReportable: true })
    console.log(
      '  Delta Electrical: paid over the threshold, marked reportable, no tax id — a blocker on purpose.',
    )
  }

  const pack = await workpaperPack(ctx, { startDate: '2026-07-01', endDate: '2026-09-30' })
  const blockers = pack.exceptions.filter((entry) => entry.severity === 'blocker').length
  const warnings = pack.exceptions.filter((entry) => entry.severity === 'warning').length
  console.log(
    `  Workpaper pack for Q3: ${blockers} ${blockers === 1 ? 'blocker' : 'blockers'}, ` +
      `${warnings} worth checking.`,
  )

  // --- Phase 10: the background worker and the outbox ----------------------

  console.log('Installing background schedules…')

  const installed = await installCompanySchedules(company.id)
  const globals = await installGlobalSchedules()
  console.log(
    `  ${installed} company schedules and ${globals} housekeeping schedules — the clock four ADRs asked for.`,
  )

  // The outbox, with something real in it. Accepting a proposal above already
  // recorded a `proposal.accepted` event inside its own transaction; this
  // drains it so the demo has a delivered notification rather than a pending
  // one to explain.
  const tick = await runOnce({ workerId: 'seed' })
  console.log(
    `  Ran one tick: ${tick.eventsRelayed} events relayed, ${tick.jobsRun} jobs run ` +
      `(${tick.jobsSucceeded} succeeded, ${tick.jobsDead} dead).`,
  )

  // A proposed WIP entry, so the demo shows the shape of the thing this phase
  // is most careful about: a machine that worked out an entry and did not post
  // it.
  await enqueue({
    kind: 'jobs.propose_wip_entry',
    companyId: company.id,
    payload: { asOfDate: '2026-07-31' },
    dedupeKey: `seed-wip:${company.id}`,
  })
  const second = await runOnce({ workerId: 'seed' })
  const drafts = await listDraftEntries(ctx)
  console.log(
    `  Proposed the WIP adjusting entry: ${drafts.length} draft waiting for a person ` +
      `(${second.jobsSucceeded} job succeeded). It changes no report until somebody posts it.`,
  )

  // One job that fails on purpose, so the operations page has a dead row to
  // show rather than an empty state that looks the same as a broken worker.
  await enqueue({
    kind: 'handler.removed.by.a.deploy',
    companyId: company.id,
    dedupeKey: `seed-dead:${company.id}`,
  })
  await runOnce({ workerId: 'seed' })
  console.log('  Queued one job with no handler, so the operations page has a failure to show.')

  // --- Phase 11: the accounting core completed -----------------------------

  console.log('Completing the accounting core…')

  // A credit note and a write-off on two different invoices, so the demo shows
  // the distinction rather than describing it.
  if (contractRevenue) {
    const disputed = await createInvoice(ctx, {
      customerId: cityWorks.id,
      issueDate: '2026-02-10',
      dueDate: '2026-03-12',
      lines: [
        { chartAccountId: contractRevenue.id, description: 'Sidewalk survey', unitPriceCents: 180_000 },
      ],
    })

    await createCreditNote(ctx, {
      customerId: cityWorks.id,
      issueDate: '2026-03-01',
      invoiceId: disputed.id,
      reason: 'Surveyed the wrong parcel — never should have been billed',
      applyImmediately: true,
    })
    console.log('  Credit note against a mis-billed invoice: revenue reversed, never earned.')

    const abandoned = await createInvoice(ctx, {
      customerId: cityWorks.id,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      lines: [
        { chartAccountId: contractRevenue.id, description: 'Culvert repair', unitPriceCents: 240_000 },
      ],
    })

    await writeOffInvoice(ctx, abandoned.id, {
      writtenOffOn: '2026-07-31',
      reason: 'Contractor entered administration; no prospect of recovery',
    })
    console.log('  Write-off on an uncollectable one: revenue stays, the loss is Bad Debt.')
  }

  // --- Phase 35: two euro invoices, one settled and one still open ----------
  //
  // Both raised at 1.0835 and the rate then moves to 1.1000. One is paid, so
  // the gain is realised and in account 7100; the other is not, so the movement
  // is exposure — reported on /accounting/currencies and posted nowhere.
  //
  // That contrast is the whole phase, and it needs both halves to be visible
  // at once or it reads as a rounding curiosity.
  if (contractRevenue) {
    await putRate(ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-04-01',
      rateMillionths: 1_083_500,
      source: 'ECB',
    })
    await putRate(ctx, {
      baseCurrency: 'EUR',
      rateDate: '2026-06-30',
      rateMillionths: 1_100_000,
      source: 'ECB',
    })

    const bremen = await createCustomer(ctx, {
      name: 'Bremen Hafenbau GmbH',
      email: 'buchhaltung@bremen-hafenbau.test',
    })

    const settled = await createInvoice(ctx, {
      customerId: bremen.id,
      issueDate: '2026-04-01',
      dueDate: '2026-05-31',
      currency: 'EUR',
      lines: [
        {
          chartAccountId: contractRevenue.id,
          description: 'Quay wall condition survey',
          unitPriceCents: 400_000,
        },
      ],
    })

    await recordPayment(ctx, {
      kind: 'receipt',
      customerId: bremen.id,
      paymentDate: '2026-06-30',
      amountCents: 400_000,
      reference: 'SEPA transfer',
      applications: [{ invoiceId: settled.id, amountCents: 400_000 }],
    })

    await createInvoice(ctx, {
      customerId: bremen.id,
      issueDate: '2026-04-01',
      dueDate: '2026-09-30',
      currency: 'EUR',
      lines: [
        {
          chartAccountId: contractRevenue.id,
          description: 'Second phase — dredging supervision',
          unitPriceCents: 250_000,
        },
      ],
    })

    const gainAccount = await accountByNumber(company.id, '7100')
    const realisedCents = gainAccount ? await balanceForAccount(ctx, gainAccount.id) : 0

    console.log(
      `  Two euro invoices raised at 1.0835. The €4,000 one was paid at 1.1000, so ` +
        `${formatCentsPlain(realisedCents)} is a realised gain in account 7100. The €2,500 one ` +
        'is still open — worth more today, and posted nowhere.',
    )
  }

  // A statement a customer would actually be sent.
  await saveStatement(ctx, { customerId: harborview.id, asOfDate: '2026-08-14' })
  console.log('  Saved an open-item statement, with its figures frozen as at that date.')


  // A recurring entry of each kind, so the autoPost distinction is visible.
  const rentAccount = await accountByNumber(company.id, '6400')
  const accrualsAccount = await accountByNumber(company.id, '2300')

  if (rentAccount && accrualsAccount) {
    await createRecurringEntry(ctx, {
      name: 'Monthly rent accrual',
      memo: 'Yard and office rent',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: true,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rentAccount.id, debitCents: 420_000 },
        { chartAccountId: accrualsAccount.id, creditCents: 420_000 },
      ],
    })

    await createRecurringEntry(ctx, {
      name: 'Estimated equipment depreciation',
      memo: 'Estimate — review before posting',
      cadence: 'monthly',
      dayOfMonth: 1,
      autoPost: false,
      startsOn: '2026-01-01',
      lines: [
        { chartAccountId: rentAccount.id, debitCents: 65_000 },
        { chartAccountId: accrualsAccount.id, creditCents: 65_000 },
      ],
    })

    const ran = await runDueRecurringEntries(ctx, '2026-08-14')
    const posted = ran.filter((row) => row.posted).length
    const drafted = ran.filter((row) => row.journalEntryId && !row.posted).length
    console.log(
      `  2 recurring templates, caught up to date: ${posted} posted, ${drafted} proposed as drafts.`,
    )
  }

  // --- Phase 12: the statements an accountant asks for ---------------------

  // Depreciation used to be a hand-written $4,800 entry here, so the cash flow
  // statement had the add-back the whole indirect method is built around.
  //
  // Phase 16 posts it from the fixed asset register instead, further down. The
  // hand-written one was removed rather than left alongside, because the two
  // together are exactly the double-count the register exists to catch: the
  // demo's own reconciliation reported the disagreement the first time it ran,
  // which is the feature working and a bad thing to ship as the demo's
  // headline. The cash flow add-back is unchanged — it comes from a real
  // schedule now instead of a placeholder.

  // An accrual and its reversal — the pattern cash basis is supposed to see
  // through, and the one that used to show as an expense in the wrong month.
  const accruedLiabilities = await accountByNumber(company.id, '2150')
  const siteRentAccount = await accountByNumber(company.id, '6400')
  const checkingChart = await accountByNumber(company.id, '1000')
  if (accruedLiabilities && siteRentAccount && checkingChart) {
    await postManualEntry(ctx, {
      entryDate: '2026-05-31',
      memo: 'Accrue May site rent, invoice not yet received',
      source: 'adjusting',
      lines: [
        { chartAccountId: siteRentAccount.id, debitCents: 285_000 },
        { chartAccountId: accruedLiabilities.id, creditCents: 285_000 },
      ],
    })
    await postManualEntry(ctx, {
      entryDate: '2026-06-15',
      memo: 'Settle May site rent',
      source: 'manual',
      lines: [
        { chartAccountId: accruedLiabilities.id, debitCents: 285_000 },
        { chartAccountId: checkingChart.id, creditCents: 285_000 },
      ],
    })
  }

  // Two receipts waiting to be banked, so the deposits screen has an envelope
  // to fill rather than an empty state.
  const bankableInvoices = await listInvoices(ctx, { limit: 200 })
  const waiting = bankableInvoices
    .filter((invoice) => invoice.balanceCents > 0 && invoice.status !== 'void')
    .slice(0, 2)

  for (const invoice of waiting) {
    await recordPayment(ctx, {
      kind: 'receipt',
      customerId: invoice.customerId,
      paymentDate: '2026-07-06',
      amountCents: invoice.balanceCents,
      // No financial account: the cheque arrived and has not been banked.
      applications: [{ invoiceId: invoice.id, amountCents: invoice.balanceCents }],
      reference: 'Cheque',
    })
  }

  if (waiting.length > 0) {
    console.log(
      `  ${waiting.length} receipt(s) waiting to be deposited — the bank will show one line for all of them.`,
    )
  }

  // --- Phase 14: inventory -------------------------------------------------
  //
  // Ridgeline is a contractor, so the construction pack does not switch stock
  // on. It is enabled here anyway: a contractor who keeps fittings on a shelf
  // is exactly the case the module gate exists for — industry is a starting
  // point, not a cage.
  await setModuleEnabled(ctx, 'inventory', true)

  const inventoryRevenue = await accountByNumber(company.id, '4200')
  const grniAccount = await accountByNumber(company.id, '2050')

  if (inventoryRevenue && grniAccount) {
    const stockItems = [
      { code: 'FIX-100', name: 'Bathroom fixture set', unit: 'each', price: 48_000, cost: 26_500 },
      { code: 'TILE-SQ', name: 'Porcelain tile', unit: 'sq ft', price: 1_200, cost: 620 },
      { code: 'LUM-2X4', name: 'Framing lumber 2x4', unit: 'each', price: 1_150, cost: 690 },
    ]

    const created = []
    for (const stock of stockItems) {
      const [item] = await db
        .insert(serviceItems)
        .values({
          companyId: company.id,
          code: stock.code,
          name: stock.name,
          unit: stock.unit,
          unitPriceCents: stock.price,
          unitCostCents: stock.cost,
          isInventoried: true,
          reorderPointMilli: 20_000,
          chartAccountId: inventoryRevenue.id,
        })
        .returning()
      created.push({ ...stock, id: item.id })
    }

    // Two deliveries at different costs, so the average is a real average and
    // the two cost methods would genuinely differ.
    //
    // Through `receiveGoods` rather than the lower-level `receiveStock`, so the
    // Goods Received Not Invoiced balance has receipts itemising it. A balance
    // in that account with nothing behind it is the exact thing the screen
    // exists to prevent.
    const stockVendorId = (await createVendor(ctx, { name: 'Cascade Building Supply' })).id

    for (const [receivedOn, multiplier] of [
      ['2026-05-04', 1],
      ['2026-07-02', 1.08],
    ] as const) {
      await receiveGoods(ctx, {
        vendorId: stockVendorId,
        receivedOn,
        reference: multiplier === 1 ? 'Opening stock' : 'Restock at the new price',
        lines: created.map((item) => ({
          itemId: item.id,
          quantityMilli: multiplier === 1 ? 60_000 : 40_000,
          unitCostCents: Math.round(item.cost * multiplier),
        })),
      })
    }

    // A count that came up short, with a reason — which the service insists on.
    await adjustStock(ctx, {
      itemId: created[1].id,
      countedMilli: 78_000,
      adjustedOn: '2026-07-31',
      reason: 'Quarterly count — two boxes cracked in the van',
    })

    const positions = await stockOnHand(ctx)
    const reconciliation = await reconcileInventory(ctx)
    const stockValue = positions.reduce((sum, position) => sum + position.valueCents, 0)

    const awaiting = await unbilledReceipts(ctx)
    console.log(
      `  ${positions.length} stocked items worth ${formatCentsPlain(stockValue)} — ` +
        `subledger and the Inventory account ${reconciliation.agrees ? 'agree' : 'DISAGREE'}.`,
    )
    console.log(
      `  ${awaiting.length} deliveries awaiting a supplier bill, ` +
        `${formatCentsPlain(awaiting.reduce((sum, row) => sum + row.totalCents, 0))} in Goods Received Not Invoiced.`,
    )
  }

  // --- Phase 15: time and billing ------------------------------------------
  //
  // Ridgeline is a contractor, and contractors bill time too — the site
  // supervisor's hours on a cost-plus job are the same shape as a consultant's.
  // Switched on here for the same reason inventory was: industry is a starting
  // point, not a cage.
  await setModuleEnabled(ctx, 'time_billing', true)

  const timeProjects = await listProjects(ctx)
  if (timeProjects.length > 0) {
    const engagement = timeProjects[0]

    await setPersonRate(ctx, { userId: user.id, rateCents: 14_500, costRateCents: 6_200 })

    const days: Array<[string, number, string, boolean]> = [
      ['2026-06-02', 210, 'Site walk-through and punch list', true],
      ['2026-06-03', 90, 'Change order pricing with the client', true],
      ['2026-06-04', 45, 'Internal scheduling', false],
      ['2026-06-08', 180, 'Coordinating the mechanical sub', true],
      ['2026-06-09', 120, 'Progress photos and daily report', true],
    ]

    const logged = []
    for (const [workedOn, minutes, description, isBillable] of days) {
      logged.push(
        await logTime(ctx, {
          projectId: engagement.id,
          workedOn,
          minutes,
          description,
          isBillable,
        }),
      )
    }

    // Most approved, one left as a draft so the approval queue is not empty.
    await approveTime(
      ctx,
      logged.slice(0, 4).map((entry) => entry.id),
    )

    await recordBillableExpense(ctx, {
      projectId: engagement.id,
      incurredOn: '2026-06-05',
      description: 'Permit filing fee',
      costCents: 32_500,
      markupBasisPoints: 0,
    })

    const ready = await unbilledWork(ctx)
    const readyCents = ready.reduce((sum, row) => sum + row.totalCents, 0)
    console.log(
      `  ${formatCentsPlain(readyCents)} of approved work waiting to be billed, oldest ${ready[0]?.oldestDate ?? '—'}.`,
    )
  }

  // --- Phase 16: dimensions and the fixed asset register -------------------
  //
  // Ridgeline runs two yards. That is not a project — a yard does not start,
  // finish, or get billed — so it is exactly the case projects and cost codes
  // do not cover.
  const location = await createDimension(ctx, {
    name: 'Location',
    code: 'LOC',
    requirement: 'expected',
    description: 'Which yard the money belongs to.',
  })

  const northYard = await createDimensionValue(ctx, {
    dimensionId: location.id,
    code: 'NORTH',
    name: 'North yard',
  })
  const southYard = await createDimensionValue(ctx, {
    dimensionId: location.id,
    code: 'SOUTH',
    name: 'South yard',
  })

  // Deliberately partial. A demo where everything is tagged would show a
  // coverage figure of 100% and teach nothing — the whole point of the
  // Unassigned column is that real books arrive part-way tagged, and the
  // number tells you how much of the report you are entitled to believe.
  const plLines = await db
    .select({ id: journalLines.id })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
    .innerJoin(chartAccounts, eq(chartAccounts.id, journalLines.chartAccountId))
    .where(
      and(
        eq(journalLines.companyId, company.id),
        eq(journalEntries.status, 'posted'),
        inArray(chartAccounts.type, ['revenue', 'cogs', 'expense']),
      ),
    )
    .orderBy(asc(journalEntries.entryDate))

  const tagged = plLines.slice(0, Math.floor(plLines.length * 0.72))
  const half = Math.ceil(tagged.length / 2)

  if (tagged.length > 0) {
    await reclassifyLines(ctx, {
      journalLineIds: tagged.slice(0, half).map((line) => line.id),
      dimensionId: location.id,
      dimensionValueId: northYard.id,
    })
    await reclassifyLines(ctx, {
      journalLineIds: tagged.slice(half).map((line) => line.id),
      dimensionId: location.id,
      dimensionValueId: southYard.id,
    })
  }

  const byLocation = await dimensionalProfitAndLoss(ctx, {
    dimensionId: location.id,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  })
  console.log(
    `  ${Math.round((byLocation.coverage.basisPointsAssigned ?? 0) / 100)}% of profit-and-loss ` +
      `activity carries a Location; the rest is one column called Unassigned. ` +
      `Columns foot to the account totals: ${byLocation.totalsAgree ? 'yes' : 'NO'}.`,
  )

  // Two assets a contractor actually owns, bought before the books open so the
  // register has arrears to catch up — which is the normal state of a fixed
  // asset register, not an edge case.
  const checking = await accountByNumber(company.id, SYSTEM_ACCOUNTS.defaultChecking)

  const truck = await registerAsset(ctx, {
    name: 'Ford F-350 crew truck',
    category: 'Vehicles',
    costCents: 5_850_000,
    salvageValueCents: 850_000,
    lifeMonths: 60,
    acquiredDate: '2026-01-15',
    method: 'straight_line',
    postAcquisitionCreditAccountId: checking?.id,
  })

  await registerAsset(ctx, {
    name: 'Skid-steer loader',
    category: 'Plant',
    costCents: 4_275_000,
    lifeMonths: 84,
    acquiredDate: '2026-03-01',
    method: 'declining_balance_switch',
    convention: 'half_year',
    postAcquisitionCreditAccountId: checking?.id,
  })

  // --- Phase 20: the paperwork behind the numbers ---------------------------
  //
  // The same PDF on two records, so the documents page shows a file used twice
  // rather than two copies of one file — which is the claim of the phase, and
  // the thing you cannot see from a list of one.
  const purchaseInvoice = await storeDocument(ctx, {
    filename: 'ford-f350-invoice.pdf',
    contentType: 'application/pdf',
    // A minimal valid PDF header — the store keeps bytes, not documents.
    data: Buffer.from('%PDF-1.4\nFord F-350 crew truck, invoice 88412\n%%EOF'),
    note: 'Dealer invoice, matches the finance agreement.',
  })

  await attachDocument(ctx, {
    subjectType: 'fixed_asset',
    subjectId: truck.id,
    documentId: purchaseInvoice.id,
  })

  const sameBytesAgain = await storeDocument(ctx, {
    filename: 'ford-invoice-resent-by-dealer.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('%PDF-1.4\nFord F-350 crew truck, invoice 88412\n%%EOF'),
  })

  await writeNote(ctx, {
    subjectType: 'fixed_asset',
    subjectId: truck.id,
    body: 'Five-year life agreed with the accountant; salvage from the dealer buy-back quote.',
  })

  await writeNote(ctx, {
    subjectType: 'fixed_asset',
    subjectId: truck.id,
    body: 'Is the extended warranty capitalised here or expensed? Invoice does not separate it.',
    isQuestion: true,
  })

  console.log(
    `  Evidence: the dealer invoice is on the truck, and re-uploading it ` +
      `${sameBytesAgain.deduplicated ? 'returned the same document' : 'MADE A SECOND COPY'} ` +
      'rather than storing the bytes twice. One question left open on it.',
  )

  await runDepreciation(ctx, { throughDate: '2026-06-30' })

  const reconciliation = await reconcileFixedAssets(ctx, { asOf: '2026-06-30' })
  const owed = await depreciationDue(ctx, { throughDate: '2026-12-31' })
  console.log(
    `  Fixed assets: ${formatCentsPlain(reconciliation.registerBookValueCents)} book value, ` +
      `register and ledger ${reconciliation.agrees ? 'agree' : 'DISAGREE'}. ` +
      `${new Set(owed.map((row) => row.periodEnd)).size} months of depreciation still owed.`,
  )

  // --- Phase 18: accountant practice mode ----------------------------------
  //
  // The demo's own accountant, at a real firm, with access Ridgeline granted
  // rather than the firm claimed. Two engagements so the switcher has
  // somewhere to switch to, and so the isolation is visible rather than
  // asserted.
  const practiceOwner = await registerUser({
    name: 'Robin Hartley',
    email: 'robin@hartleyco.test',
    password: DEMO_PASSWORD,
  })

  const practice = await createPractice({
    userId: practiceOwner.id,
    userName: practiceOwner.name,
    name: 'Hartley & Co',
    contactEmail: 'hello@hartleyco.test',
  })

  const junior = await registerUser({
    name: 'Sam Okafor',
    email: 'sam@hartleyco.test',
    password: DEMO_PASSWORD,
  })
  await addPracticeMember(
    { userId: practiceOwner.id, userName: practiceOwner.name },
    { practiceId: practice.id, userId: junior.id },
  )

  // Ridgeline invites them; the firm accepts. Neither side could have done
  // both halves.
  const { engagementId } = await offerEngagement(ctx, {
    practiceId: practice.id,
    grantedRole: 'accountant',
    note: 'Year-end and monthly review.',
  })
  await respondToEngagement(
    { side: 'practice', userId: practiceOwner.id, userName: practiceOwner.name },
    { engagementId, accept: true },
  )

  // A second client, so the switcher has two entries and the practice work
  // queue has something to compare. Small on purpose — the point is the
  // isolation, not the second company's books.
  const secondClient = await registerCompany({
    companyName: 'Kestrel Joinery',
    industry: 'professional_services',
    userName: 'Sam Owner',
    email: 'owner@kestrel.test',
    password: DEMO_PASSWORD,
  })

  const secondCtx: ActorContext = {
    userId: secondClient.user.id,
    userName: secondClient.user.name,
    companyId: secondClient.company.id,
    role: 'owner',
  }

  const secondOffer = await offerEngagement(secondCtx, {
    practiceId: practice.id,
    grantedRole: 'bookkeeper',
    note: 'Bookkeeping only.',
  })
  await respondToEngagement(
    { side: 'practice', userId: practiceOwner.id, userName: practiceOwner.name },
    { engagementId: secondOffer.engagementId, accept: true },
  )

  const queue = await practiceWorkQueue(practiceOwner.id, practice.id)
  console.log(
    `  Hartley & Co act for ${queue.length} clients — ` +
      `${queue.map((row) => `${row.companyName} (${row.role}, ${row.awaitingReview} waiting)`).join(', ')}. ` +
      'Each granted separately; neither can be seen while in the other.',
  )

  // --- Phase 25: who at the firm is on which client ------------------------
  //
  // The two engagements are deliberately staffed differently, because the
  // difference is the phase: Ridgeline is the whole firm's, and Kestrel is
  // Robin's alone. Sam works at Hartley & Co and cannot open Kestrel's books —
  // which before this phase was not expressible at all.
  await assignToEngagement(practiceOwner.id, {
    engagementId: secondOffer.engagementId,
    userId: practiceOwner.id,
    note: 'Sole contact for this client.',
  })

  const restricted = await setEngagementStaffing(practiceOwner.id, {
    engagementId: secondOffer.engagementId,
    staffing: 'assigned_only',
  })

  // And a narrower role on the client that stayed open to everybody: Sam is an
  // accountant at the firm and read-only at Ridgeline, because an assignment
  // may narrow what somebody holds even when it grants nothing new.
  await assignToEngagement(practiceOwner.id, {
    engagementId,
    userId: junior.id,
    role: 'readonly',
    note: 'Reviewing only, not posting.',
  })

  console.log(
    `  Staffing: Kestrel is Robin's alone (${restricted.revoked} removed), ` +
      'Ridgeline is the whole firm with Sam narrowed to readonly.',
  )

  // --- Phase 26: money given for a purpose ---------------------------------
  //
  // Its own company, because a contractor has no funds and pretending
  // otherwise would demonstrate the screen rather than the accounting. A small
  // charity with three funds is the smallest thing that shows all four claims.
  const charity = await registerCompany({
    companyName: 'Riverside Community Trust',
    industry: 'nonprofit',
    userName: 'Nadia Okonjo',
    email: 'nadia@riverside.test',
    password: DEMO_PASSWORD,
  })

  const charityCtx: ActorContext = {
    userId: charity.user.id,
    userName: charity.user.name,
    companyId: charity.company.id,
    role: 'owner',
  }

  const [charityBank] = await db
    .insert(financialAccounts)
    .values({
      companyId: charity.company.id,
      chartAccountId: (await accountByNumber(charity.company.id, '1000'))!.id,
      name: 'Charity Current Account',
      mask: '8812',
      kind: 'checking',
      providerAccountId: 'seed-riverside-current',
    })
    .returning()

  const roofFund = await createFund(charityCtx, {
    code: 'ROOF',
    name: 'Hall roof appeal',
    restriction: 'restricted',
    purpose: 'Replacing the community hall roof, as set out in the appeal letter.',
  })

  const generalFund = await createFund(charityCtx, {
    code: 'GENERAL',
    name: 'General funds',
    restriction: 'unrestricted',
    purpose: 'Whatever the trustees decide.',
  })

  // An endowment, so the release run has something it must refuse to touch.
  const legacyFund = await createFund(charityCtx, {
    code: 'LEGACY',
    name: 'Hoyle legacy',
    restriction: 'perpetual',
    purpose: 'Held in perpetuity. Only the income may be spent.',
  })

  const majorDonor = await createCustomer(charityCtx, {
    name: 'Marguerite Adeyemi',
    email: 'marguerite@example.test',
  })

  await recordContribution(charityCtx, {
    fundId: roofFund.id,
    donorId: majorDonor.id,
    receivedOn: '2026-03-02',
    amountCents: 1_000_00,
    financialAccountId: charityBank.id,
    memo: 'Opening gift to the appeal.',
  })

  await recordContribution(charityCtx, {
    fundId: roofFund.id,
    receivedOn: '2026-03-14',
    amountCents: 340_00,
    financialAccountId: charityBank.id,
    memo: 'Collection at the spring fair — no donor named.',
  })

  await recordContribution(charityCtx, {
    fundId: generalFund.id,
    receivedOn: '2026-03-05',
    amountCents: 620_00,
    financialAccountId: charityBank.id,
  })

  await recordContribution(charityCtx, {
    fundId: legacyFund.id,
    receivedOn: '2026-01-20',
    amountCents: 5_000_00,
    financialAccountId: charityBank.id,
    memo: 'Left by will. The principal is never spendable.',
  })

  // A promise, left outstanding on purpose. It is already income — the
  // statement of activities for March includes it — and the money has not
  // arrived, which is the whole of Phase 26's second claim on one row.
  await recordContribution(charityCtx, {
    fundId: roofFund.id,
    donorId: majorDonor.id,
    kind: 'pledge',
    source: 'grant',
    receivedOn: '2026-03-20',
    amountCents: 2_500_00,
    reference: 'Heritage grant, letter of 20 March',
  })

  // Spending posted as an ordinary journal entry, through no part of the funds
  // module — the same proof Phase 23 ran with a roof repair against a property.
  // The release run below finds it anyway, because a fund is a dimension.
  const programExpense = await accountByNumber(charity.company.id, '6020')
  await postManualEntry(charityCtx, {
    entryDate: '2026-03-24',
    memo: 'Scaffolding for the roof works',
    lines: [
      {
        chartAccountId: programExpense!.id,
        debitCents: 400_00,
        dimensions: { [(await fundDimensionId(charityCtx))!]: roofFund.dimensionValueId },
      },
      { chartAccountId: charityBank.chartAccountId, creditCents: 400_00 },
    ],
  })

  const marchRelease = await runReleases(charityCtx, { month: '2026-03-01' })

  const charityPosition = await netAssets(charityCtx, { asOf: '2026-12-31' })
  console.log(
    `  Riverside Community Trust: ${formatCentsPlain(charityPosition.withRestrictionCents)} restricted, ` +
      `${formatCentsPlain(charityPosition.withoutRestrictionCents)} unrestricted. ` +
      `March released ${formatCentsPlain(marchRelease.releasedCents)} — the same money, a different column.`,
  )

  // --- Phase 27: cost moving through a factory ------------------------------
  //
  // Its own company again, because Ridgeline builds on site and Riverside is a
  // charity — neither has a work in process account and pretending otherwise
  // would demonstrate the screen rather than the accounting.
  const workshop = await registerCompany({
    companyName: 'Kestrel Fabrication',
    industry: 'manufacturing',
    userName: 'Tomasz Lewandowski',
    email: 'tomasz@kestrelfab.test',
    password: DEMO_PASSWORD,
  })

  const workshopCtx: ActorContext = {
    userId: workshop.user.id,
    userName: workshop.user.name,
    companyId: workshop.company.id,
    role: 'owner',
  }

  const [workshopBank] = await db
    .insert(financialAccounts)
    .values({
      companyId: workshop.company.id,
      chartAccountId: (await accountByNumber(workshop.company.id, '1000'))!.id,
      name: 'Workshop Current Account',
      mask: '3390',
      kind: 'checking',
      providerAccountId: 'seed-kestrel-current',
    })
    .returning()

  const productRevenue = await accountByNumber(workshop.company.id, '4060')
  const rawMaterialsAccount = await accountByNumber(workshop.company.id, '1440')
  const finishedGoodsAccount = await accountByNumber(workshop.company.id, '1460')

  // Two raw materials and one finished good. The raw materials name 1440 and
  // the finished good names 1460 — the per-item seam Phase 14 left open, used
  // here for the first time.
  const [steel, hinge, cabinet] = await db
    .insert(serviceItems)
    .values([
      {
        companyId: workshop.company.id,
        code: 'SHEET',
        name: 'Steel sheet, 2mm',
        unit: 'sheet',
        unitPriceCents: 0,
        unitCostCents: 4_200,
        isInventoried: true,
        chartAccountId: productRevenue!.id,
        inventoryAccountId: rawMaterialsAccount!.id,
      },
      {
        companyId: workshop.company.id,
        code: 'HINGE',
        name: 'Piano hinge',
        unit: 'each',
        unitPriceCents: 0,
        unitCostCents: 850,
        isInventoried: true,
        chartAccountId: productRevenue!.id,
        inventoryAccountId: rawMaterialsAccount!.id,
      },
      {
        companyId: workshop.company.id,
        code: 'CAB',
        name: 'Tool cabinet',
        unit: 'each',
        unitPriceCents: 42_000,
        unitCostCents: 0,
        isInventoried: true,
        chartAccountId: productRevenue!.id,
        inventoryAccountId: finishedGoodsAccount!.id,
      },
    ])
    .returning()

  const workshopPayable = await accountByNumber(workshop.company.id, '2000')

  // Bought at two different prices, so the run's cost comes from the lots
  // rather than from the item's planning figure.
  await receiveStock(workshopCtx, {
    itemId: steel.id,
    quantityMilli: 40_000,
    unitCostCents: 4_000,
    receivedOn: '2026-02-10',
    creditAccountId: workshopPayable!.id,
  })
  await receiveStock(workshopCtx, {
    itemId: steel.id,
    quantityMilli: 20_000,
    unitCostCents: 4_600,
    receivedOn: '2026-03-02',
    creditAccountId: workshopPayable!.id,
  })
  await receiveStock(workshopCtx, {
    itemId: hinge.id,
    quantityMilli: 60_000,
    unitCostCents: 850,
    receivedOn: '2026-02-10',
    creditAccountId: workshopPayable!.id,
  })

  const cabinetBom = await createBom(workshopCtx, {
    outputItemId: cabinet.id,
    name: 'Tool cabinet, batch of 10',
    batchMilli: 10_000,
    notes: 'Written per batch of ten, so a half-sheet per cabinet needs no rounding.',
    components: [
      // Half a sheet each, with 5% expected wastage on the cut.
      { componentItemId: steel.id, quantityMilli: 5_000, scrapBp: 500 },
      { componentItemId: hinge.id, quantityMilli: 10_000 },
    ],
  })

  // A finished run, so the demo opens on a real unit cost.
  const finishedRun = await createWorkOrder(workshopCtx, {
    outputItemId: cabinet.id,
    bomId: cabinetBom.id,
    plannedMilli: 10_000,
    startedOn: '2026-03-09',
  })

  await issueMaterial(workshopCtx, {
    workOrderId: finishedRun.id,
    itemId: steel.id,
    // The recipe asked for 5.25 sheets; the floor took 6. That gap is what the
    // variance report exists to show.
    quantityMilli: 6_000,
    occurredOn: '2026-03-09',
  })
  await issueMaterial(workshopCtx, {
    workOrderId: finishedRun.id,
    itemId: hinge.id,
    quantityMilli: 10_000,
    occurredOn: '2026-03-09',
  })
  await absorbCost(workshopCtx, {
    workOrderId: finishedRun.id,
    kind: 'labour',
    costCents: 96_000,
    occurredOn: '2026-03-11',
  })
  await absorbCost(workshopCtx, {
    workOrderId: finishedRun.id,
    kind: 'overhead',
    costCents: 24_000,
    occurredOn: '2026-03-11',
  })

  // Nine good and one scrapped: the ten cabinets' cost lands on nine.
  const completed = await completeWorkOrder(workshopCtx, {
    workOrderId: finishedRun.id,
    producedMilli: 9_000,
    scrappedMilli: 1_000,
    completedOn: '2026-03-13',
  })

  // A second run left open, so the WIP reconciliation has something in it.
  const openRun = await createWorkOrder(workshopCtx, {
    outputItemId: cabinet.id,
    bomId: cabinetBom.id,
    plannedMilli: 6_000,
    startedOn: '2026-03-16',
  })
  await issueMaterial(workshopCtx, {
    workOrderId: openRun.id,
    itemId: steel.id,
    quantityMilli: 3_000,
    occurredOn: '2026-03-16',
  })

  const floor = await wipPosition(workshopCtx, { asOf: '2026-12-31' })
  console.log(
    `  Kestrel Fabrication: ${completed.producedMilli / 1000} cabinets at ` +
      `${formatCentsPlain(completed.unitCostCents)} each — one scrapped, so ten cabinets' cost ` +
      `landed on nine. Work in process ${formatCentsPlain(floor.registerCents)} against account ` +
      `1450 at ${formatCentsPlain(floor.ledgerCents)} — ${floor.agrees ? 'agrees' : 'DISAGREES'}.`,
  )

  // --- Phase 28: a day's trading, arriving from somebody else's system ------
  //
  // A café rather than a marketplace seller, because a till is the harder of
  // the two: a marketplace settlement cannot be miscounted and a drawer can.
  // The same module serves both, which is the point — see ADR 0028.
  const cafe = await registerCompany({
    companyName: 'Marlowe Street Coffee',
    industry: 'restaurant',
    userName: 'Ines Ferreira',
    email: 'ines@marlowestreet.test',
    password: DEMO_PASSWORD,
  })

  const cafeCtx: ActorContext = {
    userId: cafe.user.id,
    userName: cafe.user.name,
    companyId: cafe.company.id,
    role: 'owner',
  }

  await db.insert(financialAccounts).values({
    companyId: cafe.company.id,
    chartAccountId: (await accountByNumber(cafe.company.id, '1000'))!.id,
    name: 'Café Current Account',
    mask: '7712',
    kind: 'checking',
    providerAccountId: 'seed-marlowe-current',
  })

  // Monday. An ordinary day, counted exactly: food and drink across cash and
  // card, tips collected for the staff, and a card fee that does not touch
  // revenue.
  await importDay(cafeCtx, {
    businessDate: '2026-03-09',
    source: 'register',
    label: 'Monday, Z-report 1184',
    categories: [
      { name: 'Food', accountNumber: '4030', amountCents: 68_400 },
      { name: 'Drinks', accountNumber: '4040', amountCents: 51_600 },
    ],
    tenders: [
      { kind: 'cash', name: 'Cash', amountCents: 34_000 },
      { kind: 'card', name: 'Card', amountCents: 101_800, feeCents: 1_640 },
    ],
    taxCents: 8_400,
    tipsCents: 11_400,
    discountsCents: 4_000,
    countedCashCents: 44_000,
    floatCents: 10_000,
  })

  // Tuesday. The drawer is £8.50 light. Nothing about the day changes except
  // that the books now say so, in an account with a name, rather than the cash
  // figure being quietly written down to match.
  await importDay(cafeCtx, {
    businessDate: '2026-03-10',
    source: 'register',
    label: 'Tuesday, Z-report 1185',
    categories: [
      { name: 'Food', accountNumber: '4030', amountCents: 54_200 },
      { name: 'Drinks', accountNumber: '4040', amountCents: 43_800 },
    ],
    tenders: [
      { kind: 'cash', name: 'Cash', amountCents: 29_500 },
      { kind: 'card', name: 'Card', amountCents: 83_100, feeCents: 1_320 },
    ],
    taxCents: 6_800,
    tipsCents: 10_000,
    refundsCents: 2_200,
    countedCashCents: 38_650,
    floatCents: 10_000,
  })

  // Wednesday, from the delivery platform instead of the till. Same module,
  // same shape: a summary of somebody else's day, with their commission on it.
  // The commission is an expense of £42.30 and the sales are the full £282 —
  // not a deposit of £239.70 recorded as revenue, which is the mistake this
  // module exists to make impossible.
  await importDay(cafeCtx, {
    businessDate: '2026-03-11',
    source: 'marketplace',
    label: 'Delivery platform settlement',
    categories: [{ name: 'Delivery food', accountNumber: '4030', amountCents: 28_200 }],
    tenders: [{ kind: 'other', name: 'Platform payout', amountCents: 30_180, feeCents: 4_230 }],
    taxCents: 1_980,
  })

  // Somebody was paid their tips. Deliberately posted as an ordinary journal
  // entry and not by anything in this module: paying staff is payroll's job,
  // and the tips position has to be able to see money leave by a door it does
  // not control. That is what makes it a reconciliation rather than a restated
  // copy of its own figure.
  await postManualEntry(cafeCtx, {
    entryDate: '2026-03-12',
    memo: 'Tips paid out to floor staff for w/c 9 March',
    lines: [
      {
        chartAccountId: (await accountByNumber(cafe.company.id, '2310'))!.id,
        debitCents: 15_000,
      },
      { chartAccountId: (await accountByNumber(cafe.company.id, '1000'))!.id, creditCents: 15_000 },
    ],
  })

  const tips = await tipsPosition(cafeCtx)
  const cafeDays = await listDays(cafeCtx)
  const short = cafeDays.find((day) => (day.overShortCents ?? 0) < 0)

  console.log(
    `  Marlowe Street Coffee: ${cafeDays.length} days imported, one entry each. ` +
      `Tips collected ${formatCentsPlain(tips.collectedCents)}, paid out ` +
      `${formatCentsPlain(tips.paidOutCents)}, still owed ${formatCentsPlain(tips.ledgerCents)}. ` +
      (short
        ? `The till was ${formatCentsPlain(-short.overShortCents!)} short on ${short.businessDate} ` +
          'and the books say so.'
        : 'Every till counted exactly.'),
  )

  // --- Phase 29: a diary, a split, and money taken for a promise ------------
  //
  // A salon rather than a clinic, because the personal-care pack is the one
  // that names the contractor split and the gift card — the two things that
  // make this accounting rather than a calendar.
  const salon = await registerCompany({
    companyName: 'Fenwick Row Studio',
    industry: 'personal_care',
    userName: 'Delphine Achebe',
    email: 'delphine@fenwickrow.test',
    password: DEMO_PASSWORD,
  })

  const salonCtx: ActorContext = {
    userId: salon.user.id,
    userName: salon.user.name,
    companyId: salon.company.id,
    role: 'owner',
  }

  await db.insert(financialAccounts).values({
    companyId: salon.company.id,
    chartAccountId: (await accountByNumber(salon.company.id, '1000'))!.id,
    name: 'Studio Current Account',
    mask: '5540',
    kind: 'checking',
    providerAccountId: 'seed-fenwick-current',
  })

  // Two practitioners on different terms. Neither has a login, and that is the
  // usual case: a chair renter appears in the diary and earns a share without
  // ever being a user of this application.
  const sam = await addPractitioner(salonCtx, {
    name: 'Sam Okafor',
    commissionBp: 4_500,
    productCommissionBp: 1_000,
  })
  const rae = await addPractitioner(salonCtx, {
    name: 'Rae Lindqvist',
    commissionBp: 5_500,
    productCommissionBp: 1_000,
  })

  const at = (day: number, hour: number) => new Date(Date.UTC(2026, 3, day, hour, 0))

  // A card sold in March, weeks before anybody uses it. £100 taken, £0 earned.
  await sellGiftCard(salonCtx, {
    code: 'GC-1001',
    amountCents: 10_000,
    issuedOn: '2026-03-14',
  })

  // Wednesday. Four in the book with Sam, back to back — legal, because the
  // constraint uses a half-open range and 11:00 does not overlap 10:00–11:00.
  const delivered: string[] = []
  for (const [practitionerId, hour, price, retail] of [
    [sam.id, 10, 6_500, 0],
    [sam.id, 11, 4_000, 2_400],
    [rae.id, 10, 8_000, 0],
    [rae.id, 11, 5_500, 0],
  ] as const) {
    const appointment = await book(salonCtx, {
      practitionerId,
      startsAt: at(1, hour),
      endsAt: at(1, hour + 1),
      priceCents: price,
      productCents: retail,
    })
    delivered.push(appointment.id)
  }

  for (const id of delivered) {
    await completeAppointment(salonCtx, { appointmentId: id, completedOn: '2026-04-01' })
  }

  // The £100 card, produced at the desk against Sam's first client. £65 of it
  // is spent; £35 is still owed as a haircut somebody has already paid for.
  await redeemGiftCard(salonCtx, {
    code: 'GC-1001',
    appointmentId: delivered[0],
    redeemedOn: '2026-04-01',
  })

  // One who did not come, and one who called off. Deliberately different rows:
  // the cancelled hour is sellable again, the no-show hour was lost.
  const missed = await book(salonCtx, {
    practitionerId: sam.id,
    startsAt: at(2, 10),
    endsAt: at(2, 11),
    priceCents: 6_500,
  })
  const calledOff = await book(salonCtx, {
    practitionerId: rae.id,
    startsAt: at(2, 10),
    endsAt: at(2, 11),
    priceCents: 8_000,
  })
  await closeWithoutDelivery(salonCtx, { appointmentId: missed.id, status: 'no_show' })
  await closeWithoutDelivery(salonCtx, { appointmentId: calledOff.id, status: 'cancelled' })

  // Three still in the diary, so the forward book is a number on the screen
  // that is visibly not revenue.
  for (const [practitionerId, hour] of [
    [sam.id, 14],
    [rae.id, 14],
    [sam.id, 15],
  ] as const) {
    await book(salonCtx, {
      practitionerId,
      startsAt: at(3, hour),
      endsAt: at(3, hour + 1),
      priceCents: 7_000,
    })
  }

  // Sam is paid for the week. Again an ordinary journal entry and no part of
  // this module — 2320 has to be drawn on by something the appointments code
  // does not control, or the payout figure is checking itself.
  await postManualEntry(salonCtx, {
    entryDate: '2026-04-05',
    memo: 'Paid Sam Okafor for w/c 30 March',
    lines: [
      { chartAccountId: (await accountByNumber(salon.company.id, '2320'))!.id, debitCents: 5_000 },
      { chartAccountId: (await accountByNumber(salon.company.id, '1000'))!.id, creditCents: 5_000 },
    ],
  })

  // --- Phase 34: a till, opened, with a shift running on it ----------------
  //
  // Left open on purpose, so the demo lands on the thing worth seeing: a
  // drawer somebody is accountable for right now, with a figure to count
  // against. Closing it is the step in the checklist.
  await setModuleEnabled(salonCtx, 'cash_drawer', true)

  // Petty cash is funded from the bank before the till draws on it. Without
  // this the float comes out of an account with nothing in it, and the demo
  // shows a negative asset — honest double-entry describing a thing no shop
  // actually does.
  await postManualEntry(salonCtx, {
    entryDate: '2026-04-01',
    memo: 'Cash from the bank for the till float',
    lines: [
      { chartAccountId: (await accountByNumber(salon.company.id, '1050'))!.id, debitCents: 20_000 },
      { chartAccountId: (await accountByNumber(salon.company.id, '1000'))!.id, creditCents: 20_000 },
    ],
  })

  const frontCounter = await addDrawer(salonCtx, {
    name: 'Front counter',
    defaultFloatCents: 10_000,
  })
  await openShift(salonCtx, { drawerId: frontCounter.id })

  // A window cleaner, paid out of the till. This is why real drawers come up
  // short, and why the reason is kept rather than just the amount.
  await payOut(salonCtx, {
    shiftId: (await openShiftFor(salonCtx, frontCounter.id))!.id,
    reason: 'Window cleaner',
    amountCents: 1_500,
    chartAccountId: (await accountByNumber(salon.company.id, '6000'))!.id,
  })

  const owedToStaff = await payoutPosition(salonCtx)
  const cardsHeld = await giftCardPosition(salonCtx)
  const book29 = await diarySummary(salonCtx)
  const tills = await drawerPosition(salonCtx)

  console.log(
    `  Fenwick Row Studio: ${book29.completed} visits delivered for ` +
      `${formatCentsPlain(book29.deliveredCents)}, ${book29.booked} still in the diary worth ` +
      `${formatCentsPlain(book29.bookedCents)} — which is not revenue. Practitioners earned ` +
      `${formatCentsPlain(owedToStaff.earnedCents)}, of which ` +
      `${formatCentsPlain(owedToStaff.ledgerCents)} is still owed. Gift cards ` +
      `${formatCentsPlain(cardsHeld.outstandingCents)} against account 2590 at ` +
      `${formatCentsPlain(cardsHeld.ledgerCents)} — ${cardsHeld.agrees ? 'agrees' : 'DISAGREES'}. ` +
      `The front counter is open holding ${formatCentsPlain(tills.registerCents)} against ` +
      `account 1060 at ${formatCentsPlain(tills.ledgerCents)} — ` +
      `${tills.agrees ? 'agrees' : 'DISAGREES'}.`,
  )

  // --- Phase 30: the estimate nobody may bill past --------------------------
  //
  // A garage, and the tenth of ten industry modules. The automotive pack turns
  // on job costing, inventory and vehicles together — a repair order needs
  // parts off a shelf, so this company gets both.
  const shop = await registerCompany({
    companyName: 'Ashgrove Motors',
    industry: 'automotive',
    userName: 'Marek Dvořák',
    email: 'marek@ashgrovemotors.test',
    password: DEMO_PASSWORD,
  })

  const shopCtx: ActorContext = {
    userId: shop.user.id,
    userName: shop.user.name,
    companyId: shop.company.id,
    role: 'owner',
  }

  await db.insert(financialAccounts).values({
    companyId: shop.company.id,
    chartAccountId: (await accountByNumber(shop.company.id, '1000'))!.id,
    name: 'Workshop Current Account',
    mask: '8821',
    kind: 'checking',
    providerAccountId: 'seed-ashgrove-current',
  })

  const [shopCustomer] = await db
    .insert(customers)
    .values([
      { companyId: shop.company.id, name: 'Priya Raman' },
      { companyId: shop.company.id, name: 'Tomasz Lewandowski' },
    ])
    .returning()

  // A part on the shelf, bought at two prices so the cost of what is fitted
  // comes from the lots rather than from a price list.
  const shopParts = await accountByNumber(shop.company.id, '1480')
  const shopPartsRevenue = await accountByNumber(shop.company.id, '4610')
  const shopPayable = await accountByNumber(shop.company.id, '2000')

  const [brakePads] = await db
    .insert(serviceItems)
    .values({
      companyId: shop.company.id,
      code: 'PADS-F',
      name: 'Brake pads, front',
      unit: 'set',
      unitPriceCents: 8_000,
      unitCostCents: 3_000,
      isInventoried: true,
      chartAccountId: shopPartsRevenue!.id,
      inventoryAccountId: shopParts!.id,
    })
    .returning()

  await receiveStock(shopCtx, {
    itemId: brakePads.id,
    quantityMilli: 6_000,
    unitCostCents: 3_000,
    receivedOn: '2026-04-20',
    creditAccountId: shopPayable!.id,
  })

  const golf = await addVehicle(shopCtx, {
    customerId: shopCustomer.id,
    registration: 'YK21 ZRT',
    vin: 'WVWZZZAUZMW123456',
    make: 'Volkswagen',
    model: 'Golf',
    year: 2021,
    odometerMiles: 48_000,
  })

  // The job that ran over. Booked in for brakes at £180 agreed at the counter;
  // the technician finds a seized caliper, and the bill would come to £355.
  const overrun = await openRepairOrder(shopCtx, {
    vehicleId: golf.id,
    openedOn: '2026-05-04',
    complaint: 'Grinding from the front when braking',
    odometerIn: 48_260,
  })

  await authorise(shopCtx, {
    repairOrderId: overrun.id,
    amountCents: 18_000,
    channel: 'in_person',
    approvedBy: 'Priya Raman',
    notes: 'Signed the estimate at the counter',
  })

  await addLine(shopCtx, {
    repairOrderId: overrun.id,
    kind: 'labour',
    description: 'Replace front pads',
    quantityMilli: 1_500,
    unitPriceCents: 9_000,
  })
  await addLine(shopCtx, {
    repairOrderId: overrun.id,
    kind: 'part',
    description: 'Brake pads, front',
    itemId: brakePads.id,
    quantityMilli: 1_000,
    unitPriceCents: 8_000,
  })
  // The extra work nobody has agreed to yet: a seized caliper and the discs
  // sent out to be skimmed. £355 against £180 authorised.
  await addLine(shopCtx, {
    repairOrderId: overrun.id,
    kind: 'labour',
    description: 'Free off seized nearside caliper',
    quantityMilli: 1_000,
    unitPriceCents: 9_000,
  })
  await addLine(shopCtx, {
    repairOrderId: overrun.id,
    kind: 'sublet',
    description: 'Discs skimmed — Bellway Machining',
    unitPriceCents: 6_000,
    subletCostCents: 4_000,
  })

  // The phone call. £175 more, and now it can be billed.
  await authorise(shopCtx, {
    // £365 of work against £180 already agreed. The number read down the phone
    // is the *extra*, which is what the customer is being asked to approve.
    repairOrderId: overrun.id,
    amountCents: 18_500,
    channel: 'phone',
    approvedBy: 'Priya Raman',
    notes: 'Rang at 14:20, explained the caliper and the skim',
  })

  const billed = await completeRepairOrder(shopCtx, {
    repairOrderId: overrun.id,
    completedOn: '2026-05-06',
    odometerOut: 48_272,
  })

  // A second order left open and over its authority, so the board has
  // something red on it and the demo has something to ring about.
  const awaitingCall = await openRepairOrder(shopCtx, {
    vehicleId: golf.id,
    openedOn: '2026-05-18',
    complaint: 'Service and MOT',
    odometerIn: 49_100,
  })
  await authorise(shopCtx, {
    repairOrderId: awaitingCall.id,
    amountCents: 12_000,
    channel: 'phone',
    approvedBy: 'Priya Raman',
  })
  await addLine(shopCtx, {
    repairOrderId: awaitingCall.id,
    kind: 'labour',
    description: 'Service',
    quantityMilli: 1_000,
    unitPriceCents: 12_000,
  })
  await addLine(shopCtx, {
    repairOrderId: awaitingCall.id,
    kind: 'labour',
    description: 'Rear brakes, found on inspection',
    quantityMilli: 1_000,
    unitPriceCents: 8_500,
  })

  const shopBoard = await openOrders(shopCtx)
  const shopMade = await shopMix(shopCtx)
  const approvals = await authorisationsAgree(shopCtx)
  const stuck = shopBoard.filter((row) => !row.withinAuthority)

  console.log(
    `  Ashgrove Motors: ${formatCentsPlain(billed.totals.totalCents)} billed on ${overrun.number} ` +
      `against ${formatCentsPlain(18_000 + 18_500)} authorised in two goes — ` +
      `${formatCentsPlain(shopMade.labourCents)} labour, ${formatCentsPlain(shopMade.partsCents)} parts, ` +
      `${formatCentsPlain(shopMade.subletCents)} sublet. ${stuck.length} order waiting on a phone call. ` +
      `Approvals ${approvals.agrees ? 'agree' : 'DISAGREE'} with what the orders claim.`,
  )

  // --- Phase 19: an invitation that carries no password ---------------------
  //
  // Left pending on purpose, so /settings/access has something in its "waiting
  // to be accepted" list and the link below can be followed end to end. Nobody
  // has typed a password for Priya, and nobody will.
  await inviteToCompany(ctx, {
    email: 'priya@example.test',
    name: 'Priya Raman',
    role: 'bookkeeper',
  })

  // A second invitation, to somebody the CRM already knows: Alex Whitfield is
  // the client's project manager on the Summit deal, given read-only access to
  // watch the job rather than ring for a progress figure. It is here to
  // demonstrate the Phase 19 → Phase 22 join — this letter lands on Summit
  // Property Group's timeline on its own, beside the calls somebody typed,
  // because the address belongs to a contact.
  //
  // Priya's above does not, and correctly: `priya@example.test` is a staff
  // address the CRM has never seen. A letter to an unknown address is recorded
  // as mail and filed against nobody.
  await inviteToCompany(ctx, {
    email: 'alex@summitproperty.test',
    name: 'Alex Whitfield',
    role: 'readonly',
  })

  // The link is printed because it cannot be recovered later: the token is
  // hashed at rest, so this is the only moment anybody can read it. No reset is
  // seeded — following one would change the password printed at the end of this
  // script. Use /forgot and read the link from the dev server's terminal, which
  // is what the in-memory provider logs it for.
  const outbox = mockTransactionalProvider()
  const invitation =
    outbox.lastTo('priya@example.test')?.text.match(/https?:\/\/\S+/)?.[0] ?? '(nothing sent)'

  console.log(
    `  Transactional mail: ${outbox.sent.length} letters in the in-memory outbox, ` +
      'none carrying an unsubscribe link — a password reset is not marketing.',
  )
  console.log(`  Invitation waiting for Priya (no password was set for her):\n    ${invitation}`)

  // Reported here rather than where Phase 12 built it, because Phase 16 buys
  // two vehicles further down and the investing section was printed as $0.00
  // while the finished books showed six figures of it. A summary that was true
  // when it ran and false when it is read is worse than no summary.
  const flow = await cashFlowStatement(ctx, {
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  })
  console.log(
    `  Cash flow 2026: operating ${formatCentsPlain(flow.operating.totalCents)}, ` +
      `investing ${formatCentsPlain(flow.investing.totalCents)}, ` +
      `financing ${formatCentsPlain(flow.financing.totalCents)} — ` +
      `${flow.reconciles ? 'reconciles' : 'DOES NOT RECONCILE'} to the cash accounts.`,
  )

  // --- Phase 37: two arrangements that bill on their own -------------------
  //
  // One automatic and one that waits for a person, because the difference is
  // the phase's most useful distinction and it is invisible with only one.
  // Started in the past so the demo lands on a schedule with history rather
  // than a promise nobody has seen work.
  {
    const meridian = await createCustomer(ctx, {
      name: 'Meridian Facilities Ltd',
      email: 'accounts@meridian-facilities.test',
    })

    const serviceRevenue = await accountByNumber(company.id, '4100')

    if (serviceRevenue) {
      const retainer = await createSchedule(ctx, {
        customerId: meridian.id,
        name: 'Meridian — monthly maintenance retainer',
        memo: 'Retainer under the 2026 maintenance agreement',
        cadence: 'monthly',
        dayOfMonth: 1,
        paymentTermsDays: 14,
        autoRaise: true,
        startsOn: '2026-05-01',
        lines: [
          {
            chartAccountId: serviceRevenue.id,
            description: 'Monthly maintenance retainer',
            unitPriceCents: 185_000,
          },
        ],
      })

      // A second arrangement whose amount somebody checks first, so the
      // "waiting for somebody" work list has something real in it.
      await createSchedule(ctx, {
        customerId: harborview.id,
        name: 'Harborview — quarterly site review',
        cadence: 'quarterly',
        dayOfMonth: 1,
        autoRaise: false,
        startsOn: '2026-04-01',
        lines: [
          {
            chartAccountId: serviceRevenue.id,
            description: 'Quarterly site review and report',
            unitPriceCents: 420_000,
          },
        ],
      })

      const billed = await runDueSchedules(ctx, '2026-08-18')
      const raised = billed.filter((row) => row.raised)
      const waiting = billed.filter((row) => row.skipped?.includes('Waiting'))
      const ahead = await billingForecast(ctx, { from: '2026-08-18', through: '2026-11-30' })

      console.log(
        `  Recurring billing: ${raised.length} invoice${raised.length === 1 ? '' : 's'} raised ` +
          `from schedules for ${formatCentsPlain(
            raised.reduce((sum, row) => sum + row.totalCents, 0),
          )}, ${waiting.length} period${waiting.length === 1 ? '' : 's'} waiting for somebody. ` +
          `${formatCentsPlain(ahead.totalCents)} is forecast to the end of November — owed by ` +
          'nobody, and posted nowhere.',
      )

      void retainer
    }
  }

  // --- Phase 36: a plan, and a year going against it -----------------------
  //
  // Deliberately a plan the business is *missing on revenue and beating on
  // costs*, because that is the case the variance report exists for: both
  // differences are negative numbers and only one of them is bad news.
  //
  // And one account left out of the plan entirely, so the "not budgeted at
  // all" section has something in it — an expense nobody planned for is the
  // most useful thing this report surfaces and the easiest to bury.
  {
    const budget = await createBudget(ctx, {
      name: '2026 Approved',
      fiscalYear: 2026,
      notes: 'Agreed with the bank in November. Revised plan lives beside this one, not over it.',
    })

    const plan: Array<[string, number]> = [
      ['4000', 60_000_00],
      ['4200', 240_000_00],
      ['6400', 36_000_00],
      ['6000', 24_000_00],
    ]

    for (const [number, annualCents] of plan) {
      const account = await accountByNumber(company.id, number)
      if (account) {
        await setAccountBudget(ctx, {
          budgetId: budget.id,
          chartAccountId: account.id,
          annualCents,
        })
      }
    }

    await approveBudget(ctx, budget.id)

    // A second, unapproved revision — so the picker shows what "several plans,
    // one of them agreed" looks like.
    await createBudget(ctx, {
      name: '2026 Revised — if the Bremen work lands',
      fiscalYear: 2026,
      notes: 'Not agreed. Kept alongside rather than over the top of the approved one.',
    })

    const against = await budgetVsActual(ctx, {
      fiscalYear: 2026,
      startDate: '2026-01-01',
      endDate: '2026-07-31',
    })

    console.log(
      `  2026 Approved: seven months in, revenue ${formatCentsPlain(
        against.revenue.actualCents,
      )} against a plan of ${formatCentsPlain(against.revenue.budgetCents)} — ` +
        `${against.revenue.favourable ? 'favourable' : 'adverse'}; operating expenses ` +
        `${formatCentsPlain(against.operatingExpenses.actualCents)} against ` +
        `${formatCentsPlain(against.operatingExpenses.budgetCents)} — ` +
        `${against.operatingExpenses.favourable ? 'favourable' : 'adverse'}. ` +
        `Nobody planned for ${formatCentsPlain(against.unbudgetedCostCents)} of cost or ` +
        `${formatCentsPlain(against.unbudgetedIncomeCents)} of income — net ` +
        `${formatCentsPlain(against.unbudgetedNetCents)} on the result.`,
    )
  }

  // Cash versus accrual on the demo's own books, so the difference is a
  // number rather than an explanation.
  const range = { startDate: '2026-01-01', endDate: '2026-12-31' }
  const accrualPl = await profitAndLoss(ctx, { ...range, basis: 'accrual' })
  const cashPl = await profitAndLoss(ctx, { ...range, basis: 'cash' })
  console.log(
    `  Revenue 2026: ${formatCentsPlain(accrualPl.revenue.totalCents)} accrual, ` +
      `${formatCentsPlain(cashPl.revenue.totalCents)} cash — the difference is what has been invoiced and not paid.`,
  )

  // --- Phase 43: invoices that have actually been sent ---------------------
  //
  // Phase 42 built sending and the seed never sent anything, so every screen
  // that reads "has this customer been asked for the money" showed *no* for
  // every invoice on the demo — including the chase preview, whose entire
  // content was "never sent to the customer", eleven times.
  //
  // Chasing itself is left **off**. That is the product's default and the
  // demo should show the default; what it now shows is a populated preview
  // under a switch nobody has touched, which is the decision a business
  // actually faces.
  console.log('Sending the invoices that were raised…')
  {
    const openInvoices = await listInvoices(ctx)
    // The ones a business would have emailed: overdue, still owed, and to a
    // customer with an address. Backdated to the issue date, because an
    // invoice sent today is not one anybody could be chased about yet.
    const toSend = openInvoices
      .filter((invoice) => invoice.status === 'open' && invoice.balanceCents > 0)
      .filter((invoice) => invoice.dueDate < '2026-07-01')
      .slice(0, 6)

    let sent = 0
    for (const invoice of toSend) {
      try {
        await sendInvoice(ctx, invoice.id)
        await db
          .update(invoicesTable)
          .set({ sentAt: new Date(`${invoice.issueDate}T09:00:00Z`) })
          .where(eq(invoicesTable.id, invoice.id))
        sent++
      } catch {
        // No email address on the customer. Left unsent on purpose — the
        // chase preview says so by name, which is the more useful demo.
      }
    }

    console.log(
      `  ${sent} sent, and chasing left switched off. /settings/chasing shows what would go ` +
        `out if it were on, and why the rest would not.`,
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
  console.log('  /m                    the mobile app — install it, then turn off your wifi')
  console.log('  /payroll              payroll runs and what each one cost')
  console.log('  /payroll/run          the run wizard — it shows the entry before it posts')
  console.log('  /payroll/liabilities  what is owed to agencies, and remitting it')
  console.log('  /payroll/sales-tax    the return, per jurisdiction')
  console.log('  /payroll/contractors  who is reportable, and what is stopping it')
  console.log('  /payroll/workpapers   the pack, and the filing it refuses to prepare')
  console.log('  /settings/operations  the queue, the schedules, and what failed')
  console.log('  /accounting/reports   switch the basis — cash and accrual, same books')
  console.log('  /accounting/receivables  credits, write-offs, and statements')
  console.log('  /accounting/periods   recurring entries and the year-end close')
  console.log('  /accounting/deposits  receipts waiting to be banked, and the slip')
  console.log('  /settings/security    two-factor, sessions, sign-in history, and the export')
  console.log('  /inventory            stock on hand, receiving, and counts')
  console.log('  /time                 timesheets, unbilled work, and billing it')
  console.log('  /accounting/dimensions  profit and loss by location, and the Unassigned column')
  console.log('  /accounting/assets    the register, and whether it agrees with the ledger')
  console.log(
    '  /accounting/currencies  two euro invoices — one paid at a different rate, one still open',
  )
  console.log(
    '  /accounting/budgets   the plan, and which of two negative numbers is the bad news',
  )
  console.log(
    '  /accounting/billing   two arrangements that bill on their own, and what is coming',
  )
  console.log('  /settings/import      bring an existing business’s books in — the README has a sample')
  console.log('  /settings/access      who can open these books, and one click to stop them')
  console.log('  /practice             sign in as robin@hartleyco.test — two clients, one at a time')
  console.log(
    '  /funds                sign in as nadia@riverside.test — what money was given for, and when it stops being restricted',
  )
  console.log(
    '  /takings              sign in as ines@marlowestreet.test — three days of a café, one entry each',
  )
  console.log(
    '  /drawers              sign in as delphine@fenwickrow.test — a till open right now, waiting to be counted',
  )
  console.log(
    '  /appointments         sign in as delphine@fenwickrow.test — a diary, the splits, and a gift card',
  )
  console.log(
    '  /shop                 sign in as marek@ashgrovemotors.test — a job that ran over its estimate',
  )
  console.log('  /accounting/documents  every file, what it hangs on, and the open questions')
  console.log('  /crm/work             follow-ups: late, due, and the ones nobody claimed')
  console.log('  /crm/organizations    open a client’s history — calls, letters, and what is owed')
  console.log('  /forgot               ask for a reset; the link is printed in this terminal')
  console.log('  /invite?token=…       Priya’s invitation, printed above — she picks her own password')
  console.log('')
  console.log('Then, in a second terminal:')
  console.log('  npm run worker        the thing that actually drains the queue')

  process.exit(0)
}

main().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
