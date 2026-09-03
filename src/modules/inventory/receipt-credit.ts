import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'

/**
 * What a stock receipt may be credited to (spec §13, §14, Phase 117).
 *
 * ## The parameter that named three uses and refused none
 *
 * `receiveStock` takes the credit account from its caller, and says why:
 *
 * > The shared path for a goods receipt, an opening balance, and a customer
 * > return — they differ only in what gets credited, which is why that is a
 * > parameter rather than three near-copies of this function.
 *
 * That is a good reason for a parameter and a bad reason to leave it
 * unconstrained. Naming three legitimate values without naming what is
 * illegitimate is how the fourth gets in, and it did: this repository's own
 * seed credited **`2000 Accounts Payable`** on four receipts, in two of its
 * seven demo companies.
 *
 * ## Why a control account is the one thing it must never be
 *
 * A control account is the ledger's one-line summary of a subledger. Its
 * balance is *by definition* the sum of the documents behind it, and Phase 31
 * built a fault-severity check that says so. A stock receipt is not one of
 * those documents: it has no supplier, no due date, no bill number and no row
 * in the payables aging report.
 *
 * So crediting `2000` puts money on the balance sheet that the report a person
 * would pay from does not know about — the identical failure ADR 0031 was
 * written about, arriving from the other side:
 *
 * > The balance sheet says £365 is owed; the aging report says nothing is owed;
 * > both are internally consistent, and neither mentions the other.
 *
 * Measured on the seeded books before this phase: **Kestrel Fabrication owed
 * $3,030.00 on its balance sheet and $0.00 on its payables report; Ashgrove
 * Motors owed $180.00 against $0.00.** Both had been that way since the seed
 * was written, and the nightly check had reported it every night — for a
 * company nobody had ever opened.
 *
 * ## A refusal rather than a check
 *
 * The Phase 116 lesson: a check reports what has already happened, and this can
 * be made not to happen. `receiveStock` refuses, so a caller that gets it wrong
 * fails loudly at the moment it is written rather than quietly on a balance
 * sheet months later. The seed is code, so the seed fails too.
 */

/** The accounts whose balance must equal the documents behind them. */
export const CONTROL_ACCOUNTS: readonly { number: string; because: string }[] = [
  {
    number: SYSTEM_ACCOUNTS.accountsReceivable,
    because:
      'Accounts Receivable is the sum of the open invoices and credit notes behind it. A ' +
      'balance with no document is money nobody can chase, because the aging report is built ' +
      'from documents.',
  },
  {
    number: SYSTEM_ACCOUNTS.accountsPayable,
    because:
      'Accounts Payable is the sum of the open bills and vendor credits behind it. A balance ' +
      'with no document is money nobody can pay, because the payables report is built from ' +
      'documents — and it names no supplier, so there is nobody to pay it to.',
  },
]

export type CreditVerdict =
  | { ok: true }
  | {
      ok: false
      /** What to tell whoever tried it, in terms of the books rather than the code. */
      why: string
    }

/**
 * Whether stock coming onto the books may credit this account.
 *
 * Everything except a control account is permitted, and deliberately so — the
 * legitimate credits are genuinely varied (goods received not invoiced, work in
 * process, opening balance equity, a bank account for stock bought outright,
 * a revenue account for a customer return) and enumerating them would refuse
 * the next honest one. What is being excluded is a single, statable class.
 */
export function creditableByReceipt(account: {
  number: string
  name: string
}): CreditVerdict {
  const control = CONTROL_ACCOUNTS.find((row) => row.number === account.number)
  if (!control) return { ok: true }

  return {
    ok: false,
    why:
      `Stock cannot be received against ${account.number} ${account.name}. ${control.because} ` +
      `Receive it against ${SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced} Goods Received Not ` +
      'Invoiced if a supplier is going to bill for it, or against whatever actually paid for ' +
      'it if nobody will.',
  }
}
