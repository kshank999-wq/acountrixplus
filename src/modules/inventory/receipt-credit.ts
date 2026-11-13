import { MAINTAINED_ACCOUNTS, refusalFor } from '@/modules/coa/maintained'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'

/**
 * What a stock receipt may be credited to (spec §13, §14, Phase 117,
 * Phase 211).
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
 * Measured on the seeded books before that phase: **Kestrel Fabrication owed
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
 *
 * ## The class was statable and this file stated two of it (Phase 211)
 *
 * All of the above is right, and the list under it held `1100` and `2000`.
 * Phase 117's own argument for not enumerating the *permitted* side was that
 * *"the legitimate credits are genuinely varied… and enumerating them would
 * refuse the next honest one. **What is being excluded is a single, statable
 * class.**"*
 *
 * It is, and fifteen of its members have a check watching them. Measured
 * against `FALSIFIERS`, which already records per check that the one act
 * breaking it is *"post a manual journal entry against `<account>`"*: the
 * fifteen accounts no stock receipt may credit were **two** here, and the
 * seventeen no document line may name were **four** in
 * `documentLineAccounts`, which kept its own copy of the same class. Three of
 * that list's gaps were reachable from a dropdown.
 *
 * So the class now lives in one place, `coa/maintained.ts`, and this file is a
 * reader of it. The verdict type and this function's name are unchanged,
 * because `receiveStock`'s refusal is still the thing that happens.
 *
 * ## What changed for a receipt, and what did not
 *
 * A receipt may still credit a great deal: goods received not invoiced, work in
 * process, opening balance equity, a bank account for stock bought outright, a
 * revenue account for a customer return. Two of those are accounts the register
 * refuses a *document line* — which is why the register answers per act rather
 * than carrying one flag. What a receipt may no longer credit is an account
 * that carries stock, including one this chart never shipped: crediting what
 * the same entry debits leaves the lots and the ledger disagreeing by the whole
 * receipt.
 */

/**
 * The accounts whose balance must equal the documents behind them.
 *
 * Kept as a derived view of the register rather than a list of its own, so
 * that the question "which accounts does something else maintain" has one
 * answer. Every caller of this constant wanted exactly this: the accounts no
 * stock receipt may credit.
 */
export const CONTROL_ACCOUNTS: readonly { number: string; because: string }[] =
  MAINTAINED_ACCOUNTS.filter((row) => !row.stockReceipt).map((row) => ({
    number: row.number,
    because: row.because,
  }))

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
 * Everything the register has no opinion about is permitted, and deliberately
 * so — the legitimate credits are genuinely varied and enumerating them would
 * refuse the next honest one.
 */
export function creditableByReceipt(account: {
  number: string
  name: string
  subtype?: string | null
}): CreditVerdict {
  const why = refusalFor(account, 'stockReceipt')
  if (!why) return { ok: true }

  return {
    ok: false,
    /*
      The remedy is the same for every account on the list, which is why it is
      here and not repeated fifteen times in the register: what a receipt needs
      is the other side of the entry, and there are exactly two honest answers
      — the clearing account if somebody is going to invoice for the goods, and
      whatever actually paid for them if nobody is. The register carries the
      part that differs, which is *why* this account is not one of them.
    */
    why:
      `Stock cannot be received against ${account.number} ${account.name}. ${why} ` +
      `Receive it against ${SYSTEM_ACCOUNTS.goodsReceivedNotInvoiced} Goods Received Not ` +
      'Invoiced if a supplier is going to bill for it, or against whatever actually paid for ' +
      'it if nobody will.',
  }
}
