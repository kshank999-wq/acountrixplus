import { INDUSTRY_ACCOUNTS, SYSTEM_ACCOUNTS } from './standard'
import { scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * The accounts something else maintains, and what a person may not post at
 * (spec §13, §14, Phase 211).
 *
 * ## The two lists that answered one question differently
 *
 * A control account is the ledger's one-line summary of a subledger. Its
 * balance is *by definition* the sum of the things behind it, which is why
 * nineteen integrity checks exist and why fourteen of them compare a subledger
 * against one named ledger account.
 *
 * Two places in this codebase already knew that and each wrote the class down
 * for itself:
 *
 *  - **`documentLineAccounts`** held back four accounts — `1100`, `2000`,
 *    `1200`, `1510` — in a bare array, on the stated rule that *"coding a line
 *    to one silently breaks an invariant something else is checking"*.
 *  - **`receipt-credit.ts`'s `CONTROL_ACCOUNTS`** held back two — `1100` and
 *    `2000` — under the heading *"the accounts whose balance must equal the
 *    documents behind them"*, and argued at length for the class being *"a
 *    single, statable class"*.
 *
 * Two answers to one question is the defect this project keeps finding, and
 * here it cost three findings: measured against `FALSIFIERS` — the register
 * that already records, per check, *"post a manual journal entry against
 * `<account>`"* as the one act that breaks it — **three of those accounts could
 * be reached from the bill composer's account dropdown**, needing no journal
 * screen and no accountant.
 *
 * ## What the measurement was
 *
 * Every account `documentLineAccounts` offers on a bill line, coded one at a
 * time onto a $1,000 bill, with all nineteen checks run after each:
 *
 * ```
 *   1250 Payments in Transit   ->  payments.in_transit   fault   0 vs 100000
 *   1400 Inventory             ->  inventory.lots        fault   0 vs 100000
 *   1450 Work in Process       ->  manufacturing.wip     fault   0 vs 100000
 *   1500 Fixed Assets          ->  assets.register       fault   0 vs 4000000
 * ```
 *
 * The invoice side broke nothing: it offers revenue only, and every clearing
 * account in this chart is a liability.
 *
 * ## Why `1500` is offered and the other three are not
 *
 * The symptom is identical and the difference is whether the application has a
 * way back. Measured:
 *
 * ```
 *   bill a truck to 1500           assets.register   disagrees   0 / 4000000
 *   register the asset             assets.register   agrees      4000000 / 4000000
 *
 *   bill timber to 1400            inventory.lots    disagrees   0 / 1000000
 *   receive the same goods         inventory.lots    disagrees   1000000 / 2000000
 * ```
 *
 * A bill line **is** the intended way to capitalise an asset —
 * `RegisterAssetInput` says so: *"left unset for the normal case, where a
 * supplier bill already coded the cost to Fixed Assets"* — so the fault is a
 * to-do with one action behind it, and `assets.register`'s own `meaning`
 * names it: *"an asset was capitalised without being registered"*.
 *
 * Stock has no such adoption step, because `receiveStock` posts the debit
 * itself. Doing the right thing afterwards **doubles** the difference. The only
 * way back is a manual journal entry — which is to say, the act the falsifier
 * register names as the thing that breaks the check.
 *
 * ## What each account is protected by, which is the point of writing it down
 *
 * Of the eighteen accounts a check or a composer rule has an opinion about:
 *
 * ```
 *   by this register's own list      4   1100 2000 1200 1510
 *   by the cash-and-bank subtype     2   1000 (every bank account) 1060
 *   by the liability type filter     8   2050 2310 2320 2500 2520 2550 2580 2590
 *   by nothing                       3   1250 1400 1450
 *   offered on purpose               1   1500
 * ```
 *
 * Eight were safe only because a bill line may not name a liability — a filter
 * written to decide what a *cost* is, not to protect a clearing account. It
 * holds today and nothing records that eight checks depend on it, so adding
 * `liability` to the bill side's `wanted` types for one honest reason (a bill
 * for a loan repayment) would reach eight faults at once. That is what this
 * register is for: the protection is stated rather than incidental.
 *
 * ## Why entries disagree between the two acts
 *
 * A single flag would be wrong. `2050` is exactly what a goods receipt must
 * credit and exactly what a person must never type; `1450` is what a finished
 * manufacturing run credits and what no bill line should name. So each entry
 * answers per act, and the disagreement is written down instead of living in
 * two files.
 */

/**
 * A posting that *is* the thing maintaining an account, named so that an entry
 * point allowed to post at one can say which authority it is using.
 *
 * ## Two members, and the second arrived the hard way
 *
 * This said *"one member — a second would mean a second entry point had been
 * given the same licence, which is worth having to write down"*, and the suite
 * produced one before the phase was over.
 *
 * `billProposalStage`, and the conversion that raises a won proposal's deposit,
 * both raise an **invoice** credited to the retainer account — `2550`, or
 * `2500 Unearned Revenue` where the pack installed no `2550` — because money
 * taken before the work is not revenue, and crediting revenue for it would
 * recognise income nobody has earned. That is `billReceipts`' shape exactly: a
 * module deriving the amount from a schedule it owns, not a person typing a
 * liability account into a line.
 *
 * **How it was found is the part worth keeping.** This phase's measurement
 * asked what the *pickers* offer — the bill side offers no liability and the
 * invoice side offers revenue only — and reported the invoice side clean. Nine
 * modules raise documents with accounts they choose themselves, and the picker
 * is involved in none of them. A guard measured against the dropdown it backs
 * is measured against the wrong thing, which is also the argument for the
 * guard existing: if the composer were the only writer, the picker would have
 * been enough.
 */
export type MaintainingAct = 'receipt_clearance' | 'deposit_billing'

/** One account, what moves it, and which everyday act may name it. */
export type MaintainedAccount = {
  number: string
  name: string
  /** What moves it, in the terms of the books rather than the code. */
  maintainedBy: string
  /**
   * The integrity check that watches it, by register key.
   *
   * `null` is a real answer and appears once: `1200` is held back by the
   * composer and watched by nothing, which is a gap in the check register
   * rather than in this one (Phase 139 — a register that says what it does
   * not cover).
   */
  watchedBy: string | null
  /** Whether a line a person types on an invoice or a bill may name it. */
  documentLine: boolean
  /** Whether the credit side of a stock receipt may name it. */
  stockReceipt: boolean
  /**
   * The one act permitted to put it on a document line even so.
   *
   * `billReceipts` is the something-else that clears `2050`, and it derives
   * the amount from the deliveries rather than taking it from anybody.
   */
  documentLineAllowedFor?: MaintainingAct
  /** Why it is maintained elsewhere. */
  because: string
  /**
   * What to do instead of a document line. Required wherever one is refused
   * (Phase 47).
   *
   * Document-line specific, because that is the half that differs per account:
   * register the asset, receive the delivery, open a work order, apply the
   * credit. A stock receipt refused one of these accounts gets the same
   * sentence whichever it was — credit the clearing account if a supplier will
   * bill for the goods, or whatever actually paid for them if nobody will —
   * and that sentence lives at the one call site rather than fifteen times
   * here.
   */
  instead: string | null
  /**
   * How it is kept off the pickers **other than** by this register.
   *
   * Written down because an incidental protection is one a future change can
   * remove without noticing. `null` means this register is the only thing
   * holding it back.
   */
  alsoProtectedBy: string | null
}

export const MAINTAINED_ACCOUNTS: readonly MaintainedAccount[] = [
  {
    number: SYSTEM_ACCOUNTS.accountsReceivable,
    name: 'Accounts Receivable',
    maintainedBy: 'Invoices, credit notes and the receipts applied to them.',
    watchedBy: 'ledger.receivables',
    documentLine: false,
    stockReceipt: false,
    because:
      'The balance is the sum of the open invoices behind it. A balance with no document is ' +
      'money nobody can chase, because the aging report is built from documents — ADR 0031.',
    instead:
      'Raise an invoice. If the point is to correct one, credit it or write it off, which both ' +
      'leave a document behind.',
    alsoProtectedBy: null,
  },
  {
    number: SYSTEM_ACCOUNTS.accountsPayable,
    name: 'Accounts Payable',
    maintainedBy: 'Bills, vendor credits and the payments applied to them.',
    watchedBy: 'ledger.payables',
    documentLine: false,
    stockReceipt: false,
    because:
      'The same rule from the other side. A payable with no bill names no supplier, so there ' +
      'is nobody to pay it to and the report somebody would pay from does not know about it.',
    instead: 'Enter the bill.',
    alsoProtectedBy: null,
  },
  {
    number: SYSTEM_ACCOUNTS.undepositedFunds,
    name: 'Undeposited Funds',
    maintainedBy: 'A receipt taking money in and a deposit banking it.',
    // The one null, and it is honest: Phase 48's lesson was that a clearing
    // account with no check on it collects a balance nothing can clear, and
    // this is a clearing account with no check on it.
    watchedBy: null,
    documentLine: false,
    stockReceipt: false,
    because:
      'Money on its way to a bank. It is moved by the two halves of banking it, and a document ' +
      'line is neither half.',
    instead: 'Record the receipt, then the deposit that banks it.',
    alsoProtectedBy: null,
  },
  {
    number: SYSTEM_ACCOUNTS.accumulatedDepreciation,
    name: 'Accumulated Depreciation',
    maintainedBy: 'The depreciation run.',
    watchedBy: 'assets.register',
    documentLine: false,
    stockReceipt: false,
    because:
      'The contra-asset the register reconciles to. Depreciation journalled by hand is one of ' +
      'the two things assets.register exists to name.',
    instead: 'Run depreciation for the period.',
    alsoProtectedBy: null,
  },
  {
    number: SYSTEM_ACCOUNTS.paymentsInTransit,
    name: 'Payments in Transit',
    maintainedBy: 'A captured checkout, its processor fee, and the payout that sweeps it.',
    watchedBy: 'payments.in_transit',
    documentLine: false,
    stockReceipt: false,
    because:
      "Card money between the customer paying and the processor settling. The check's own note " +
      'says nothing legitimately posts here except those three entries, and it is a fault ' +
      'rather than a position for exactly that reason — so a difference is never a timing ' +
      'artefact. It was on the bill composer\'s list until Phase 211.',
    instead:
      'Code the bill to what the money was spent on. Card takings arrive through the checkout ' +
      'that captured them.',
    alsoProtectedBy: null,
  },
  {
    number: SYSTEM_ACCOUNTS.inventory,
    name: 'Inventory',
    maintainedBy: 'Goods receipts, sales, counts, and returns — each writing a lot and a posting.',
    watchedBy: 'inventory.lots',
    documentLine: false,
    stockReceipt: false,
    because:
      'Σ open lots must equal this account, and a bill line debits it with no lot behind it. ' +
      'Measured, this is the account with no way back: receiving the same goods afterwards ' +
      'doubles the difference rather than closing it, because the receipt posts its own debit.',
    instead:
      'Receive the delivery in Purchasing — no purchase order is needed — and then bill the ' +
      'delivery, which clears it. If this business does not track stock, the cost of goods ' +
      'bought to resell belongs on 5000 Cost of Goods Sold.',
    // Subtype rather than number, so the three manufacturing stock accounts
    // and anything a company adds are covered by the same sentence.
    alsoProtectedBy: "the chart's own subtype: no account typed `inventory` is offered",
  },
  {
    number: INDUSTRY_ACCOUNTS.workInProcess,
    name: 'Work in Process Inventory',
    maintainedBy: 'Material and labour issued to a work order, and the run that finishes it.',
    watchedBy: 'manufacturing.wip',
    documentLine: false,
    // The disagreement a single flag could not have expressed: a completed
    // run credits WIP through `receiveStock` and debits finished goods.
    stockReceipt: true,
    because:
      'Cost enters when material is issued and leaves when a run finishes. A bill for ' +
      'half-built goods is not either of those; a subcontractor who did part of the work is ' +
      '5200 Subcontracted Services.',
    instead:
      'Open a work order and issue what it consumed. A bill from a subcontractor is a cost of ' +
      'sale.',
    alsoProtectedBy: "the chart's own subtype: 1450 is typed `inventory`",
  },
  {
    number: SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced,
    name: 'Goods Received Not Invoiced',
    maintainedBy: 'A receipt taking goods in, and a bill clearing them out.',
    watchedBy: 'inventory.goods_received',
    documentLine: false,
    documentLineAllowedFor: 'receipt_clearance',
    stockReceipt: true,
    because:
      'Phase 48 found $28,700 in this account that nothing in the application could clear, ' +
      'because a bill line could not name it — so every delivery was billed to inventory or an ' +
      'expense instead, counting the cost twice. `billReceipts` is the something-else that ' +
      'clears it, and it derives the amount from the deliveries named rather than taking it ' +
      'from a person.',
    instead: 'Bill the delivery from the unbilled receipts list, which clears this account.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: SYSTEM_ACCOUNTS.customerOverpayments,
    name: 'Customer Overpayments',
    maintainedBy: 'A receipt beyond what was owed, and its later application or refund.',
    watchedBy: 'receivables.customer_credit',
    documentLine: false,
    stockReceipt: false,
    because:
      'Money held for a customer: created by a receipt that exceeded what was owed and cleared ' +
      'by the invoice it is later applied to, or by a refund. A balance with no receipt behind ' +
      'it is cash the business thinks it owes somebody and cannot say who.',
    instead: 'Apply the credit to an invoice, or refund it.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: INDUSTRY_ACCOUNTS.clientRetainers,
    name: 'Client Retainers Held',
    maintainedBy: 'Taking a retainer, and drawing on it.',
    watchedBy: 'timebilling.retainers',
    documentLine: false,
    // The deposit invoice a won proposal raises credits this, which is the
    // second licence this register names — see `MaintainingAct`.
    documentLineAllowedFor: 'deposit_billing',
    stockReceipt: false,
    because:
      "Client money the firm is holding, and the one account on this list where both halves — " +
      "taking the retainer and drawing on it — maintain a per-client balance as well as the " +
      'ledger. A figure here that no client balance accounts for is money somebody is owed and ' +
      'nobody is named for.',
    instead: 'Take the retainer against the client, or draw on it from an invoice.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: '2500',
    name: 'Unearned Revenue',
    maintainedBy: 'Deferred revenue schedules, and retainers where a firm keeps no separate account.',
    watchedBy: 'timebilling.retainers',
    documentLine: false,
    documentLineAllowedFor: 'deposit_billing',
    stockReceipt: false,
    because:
      "The retainer check's weaker form reads this account where 2550 does not exist, so it " +
      'carries the same claim on those books — and on a firm with no 2550 it is also where a ' +
      "proposal's deposit lands, because money taken before the work is not revenue and " +
      'crediting revenue for it would recognise income nobody has earned yet.',
    instead:
      'Bill the deposit stage from the proposal, which credits this and recognises it on the ' +
      'last stage. Outside a schedule, recognise the revenue or take the retainer against the ' +
      'client.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: INDUSTRY_ACCOUNTS.tenantSecurityDeposits,
    name: 'Tenant Security Deposits',
    maintainedBy: 'A deposit received, refunded, or applied to what a tenant owes.',
    watchedBy: 'properties.deposits',
    documentLine: false,
    stockReceipt: false,
    because:
      'A landlord who cannot show that the deposits held match the balance sheet has a problem ' +
      'no report will fix, and in most places a legal one.',
    instead: "Record the deposit movement against the lease.",
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    // Defined as `APPOINTMENT_ACCOUNTS.giftCardsOutstanding`; a test pins the
    // two together, because an industry pack's account has no entry in
    // SYSTEM_ACCOUNTS to import.
    number: '2590',
    name: 'Gift Cards Outstanding',
    maintainedBy: 'Selling a gift card, and redeeming it.',
    watchedBy: 'appointments.gift_cards',
    documentLine: false,
    stockReceipt: false,
    because:
      'What is owed on the cards sold, and the card balances are the subledger. A business that ' +
      'cannot say which cards make up the figure cannot answer the one question a customer asks ' +
      'at the counter, which is what is left on theirs.',
    instead: 'Sell or redeem a card.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: '2320',
    name: 'Contractor Payouts Payable',
    maintainedBy: 'A delivered visit earning a payout, and the payout being paid.',
    watchedBy: 'appointments.payouts',
    documentLine: false,
    stockReceipt: false,
    because:
      'What is owed to practitioners for work already delivered, built from the visits ' +
      'themselves. A balance with no visit behind it is a payout somebody will chase and ' +
      'nothing will explain.',
    instead: 'Complete the visit, then pay the payout.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: '2310',
    name: 'Tips Payable',
    maintainedBy: 'An imported trading day collecting tips, and the payout of them.',
    watchedBy: 'pos.tips',
    documentLine: false,
    stockReceipt: false,
    because:
      "Other people's money, held until it reaches the staff who earned it, and built from the " +
      'trading days imported. A tip pool the till cannot account for is the kind of difference ' +
      'staff notice first and trust last.',
    instead: 'Import the day, then pay the tips out.',
    alsoProtectedBy: 'the type filter: a bill line may not name a liability',
  },
  {
    number: '1060',
    name: 'Cash Drawers',
    maintainedBy: 'Opening a shift with a float, and counting it out at the end.',
    watchedBy: 'cash_drawer.open_tills',
    documentLine: false,
    stockReceipt: false,
    because:
      'The money physically in tills. Its own module says nothing legitimately moves it except ' +
      'opening and closing a shift.',
    instead: 'Open or close a shift.',
    alsoProtectedBy: 'the cash filter: its subtype is `cash`, so no document line is offered it',
  },
  {
    number: SYSTEM_ACCOUNTS.defaultChecking,
    name: 'Bank and card accounts',
    maintainedBy: 'The feed, the receipts, the payments and the deposits that move real money.',
    watchedBy: 'banking.cash_tie_out',
    documentLine: false,
    /*
      The one entry where a receipt may credit what a document line may not,
      other than the two clearing accounts.

      Stock bought outright is one of the three uses `receiveStock`'s parameter
      exists for, and `banking.cash_tie_out` is a **position** rather than a
      fault precisely because money legitimately reaches a bank ledger account
      without a feed row behind it. Phase 117 permitted it, a test pins it, and
      this register is not the place to change it: it records the one real
      tension — the feed row for that purchase, when it arrives, is categorised
      by a person who could post the cost a second time — as a limitation,
      because deciding it is a phase about the bank feed and not about a list.
    */
    stockReceipt: true,
    because:
      '"I owe a supplier, and the money went into my current account" is not a thing that ' +
      'happens, and recording it puts the tie-out permanently out. Stated by number here for ' +
      'the standard chart, but the rule is the subtype, because a company may have twelve.',
    instead: 'Record the payment or the deposit that moved the money.',
    alsoProtectedBy:
      'the cash filter: every account with subtype `bank`, `cash` or `credit_card`, and every ' +
      'account a financial account is opened against',
  },
  {
    number: SYSTEM_ACCOUNTS.fixedAssets,
    name: 'Fixed Assets',
    maintainedBy:
      'A supplier bill or a payment capitalising the cost, and the register adopting it.',
    watchedBy: 'assets.register',
    // The control, and the reason this register is about a way back rather
    // than about faults: measured, registering the asset closes it.
    documentLine: true,
    stockReceipt: true,
    because:
      'A bill line is the **intended** path. `registerAsset` posts nothing unless told to, ' +
      'precisely because "a supplier bill already coded the cost to Fixed Assets and posting ' +
      'it again would put the truck on the balance sheet twice". The fault between the bill ' +
      'and the registration is a to-do with one action behind it, and the check names that ' +
      'action.',
    instead: null,
    alsoProtectedBy: null,
  },
]

const BY_NUMBER = new Map(MAINTAINED_ACCOUNTS.map((row) => [row.number, row]))

/** The entry for an account number, or `undefined` for an ordinary account. */
export function maintainedAccount(number: string): MaintainedAccount | undefined {
  return BY_NUMBER.get(number)
}

/** The acts this register has an opinion about. */
export type PostingAct = 'documentLine' | 'stockReceipt'

/**
 * Why this act may not name this account, or `null` if it may.
 *
 * The message is the register's own prose, so the refusal a person reads and
 * the argument a reader of the code reads cannot drift apart (Phase 70).
 */
export function refusalFor(
  account: {
    number: string
    name: string
    subtype?: string | null
    /**
     * Whether an inventoried item names this account as the one its stock is
     * carried on — the one membership no number and no subtype can settle,
     * because `setItemPostingAccounts` does not type-check the choice.
     */
    carriesStock?: boolean
  },
  act: PostingAct,
  options: { actingAs?: MaintainingAct } = {},
): string | null {
  const entry = maintainedAccount(account.number)

  if (entry) {
    if (entry[act]) return null
    /*
      Both sides have to be present.

      Written as `entry.documentLineAllowedFor === options.actingAs`, with both
      normally `undefined`, this read as a licence for every entry that names no
      act — which measured as the register refusing nothing at all by number
      while the subtype rule went on working, so 1100, 1200, 1250, 1400, 1450
      and 1510 were all offered on a bill line for as long as it took to run
      the measurement again. Kept as a comment because the loud failure was
      three accounts held back for eighty phases coming *back* onto the list,
      which is the only reason it was caught at once — and the fourth of them,
      2000, stayed off it throughout, because a bill line may not name a
      liability. The incidental protection this register exists to write down
      was the only thing working.
    */
    if (
      act === 'documentLine' &&
      options.actingAs !== undefined &&
      entry.documentLineAllowedFor === options.actingAs
    ) {
      return null
    }

    const head = `${entry.number} ${entry.name} is maintained by ${lowerFirst(
      entry.maintainedBy,
    )} ${entry.because}`

    return act === 'documentLine' && entry.instead ? `${head} ${entry.instead}` : head
  }

  /*
    The chart's own word for an account that carries stock (Phase 211).

    `reconcileInventory` compares every lot against 1400 **and every account an
    item names for itself**, which is how Phase 27's manufacturer keeps raw
    materials on 1440 and finished goods on 1460. Naming only 1400 would leave
    the same defect one dropdown along, and naming the four numbers would leave
    it for the fifth account a company adds.

    An explicit entry above wins, which is what lets a finished run credit 1450.
  */
  if (account.subtype === 'inventory' || account.carriesStock) {
    const carries = `${account.number} ${account.name} carries stock, so its balance has to equal the stock on the shelf.`

    return act === 'documentLine'
      ? `${carries} Receive the delivery in Purchasing — no purchase order is needed — and then ` +
          'bill the delivery, which clears it. If this business does not track stock, the cost ' +
          'of goods bought to resell belongs on 5000 Cost of Goods Sold.'
      : `${carries} Crediting it on a receipt that also debits an account like it leaves the ` +
          'lots and the ledger disagreeing by the whole receipt. Credit whatever is going to ' +
          'pay for the goods — the clearing account if a supplier will bill for them.'
  }

  return null
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * The chart account ids one act may not name, for this company.
 *
 * Resolved per company rather than per number, because an item may name an
 * account this register does not know — the one hole the subtype rule above
 * cannot close — and because ids are what a document line actually carries.
 *
 * The inventory half is `stockCarryingAccountIds`, the same function
 * `reconcileInventory` reads, so the accounts the composer refuses and the
 * accounts the check compares against are one list rather than two.
 */
export async function refusedAccountIds(
  ctx: ActorContext,
  act: PostingAct,
  options: { actingAs?: MaintainingAct } = {},
): Promise<Set<string>> {
  const { chartAccounts } = await import('@/db/schema')
  const { db } = await import('@/db')
  const { stockCarryingAccountIds } = await import('@/modules/inventory/accounts')

  /*
    The whole chart, filtered by `refusalFor` rather than by a query.

    Sixty-odd rows, and the alternative is writing the register's rules a
    second time in SQL — where the explicit entry that lets a finished
    manufacturing run credit 1450 would have to be expressed as an exception to
    a subtype predicate. One decision function, read twice, cannot disagree
    with itself.
  */
  const rows = await db
    .select({
      id: chartAccounts.id,
      number: chartAccounts.number,
      name: chartAccounts.name,
      subtype: chartAccounts.subtype,
    })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts))

  /*
    The one membership the subtype rule cannot settle: an account an *item*
    names as the one its stock is carried on, which `setItemPostingAccounts`
    deliberately does not type-check — "the accounts are not validated by type
    here". The reconciliation compares against it either way, so the composer
    has to refuse it either way.
  */
  const carrying = await stockCarryingAccountIds(ctx)

  return new Set(
    rows
      .filter(
        (row) => refusalFor({ ...row, carriesStock: carrying.has(row.id) }, act, options) !== null,
      )
      .map((row) => row.id),
  )
}
