import { eq, isNotNull } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import { serviceItems } from '@/db/schema'
import { accountByNumber } from '@/modules/coa/service'
import { SYSTEM_ACCOUNTS } from '@/modules/coa/standard'
import { scoped, type ActorContext } from '@/modules/tenancy/context'

/**
 * Every ledger account this company's stock is actually carried on
 * (Phase 211).
 *
 * ## Why this is a function rather than a number
 *
 * An item may name its own inventory account, and Phase 27's manufacturer does
 * exactly that — raw materials on `1440`, finished goods on `1460`, and nothing
 * at all on `1400`. `reconcileInventory` has collected the set since Phase 14,
 * for a reason its own comment gives: comparing every lot against `1400` alone
 * *"reported a difference the size of the whole subledger, on books that were
 * perfectly correct, which is worse than not checking"*.
 *
 * ## Why it moved out of `reconcileInventory`
 *
 * Phase 211 needed the same set on the other side of the question: these are
 * the accounts a bill line must not name, because a debit to one of them with
 * no lot behind it is precisely the difference `inventory.lots` reports as a
 * fault. Two code paths deriving the set separately is the shape this project
 * keeps finding behind a pair of checks that disagree — so the composer and the
 * reconciliation read one function, and if a company's set ever changes they
 * change together.
 *
 * The chart's `subtype` of `inventory` catches the same accounts in the
 * ordinary case and is used as well, for the account a company adds and no
 * item has named yet. This catches the other direction: an account an item
 * names that is typed as something else, which `setItemPostingAccounts`
 * deliberately permits — *"the accounts are not validated by type here"*.
 */
export async function stockCarryingAccountIds(
  ctx: ActorContext,
  exec: Executor = db,
): Promise<Set<string>> {
  /*
    Total rather than refusing, unlike its callers.

    `reconcileInventory` must refuse a chart with no 1400 — it has nothing to
    compare against and saying so is the only honest answer. The composer must
    not: a company whose chart is missing an account it has no stock in should
    still be able to raise a bill, and a set with one fewer member is exactly
    right there. So the refusal stays with the caller that needs it.
  */
  const inventoryAccount = await accountByNumber(ctx.companyId, SYSTEM_ACCOUNTS.inventory, exec)

  const named = await exec
    .selectDistinct({ id: serviceItems.inventoryAccountId })
    .from(serviceItems)
    .where(
      scoped(
        ctx,
        serviceItems,
        eq(serviceItems.isInventoried, true),
        isNotNull(serviceItems.inventoryAccountId),
      ),
    )

  // The default is always included, because an item that names no account
  // lands there.
  return new Set([
    ...(inventoryAccount ? [inventoryAccount.id] : []),
    ...named.map((row) => row.id as string),
  ])
}
