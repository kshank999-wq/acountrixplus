import type { industryEnum } from '@/db/schema'
import type { AccountTemplate } from './standard'

export type Industry = (typeof industryEnum.enumValues)[number]

/**
 * Optional feature modules an industry can switch on. The core ledger is
 * identical either way — these gate workspaces and dashboard cards, they do
 * not fork the accounting model (spec §23).
 */
export const INDUSTRY_MODULES = [
  'job_costing',
  'inventory',
  'projects',
  'time_billing',
  'pos_import',
  'properties',
  'funds',
  'appointments',
  'vehicles',
  'manufacturing',
] as const

export type IndustryModule = (typeof INDUSTRY_MODULES)[number]

export type IndustryPack = {
  key: Industry
  label: string
  /** Accounts added on top of STANDARD_ACCOUNTS. */
  accounts: AccountTemplate[]
  /** Optional workspaces enabled for this industry. */
  modules: IndustryModule[]
  /**
   * Vocabulary overrides so the UI speaks the trade's language without
   * changing any underlying record type.
   */
  terminology?: Partial<Record<'customer' | 'job' | 'invoice', string>>
}

/**
 * Industry packs from the spec §5 table.
 *
 * Each pack only *adds* accounts within the standard numbering blocks, so a
 * construction company and a retailer still produce comparable financial
 * statements.
 */
export const INDUSTRY_PACKS: Record<Industry, IndustryPack> = {
  professional_services: {
    key: 'professional_services',
    label: 'Professional Services',
    modules: ['projects', 'time_billing'],
    terminology: { customer: 'Client', job: 'Engagement' },
    accounts: [
      { number: '1150', name: 'Unbilled Work in Progress', type: 'asset', subtype: 'unbilled_revenue' },
      { number: '2550', name: 'Client Retainers Held', type: 'liability', subtype: 'deferred_revenue' },
      { number: '4110', name: 'Consulting Revenue', type: 'revenue' },
      { number: '4120', name: 'Retainer Revenue', type: 'revenue' },
      { number: '4130', name: 'Reimbursable Expense Revenue', type: 'revenue' },
      { number: '5250', name: 'Contract Labor', type: 'cogs' },
      { number: '6260', name: 'Continuing Education', type: 'expense' },
    ],
  },

  construction: {
    key: 'construction',
    label: 'Construction and Trades',
    modules: ['job_costing', 'projects'],
    terminology: { customer: 'Customer', job: 'Job' },
    accounts: [
      { number: '1160', name: 'Costs in Excess of Billings', type: 'asset', subtype: 'unbilled_revenue' },
      { number: '1170', name: 'Retainage Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { number: '2560', name: 'Billings in Excess of Costs', type: 'liability', subtype: 'deferred_revenue' },
      { number: '2570', name: 'Retainage Payable', type: 'liability' },
      { number: '4200', name: 'Contract Revenue', type: 'revenue' },
      { number: '4210', name: 'Change Order Revenue', type: 'revenue' },
      { number: '5110', name: 'Job Materials', type: 'cogs' },
      { number: '5120', name: 'Job Labor', type: 'cogs' },
      { number: '5130', name: 'Subcontractors', type: 'cogs' },
      { number: '5140', name: 'Equipment Rental', type: 'cogs' },
      { number: '5150', name: 'Permits and Fees', type: 'cogs' },
      { number: '6210', name: 'General Liability Insurance', type: 'expense' },
      { number: '6810', name: 'Tools and Small Equipment', type: 'expense' },
    ],
  },

  retail: {
    key: 'retail',
    label: 'Retail',
    modules: ['inventory'],
    accounts: [
      { number: '1410', name: 'Merchandise Inventory', type: 'asset', subtype: 'inventory' },
      { number: '4010', name: 'In-Store Sales', type: 'revenue' },
      { number: '4020', name: 'Online Sales', type: 'revenue' },
      { number: '4910', name: 'Returns and Allowances', type: 'revenue' },
      { number: '5010', name: 'Purchases', type: 'cogs' },
      { number: '5020', name: 'Inventory Shrinkage', type: 'cogs' },
      { number: '6410', name: 'Store Rent', type: 'expense' },
    ],
  },

  restaurant: {
    key: 'restaurant',
    label: 'Restaurant and Food Service',
    modules: ['inventory', 'pos_import'],
    accounts: [
      { number: '1420', name: 'Food Inventory', type: 'asset', subtype: 'inventory' },
      { number: '1430', name: 'Beverage Inventory', type: 'asset', subtype: 'inventory' },
      { number: '2310', name: 'Tips Payable', type: 'liability', subtype: 'payroll' },
      { number: '4030', name: 'Food Sales', type: 'revenue' },
      { number: '4040', name: 'Beverage Sales', type: 'revenue' },
      { number: '4050', name: 'Catering Revenue', type: 'revenue' },
      { number: '5030', name: 'Food Cost', type: 'cogs' },
      { number: '5040', name: 'Beverage Cost', type: 'cogs' },
      { number: '5050', name: 'Paper and Packaging', type: 'cogs' },
      { number: '6460', name: 'Kitchen Equipment Maintenance', type: 'expense' },
    ],
  },

  manufacturing: {
    key: 'manufacturing',
    label: 'Manufacturing',
    modules: ['inventory', 'manufacturing', 'job_costing'],
    accounts: [
      { number: '1440', name: 'Raw Materials Inventory', type: 'asset', subtype: 'inventory' },
      { number: '1450', name: 'Work in Process Inventory', type: 'asset', subtype: 'inventory' },
      { number: '1460', name: 'Finished Goods Inventory', type: 'asset', subtype: 'inventory' },
      { number: '4060', name: 'Product Sales', type: 'revenue' },
      { number: '5060', name: 'Direct Materials', type: 'cogs' },
      { number: '5070', name: 'Direct Labor', type: 'cogs' },
      { number: '5080', name: 'Manufacturing Overhead', type: 'cogs' },
      { number: '6470', name: 'Factory Maintenance', type: 'expense' },
    ],
  },

  real_estate: {
    key: 'real_estate',
    label: 'Real Estate and Property',
    modules: ['properties'],
    terminology: { customer: 'Tenant' },
    accounts: [
      { number: '1520', name: 'Buildings', type: 'asset', subtype: 'fixed_asset' },
      { number: '1530', name: 'Land', type: 'asset', subtype: 'fixed_asset' },
      { number: '2580', name: 'Tenant Security Deposits', type: 'liability' },
      { number: '4300', name: 'Rental Income', type: 'revenue' },
      { number: '4310', name: 'CAM Reimbursements', type: 'revenue' },
      { number: '4320', name: 'Late Fee Income', type: 'revenue' },
      { number: '6420', name: 'Property Management Fees', type: 'expense' },
      { number: '6480', name: 'Property Repairs', type: 'expense' },
      { number: '6610', name: 'Property Taxes', type: 'expense' },
    ],
  },

  creative: {
    key: 'creative',
    label: 'Creative and Media',
    modules: ['projects', 'time_billing'],
    terminology: { job: 'Production' },
    accounts: [
      { number: '4140', name: 'Production Revenue', type: 'revenue' },
      { number: '4150', name: 'Licensing and Royalties', type: 'revenue' },
      { number: '5260', name: 'Freelancers and Contractors', type: 'cogs' },
      { number: '5270', name: 'Stock Assets and Licensing', type: 'cogs' },
      { number: '5280', name: 'Location and Studio Costs', type: 'cogs' },
      { number: '6110', name: 'Creative Software Subscriptions', type: 'expense' },
    ],
  },

  healthcare: {
    key: 'healthcare',
    label: 'Healthcare and Practice',
    modules: ['appointments'],
    terminology: { customer: 'Patient' },
    accounts: [
      { number: '1180', name: 'Insurance Receivable', type: 'asset', subtype: 'accounts_receivable' },
      { number: '4400', name: 'Patient Service Revenue', type: 'revenue' },
      { number: '4410', name: 'Insurance Reimbursements', type: 'revenue' },
      { number: '4920', name: 'Contractual Adjustments', type: 'revenue' },
      { number: '5290', name: 'Medical Supplies', type: 'cogs' },
      { number: '6220', name: 'Malpractice Insurance', type: 'expense' },
      { number: '6620', name: 'Licensing and Credentialing', type: 'expense' },
    ],
  },

  nonprofit: {
    key: 'nonprofit',
    label: 'Nonprofit',
    modules: ['funds', 'projects'],
    terminology: { customer: 'Donor' },
    accounts: [
      { number: '3300', name: 'Net Assets Without Donor Restrictions', type: 'equity' },
      { number: '3400', name: 'Net Assets With Donor Restrictions', type: 'equity' },
      { number: '1180', name: 'Pledges Receivable', type: 'asset' },
      { number: '4500', name: 'Contributions and Donations', type: 'revenue' },
      { number: '4510', name: 'Grant Revenue', type: 'revenue' },
      // The pair that moves money between the two columns of the statement of
      // activities. They sum to zero on every release, which is the whole
      // reason there are two of them — see INDUSTRY_ACCOUNTS.
      { number: '4590', name: 'Net Assets Released from Restriction', type: 'revenue' },
      { number: '4595', name: 'Net Assets Released — Unrestricted', type: 'revenue' },
      { number: '4520', name: 'Fundraising Event Revenue', type: 'revenue' },
      { number: '4530', name: 'Membership Dues', type: 'revenue' },
      { number: '6010', name: 'Fundraising Expenses', type: 'expense' },
      { number: '6020', name: 'Program Expenses', type: 'expense' },
      { number: '6030', name: 'Management and General', type: 'expense' },
    ],
  },

  ecommerce: {
    key: 'ecommerce',
    label: 'E-commerce',
    modules: ['inventory'],
    accounts: [
      { number: '1470', name: 'Inventory in Transit', type: 'asset', subtype: 'inventory' },
      { number: '1210', name: 'Payment Processor Clearing', type: 'asset', subtype: 'undeposited_funds' },
      { number: '4070', name: 'Marketplace Sales', type: 'revenue' },
      { number: '4080', name: 'Direct Website Sales', type: 'revenue' },
      { number: '4930', name: 'Returns and Refunds', type: 'revenue' },
      { number: '5310', name: 'Fulfillment and Shipping', type: 'cogs' },
      { number: '6860', name: 'Marketplace and Platform Fees', type: 'expense' },
      { number: '6040', name: 'Digital Advertising', type: 'expense' },
    ],
  },

  automotive: {
    key: 'automotive',
    label: 'Automotive and Repair',
    modules: ['job_costing', 'vehicles', 'inventory'],
    terminology: { job: 'Repair Order' },
    accounts: [
      { number: '1480', name: 'Parts Inventory', type: 'asset', subtype: 'inventory' },
      { number: '4600', name: 'Labor Revenue', type: 'revenue' },
      { number: '4610', name: 'Parts Revenue', type: 'revenue' },
      { number: '5160', name: 'Parts Cost', type: 'cogs' },
      { number: '5170', name: 'Shop Supplies', type: 'cogs' },
      { number: '5180', name: 'Sublet Repairs', type: 'cogs' },
      { number: '6490', name: 'Shop Equipment Maintenance', type: 'expense' },
      { number: '6630', name: 'Hazardous Waste Disposal', type: 'expense' },
    ],
  },

  personal_care: {
    key: 'personal_care',
    label: 'Personal Care and Appointment Services',
    modules: ['appointments', 'inventory'],
    terminology: { customer: 'Client' },
    accounts: [
      { number: '1490', name: 'Retail Product Inventory', type: 'asset', subtype: 'inventory' },
      { number: '2320', name: 'Contractor Payouts Payable', type: 'liability', subtype: 'payroll' },
      { number: '4700', name: 'Service Revenue - Appointments', type: 'revenue' },
      { number: '4710', name: 'Retail Product Sales', type: 'revenue' },
      { number: '4720', name: 'Gift Card Redemptions', type: 'revenue' },
      { number: '2590', name: 'Gift Cards Outstanding', type: 'liability', subtype: 'deferred_revenue' },
      { number: '5210', name: 'Service Supplies', type: 'cogs' },
      { number: '5220', name: 'Booth Rent and Staff Splits', type: 'cogs' },
    ],
  },

  wholesale: {
    key: 'wholesale',
    label: 'Wholesale and Distribution',
    modules: ['inventory'],
    accounts: [
      { number: '1495', name: 'Warehouse Inventory', type: 'asset', subtype: 'inventory' },
      { number: '4090', name: 'Wholesale Sales', type: 'revenue' },
      { number: '4940', name: 'Volume Discounts', type: 'revenue' },
      { number: '5090', name: 'Product Purchases', type: 'cogs' },
      { number: '5320', name: 'Inbound Freight', type: 'cogs' },
      { number: '6430', name: 'Warehouse Rent', type: 'expense' },
      { number: '6820', name: 'Delivery Vehicle Costs', type: 'expense' },
    ],
  },

  general: {
    key: 'general',
    label: 'General or Other',
    modules: [],
    accounts: [],
  },
}

export function industryPack(industry: Industry): IndustryPack {
  return INDUSTRY_PACKS[industry] ?? INDUSTRY_PACKS.general
}

/** Industry choices for the onboarding selector. */
export function industryOptions(): Array<{ key: Industry; label: string }> {
  return Object.values(INDUSTRY_PACKS).map((pack) => ({ key: pack.key, label: pack.label }))
}
