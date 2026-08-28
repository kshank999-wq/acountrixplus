import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db'
import {
  cashDrawers,
  chartAccounts,
  drawerPayouts,
  drawerShifts,
  payments,
  users,
} from '@/db/schema'
import { requirePermission, scoped, type ActorContext } from '@/modules/tenancy/context'
import { requireModule } from '@/modules/industry/modules'
import { createJournalEntry } from '@/modules/ledger/journal'
import { accountByNumber } from '@/modules/coa/service'
import { balanceForAccount } from '@/modules/ledger/balances'
import { recordAudit } from '@/modules/audit'
import { formatCents } from '@/lib/money'
import { countFor, DrawerError, type ShiftCount } from './count'

/**
 * Drawers, shifts, and the count that closes one (spec §5, §13).
 *
 * Phase 32 could take a note across a counter and put it in Undeposited Funds.
 * This is the part that says *which drawer*, *whose shift*, and — at the end of
 * it — whether what is in the drawer is what the till says should be.
 *
 * ## The accounts
 *
 * `1060 Cash Drawers` is the money physically in tills. It is deliberately not
 * `1050 Petty Cash` (a different pot, spent from rather than taken into) and
 * not `1200 Undeposited Funds` (money on its way to a bank, which drawer cash
 * is not until somebody counts it and takes it out).
 *
 * `6870 Cash Over and Short` is Phase 28's, and shared on purpose: an imported
 * day and a counted shift are two ways of discovering the same thing, and a
 * business that does both should read one number for how well its tills are
 * run rather than two.
 */

export const DRAWER_ACCOUNTS = {
  cashInDrawers: '1060',
  pettyCash: '1050',
  undeposited: '1200',
  overShort: '6870',
} as const

/**
 * The accounts a drawer needs, installed if missing.
 *
 * `1060` is in no industry pack, because until now nothing in this application
 * held cash in a till. Installed on first use, the same rule Phase 28 followed
 * for `6870` and Phase 30 for `4620` — only ever adding.
 */
async function ensureAccounts(ctx: ActorContext, exec: Executor): Promise<void> {
  const wanted = [
    {
      number: DRAWER_ACCOUNTS.cashInDrawers,
      name: 'Cash Drawers',
      type: 'asset' as const,
      subtype: 'cash' as const,
      description:
        'Notes and coin physically in a till. Money here is somebody’s responsibility for the ' +
        'length of their shift, and stops being it when they count it and hand it over.',
    },
    {
      number: DRAWER_ACCOUNTS.overShort,
      name: 'Cash Over and Short',
      type: 'expense' as const,
      description:
        'Where a counted till and the register disagree. A running balance near zero is a ' +
        'well-run till; a drifting one is a question.',
    },
  ]

  const existing = await exec
    .select({ number: chartAccounts.number })
    .from(chartAccounts)
    .where(
      scoped(
        ctx,
        chartAccounts,
        inArray(
          chartAccounts.number,
          wanted.map((account) => account.number),
        ),
      ),
    )

  const have = new Set(existing.map((row) => row.number))
  const missing = wanted.filter((account) => !have.has(account.number))
  if (missing.length === 0) return

  await exec
    .insert(chartAccounts)
    .values(missing.map((account) => ({ companyId: ctx.companyId, ...account })))
    .onConflictDoNothing()
}

// --- Drawers ---------------------------------------------------------------

export async function addDrawer(
  ctx: ActorContext,
  input: { name: string; defaultFloatCents?: number },
) {
  requirePermission(ctx, 'company:manage')
  await requireModule(ctx, 'cash_drawer')

  const name = input.name.trim()
  if (!name) throw new DrawerError('A drawer needs a name somebody would use out loud.')

  const [drawer] = await db
    .insert(cashDrawers)
    .values({
      companyId: ctx.companyId,
      name,
      defaultFloatCents: Math.max(0, Math.round(input.defaultFloatCents ?? 0)),
    })
    .returning()

  await recordAudit(ctx, {
    action: 'drawer.create',
    entityType: 'cash_drawer',
    entityId: drawer.id,
    after: { name, defaultFloatCents: drawer.defaultFloatCents },
  })

  return drawer
}

export async function listDrawers(ctx: ActorContext) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: cashDrawers.id,
      name: cashDrawers.name,
      defaultFloatCents: cashDrawers.defaultFloatCents,
      isActive: cashDrawers.isActive,
      openShiftId: drawerShifts.id,
      openedAt: drawerShifts.openedAt,
      openedByName: users.name,
      floatCents: drawerShifts.floatCents,
    })
    .from(cashDrawers)
    .leftJoin(
      drawerShifts,
      and(eq(drawerShifts.drawerId, cashDrawers.id), eq(drawerShifts.status, 'open')),
    )
    .leftJoin(users, eq(users.id, drawerShifts.openedByUserId))
    .where(scoped(ctx, cashDrawers))
    .orderBy(cashDrawers.name)
}

// --- Opening ---------------------------------------------------------------

/**
 * Opens a shift and puts the float in.
 *
 * **A float is not revenue.** It is the shop's own money moved from one pocket
 * to another so that the first customer paying with a twenty can be given
 * change:
 *
 * ```
 *   Dr 1060 Cash Drawers      float
 *       Cr 1050 Petty Cash            float
 * ```
 *
 * Nothing is earned, nothing is owed, and the balance sheet total does not
 * move. A system that booked a float as takings would report a shop as having
 * sold £100 before it opened the door.
 *
 * ## The race
 *
 * Two members of staff opening the same drawer at 9am is a real thing that
 * happens, and the honest arbiter is the database. A partial unique index —
 * `WHERE status = 'open'` — makes the second insert fail, and the message says
 * who has it rather than telling somebody to try again.
 */
export async function openShift(
  ctx: ActorContext,
  input: { drawerId: string; floatCents?: number; notes?: string },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'cash_drawer')

  const [drawer] = await db
    .select()
    .from(cashDrawers)
    .where(scoped(ctx, cashDrawers, eq(cashDrawers.id, input.drawerId)))
    .limit(1)

  if (!drawer) throw new DrawerError('No such drawer.')
  if (!drawer.isActive) throw new DrawerError(`${drawer.name} is not in use.`)

  const floatCents = Math.max(0, Math.round(input.floatCents ?? drawer.defaultFloatCents))

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    let shift
    try {
      ;[shift] = await tx
        .insert(drawerShifts)
        .values({
          companyId: ctx.companyId,
          drawerId: drawer.id,
          openedByUserId: ctx.userId,
          floatCents,
          notes: input.notes?.trim() || null,
        })
        .returning()
    } catch (error) {
      if (isUniqueViolation(error)) {
        const holder = await openShiftFor(ctx, drawer.id)
        throw new DrawerError(
          holder
            ? `${drawer.name} is already open — ${holder.openedByName ?? 'somebody'} started a ` +
              `shift on it at ${holder.openedAt.toISOString().slice(11, 16)}. Close that one first.`
            : `${drawer.name} already has a shift open on it.`,
        )
      }
      throw error
    }

    // The float only moves money if there is any. A drawer opened empty is a
    // legitimate thing — a card-only counter that occasionally takes a note.
    if (floatCents > 0) {
      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: today(),
          memo: `Float into ${drawer.name}`,
          sourceType: 'drawer_shift',
          sourceId: shift.id,
          lines: [
            {
              chartAccountId: await accountId(ctx, DRAWER_ACCOUNTS.cashInDrawers, tx),
              debitCents: floatCents,
              creditCents: 0,
              memo: 'Float in',
            },
            {
              chartAccountId: await accountId(ctx, DRAWER_ACCOUNTS.pettyCash, tx),
              debitCents: 0,
              creditCents: floatCents,
              memo: 'Float out of petty cash',
            },
          ],
        },
        tx,
      )

      await tx
        .update(drawerShifts)
        .set({ openingEntryId: entry.id })
        .where(eq(drawerShifts.id, shift.id))

      shift = { ...shift, openingEntryId: entry.id }
    }

    await recordAudit(
      ctx,
      {
        action: 'drawer.shift_open',
        entityType: 'drawer_shift',
        entityId: shift.id,
        after: { drawer: drawer.name, floatCents },
      },
      tx,
    )

    return shift
  })
}

/** The shift currently open on a drawer, if there is one. */
export async function openShiftFor(ctx: ActorContext, drawerId: string) {
  const [row] = await db
    .select({
      id: drawerShifts.id,
      drawerId: drawerShifts.drawerId,
      openedAt: drawerShifts.openedAt,
      floatCents: drawerShifts.floatCents,
      openedByUserId: drawerShifts.openedByUserId,
      openedByName: users.name,
    })
    .from(drawerShifts)
    .leftJoin(users, eq(users.id, drawerShifts.openedByUserId))
    .where(
      scoped(
        ctx,
        drawerShifts,
        and(eq(drawerShifts.drawerId, drawerId), eq(drawerShifts.status, 'open')),
      ),
    )
    .limit(1)

  return row ?? null
}

/**
 * The one shift open anywhere for this company, if exactly one is.
 *
 * What `takePayment` asks when it has cash and no drawer named. Deliberately
 * refuses to choose when two are open: a note going into the wrong till is a
 * short drawer for one person and a long one for another, and guessing between
 * them creates both problems at once.
 */
export async function soleOpenShift(ctx: ActorContext, exec: Executor = db) {
  const rows = await exec
    .select({ id: drawerShifts.id, drawerId: drawerShifts.drawerId })
    .from(drawerShifts)
    .where(scoped(ctx, drawerShifts, eq(drawerShifts.status, 'open')))
    .limit(2)

  return rows.length === 1 ? rows[0] : null
}

// --- During the shift ------------------------------------------------------

/**
 * Money out of the drawer for something that is not banking.
 *
 * A window cleaner paid out of the till is why a drawer is light, and a shop
 * that cannot record one has a short drawer every week it happens. The reason
 * is kept because "$40 paid out" is not something anybody can act on.
 */
export async function payOut(
  ctx: ActorContext,
  input: { shiftId: string; reason: string; amountCents: number; chartAccountId: string },
) {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'cash_drawer')

  const reason = input.reason.trim()
  if (!reason) throw new DrawerError('A payout needs a reason. "Cash out" is not one.')

  const amountCents = Math.round(input.amountCents)
  if (!(amountCents > 0)) throw new DrawerError('A payout of nothing is not a payout.')

  const shift = await requireOpenShift(ctx, input.shiftId)

  return db.transaction(async (tx) => {
    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: today(),
        memo: `Paid out of ${shift.drawerName}: ${reason}`,
        sourceType: 'drawer_payout',
        sourceId: shift.id,
        lines: [
          { chartAccountId: input.chartAccountId, debitCents: amountCents, creditCents: 0 },
          {
            chartAccountId: await accountId(ctx, DRAWER_ACCOUNTS.cashInDrawers, tx),
            debitCents: 0,
            creditCents: amountCents,
          },
        ],
      },
      tx,
    )

    const [row] = await tx
      .insert(drawerPayouts)
      .values({
        companyId: ctx.companyId,
        shiftId: shift.id,
        reason,
        amountCents,
        chartAccountId: input.chartAccountId,
        journalEntryId: entry.id,
        recordedByUserId: ctx.userId,
      })
      .returning()

    return row
  })
}

export type ShiftPosition = ShiftCount & {
  shiftId: string
  drawerName: string
  openedAt: Date
  openedByName: string | null
  status: string
  payouts: Array<{ id: string; reason: string; amountCents: number }>
  /** How many payments went into this drawer. */
  takingCount: number
}

/**
 * What a shift holds so far, or held when it closed.
 *
 * Takings are summed over `payments` rather than kept as a running total on the
 * shift. A counter is exactly the place where two people press a button at
 * once, and a counter column would be a lost update; the payments are the
 * record and the sum is derived from them.
 */
export async function shiftPosition(
  ctx: ActorContext,
  shiftId: string,
  opts: { countedCents?: number; retainFloatCents?: number } = {},
): Promise<ShiftPosition> {
  requirePermission(ctx, 'accounting:view')

  const [shift] = await db
    .select({
      id: drawerShifts.id,
      status: drawerShifts.status,
      floatCents: drawerShifts.floatCents,
      openedAt: drawerShifts.openedAt,
      countedCents: drawerShifts.countedCents,
      floatRetainedCents: drawerShifts.floatRetainedCents,
      drawerName: cashDrawers.name,
      openedByName: users.name,
    })
    .from(drawerShifts)
    .innerJoin(cashDrawers, eq(cashDrawers.id, drawerShifts.drawerId))
    .leftJoin(users, eq(users.id, drawerShifts.openedByUserId))
    .where(scoped(ctx, drawerShifts, eq(drawerShifts.id, shiftId)))
    .limit(1)

  if (!shift) throw new DrawerError('No such shift.')

  const [takings] = await db
    .select({
      total: sql<string>`coalesce(sum(${payments.amountCents}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(payments)
    // A voided receipt is not in the till (Phase 52). A closed shift's cash
    // cannot be voided at all, so this only ever excludes something taken back
    // while the shift was still open — which is exactly when it should be.
    .where(
      scoped(ctx, payments, eq(payments.drawerShiftId, shiftId), eq(payments.status, 'posted')),
    )

  const paidOut = await db
    .select({
      id: drawerPayouts.id,
      reason: drawerPayouts.reason,
      amountCents: drawerPayouts.amountCents,
    })
    .from(drawerPayouts)
    .where(scoped(ctx, drawerPayouts, eq(drawerPayouts.shiftId, shiftId)))

  const count = countFor({
    floatCents: shift.floatCents,
    takingsCents: Number(takings?.total ?? 0),
    paidOut,
    // A closed shift reports what was actually counted; an open one reports
    // whatever is being typed, or its expected figure when nothing is.
    countedCents:
      opts.countedCents ??
      shift.countedCents ??
      shift.floatCents +
        Number(takings?.total ?? 0) -
        paidOut.reduce((sum, row) => sum + row.amountCents, 0),
    retainFloatCents: opts.retainFloatCents ?? shift.floatRetainedCents ?? undefined,
  })

  return {
    ...count,
    shiftId: shift.id,
    drawerName: shift.drawerName,
    openedAt: shift.openedAt,
    openedByName: shift.openedByName,
    status: shift.status,
    payouts: paidOut,
    takingCount: Number(takings?.count ?? 0),
  }
}

// --- Closing ---------------------------------------------------------------

export type ClosedShift = {
  shiftId: string
  count: ShiftCount
  journalEntryId: string | null
  message: string
}

/**
 * Counts a drawer and closes the shift.
 *
 * ```
 *   Dr 1200 Undeposited Funds   counted − float retained
 *   Dr 6870 Cash Over and Short   (when short)
 *       Cr 1060 Cash Drawers        takings − paid out
 *       Cr 6870 Cash Over and Short   (when over)
 * ```
 *
 * The credit to `1060` is what the *till* says left the drawer to be banked;
 * the debit to `1200` is what was *actually* there. The difference is the whole
 * point and it is posted rather than absorbed. A shop that is £2 short every
 * Friday has a fact about Fridays, and it only exists if the £2 was booked.
 *
 * ## A closed shift is a signed statement
 *
 * Re-counting is refused. A Z-reading whose number can be revised afterwards
 * proves nothing about the moment it was taken, and the moment is the entire
 * control — it is the reason a manager can ask one person about one drawer.
 * Correcting a genuine mis-count is a journal entry with a memo saying so, by
 * somebody who is allowed to post one.
 */
export async function closeShift(
  ctx: ActorContext,
  input: { shiftId: string; countedCents: number; retainFloatCents?: number; notes?: string },
): Promise<ClosedShift> {
  requirePermission(ctx, 'accounting:journal')
  await requireModule(ctx, 'cash_drawer')

  const shift = await requireOpenShift(ctx, input.shiftId)
  const position = await shiftPosition(ctx, shift.id, {
    countedCents: input.countedCents,
    retainFloatCents: input.retainFloatCents,
  })

  return db.transaction(async (tx) => {
    await ensureAccounts(ctx, tx)

    const drawersAccount = await accountId(ctx, DRAWER_ACCOUNTS.cashInDrawers, tx)
    const undeposited = await accountId(ctx, DRAWER_ACCOUNTS.undeposited, tx)
    const overShort = await accountId(ctx, DRAWER_ACCOUNTS.overShort, tx)

    // What the till says should come out of the drawer to be banked.
    const drawerCredit = position.expectedCents - position.floatRetainedCents

    const lines: Array<{
      chartAccountId: string
      debitCents: number
      creditCents: number
      memo?: string
    }> = []

    if (position.toBankCents > 0) {
      lines.push({
        chartAccountId: undeposited,
        debitCents: position.toBankCents,
        creditCents: 0,
        memo: 'Counted out of the drawer',
      })
    }

    if (drawerCredit > 0) {
      lines.push({
        chartAccountId: drawersAccount,
        debitCents: 0,
        creditCents: drawerCredit,
        memo: 'What the till says was in there',
      })
    } else if (drawerCredit < 0) {
      lines.push({
        chartAccountId: drawersAccount,
        debitCents: -drawerCredit,
        creditCents: 0,
        memo: 'Float topped up from the count',
      })
    }

    if (position.overShortCents !== 0) {
      // Short is a cost; over is a negative one. Both to the same account, so
      // its running balance answers "how well are the tills run".
      lines.push(
        position.overShortCents < 0
          ? {
              chartAccountId: overShort,
              debitCents: -position.overShortCents,
              creditCents: 0,
              memo: 'Short',
            }
          : {
              chartAccountId: overShort,
              debitCents: 0,
              creditCents: position.overShortCents,
              memo: 'Over',
            },
      )
    }

    let journalEntryId: string | null = null

    if (lines.length > 0) {
      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: today(),
          memo: `${position.drawerName} counted — ${describeShort(position)}`,
          sourceType: 'drawer_shift',
          sourceId: shift.id,
          lines,
        },
        tx,
      )
      journalEntryId = entry.id
    }

    await tx
      .update(drawerShifts)
      .set({
        status: 'closed',
        closedByUserId: ctx.userId,
        closedAt: new Date(),
        countedCents: position.countedCents,
        expectedCents: position.expectedCents,
        overShortCents: position.overShortCents,
        floatRetainedCents: position.floatRetainedCents,
        closingEntryId: journalEntryId,
        notes: input.notes?.trim() || shift.notes,
      })
      .where(scoped(ctx, drawerShifts, eq(drawerShifts.id, shift.id)))

    await recordAudit(
      ctx,
      {
        action: 'drawer.shift_close',
        entityType: 'drawer_shift',
        entityId: shift.id,
        after: {
          countedCents: position.countedCents,
          expectedCents: position.expectedCents,
          overShortCents: position.overShortCents,
        },
      },
      tx,
    )

    return {
      shiftId: shift.id,
      count: position,
      journalEntryId,
      message: messageFor(position),
    }
  })
}

/** Shifts newest first, for a screen about how the tills have been running. */
export async function shiftHistory(ctx: ActorContext, opts: { limit?: number } = {}) {
  requirePermission(ctx, 'accounting:view')

  return db
    .select({
      id: drawerShifts.id,
      drawerName: cashDrawers.name,
      status: drawerShifts.status,
      openedAt: drawerShifts.openedAt,
      closedAt: drawerShifts.closedAt,
      floatCents: drawerShifts.floatCents,
      countedCents: drawerShifts.countedCents,
      expectedCents: drawerShifts.expectedCents,
      overShortCents: drawerShifts.overShortCents,
      openedByName: users.name,
    })
    .from(drawerShifts)
    .innerJoin(cashDrawers, eq(cashDrawers.id, drawerShifts.drawerId))
    .leftJoin(users, eq(users.id, drawerShifts.openedByUserId))
    .where(scoped(ctx, drawerShifts))
    .orderBy(desc(drawerShifts.openedAt))
    .limit(opts.limit ?? 50)
}

// --- Helpers ---------------------------------------------------------------

async function requireOpenShift(ctx: ActorContext, shiftId: string) {
  const [shift] = await db
    .select({
      id: drawerShifts.id,
      status: drawerShifts.status,
      notes: drawerShifts.notes,
      drawerName: cashDrawers.name,
    })
    .from(drawerShifts)
    .innerJoin(cashDrawers, eq(cashDrawers.id, drawerShifts.drawerId))
    .where(scoped(ctx, drawerShifts, eq(drawerShifts.id, shiftId)))
    .limit(1)

  if (!shift) throw new DrawerError('No such shift.')

  if (shift.status !== 'open') {
    throw new DrawerError(
      `That shift on ${shift.drawerName} has already been counted and closed. A count is a ` +
        'statement about a moment; correcting one is a journal entry, not a second count.',
    )
  }

  return shift
}

async function accountId(ctx: ActorContext, number: string, exec: Executor): Promise<string> {
  const [row] = await exec
    .select({ id: chartAccounts.id })
    .from(chartAccounts)
    .where(scoped(ctx, chartAccounts, eq(chartAccounts.number, number)))
    .limit(1)

  if (!row) throw new DrawerError(`This company has no account ${number}.`)
  return row.id
}

/** Drizzle wraps driver errors, so the SQLSTATE is down the cause chain. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function describeShort(count: ShiftCount): string {
  if (count.balances) return 'balanced'
  return count.overShortCents > 0
    ? `${formatCents(count.overShortCents)} over`
    : `${formatCents(-count.overShortCents)} short`
}

function messageFor(count: ShiftPosition): string {
  const parts = [
    `${count.drawerName} counted at ${formatCents(count.countedCents)}, ` +
      `against ${formatCents(count.expectedCents)} expected.`,
  ]

  if (count.balances) {
    parts.push('It balances.')
  } else {
    parts.push(
      count.overShortCents > 0
        ? `${formatCents(count.overShortCents)} over.`
        : `${formatCents(-count.overShortCents)} short.`,
    )
  }

  if (count.toBankCents > 0) {
    parts.push(`${formatCents(count.toBankCents)} to bank.`)
  }
  if (count.floatRetainedCents > 0) {
    parts.push(`${formatCents(count.floatRetainedCents)} left in for the next shift.`)
  }

  return parts.join(' ')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export { DrawerError, countFor, describe } from './count'
export type { ShiftCount, PaidOut } from './count'

export type DrawerPosition = {
  /** What every till should physically hold. */
  registerCents: number
  /** What account 1060 holds. */
  ledgerCents: number
  differenceCents: number
  agrees: boolean
  tills: Array<{
    drawerId: string
    drawerName: string
    /** Null when the drawer is shut. */
    openShiftId: string | null
    expectedCents: number
  }>
}

/**
 * What the tills should hold, against the balance sheet.
 *
 * Phase 33's eleventh check, and the first written *for* the register rather
 * than adopted into it. The two sides are genuinely different in the sense
 * Phase 26 established: the left is derived from `drawer_shifts`, `payments`
 * and `drawer_payouts`; the right is a sum over journal lines. Neither comes
 * from the other.
 *
 * ## Why this is per drawer rather than per open shift
 *
 * The first version of this summed only the *open* shifts, and browser
 * verification caught it immediately: a shift closed leaving £100 in the till
 * for tomorrow leaves £100 in `1060` and no open shift to account for it. That
 * check would have reported every shop that keeps a float overnight as £100
 * adrift, every night — which is every shop, and an alarm that fires on
 * ordinary trading is one somebody switches off.
 *
 * A drawer holds money whether or not anybody is standing at it. So the unit
 * is the drawer: the open shift's expected figure when one is running, and the
 * float its last shift left in when none is.
 *
 * They must agree exactly. Nothing legitimately moves `1060` except opening a
 * shift, taking cash into one, paying out of one, or closing one — and all
 * four maintain both sides in the same transaction.
 */
export async function drawerPosition(
  ctx: ActorContext,
  opts: { asOf?: string } = {},
): Promise<DrawerPosition> {
  requirePermission(ctx, 'reports:view')

  const drawers = await db
    .select({ id: cashDrawers.id, name: cashDrawers.name })
    .from(cashDrawers)
    .where(scoped(ctx, cashDrawers))
    .orderBy(cashDrawers.name)

  const tills: DrawerPosition['tills'] = []

  for (const drawer of drawers) {
    const [open] = await db
      .select({ id: drawerShifts.id, floatCents: drawerShifts.floatCents })
      .from(drawerShifts)
      .where(
        scoped(
          ctx,
          drawerShifts,
          and(eq(drawerShifts.drawerId, drawer.id), eq(drawerShifts.status, 'open')),
        ),
      )
      .limit(1)

    if (open) {
      const [takings] = await db
        .select({ total: sql<string>`coalesce(sum(${payments.amountCents}), 0)` })
        .from(payments)
        .where(
          scoped(ctx, payments, eq(payments.drawerShiftId, open.id), eq(payments.status, 'posted')),
        )

      const [paid] = await db
        .select({ total: sql<string>`coalesce(sum(${drawerPayouts.amountCents}), 0)` })
        .from(drawerPayouts)
        .where(scoped(ctx, drawerPayouts, eq(drawerPayouts.shiftId, open.id)))

      tills.push({
        drawerId: drawer.id,
        drawerName: drawer.name,
        openShiftId: open.id,
        expectedCents:
          open.floatCents + Number(takings?.total ?? 0) - Number(paid?.total ?? 0),
      })
      continue
    }

    // Shut. Whatever its last shift left in it is still sitting there.
    const [last] = await db
      .select({ floatRetainedCents: drawerShifts.floatRetainedCents })
      .from(drawerShifts)
      .where(
        scoped(
          ctx,
          drawerShifts,
          and(eq(drawerShifts.drawerId, drawer.id), eq(drawerShifts.status, 'closed')),
        ),
      )
      .orderBy(desc(drawerShifts.closedAt))
      .limit(1)

    tills.push({
      drawerId: drawer.id,
      drawerName: drawer.name,
      openShiftId: null,
      expectedCents: last?.floatRetainedCents ?? 0,
    })
  }

  const registerCents = tills.reduce((sum, row) => sum + row.expectedCents, 0)

  const account = await accountByNumber(ctx.companyId, DRAWER_ACCOUNTS.cashInDrawers)
  const ledgerCents = account
    ? await balanceForAccount(ctx, account.id, { endDate: opts.asOf })
    : 0

  return {
    registerCents,
    ledgerCents,
    differenceCents: registerCents - ledgerCents,
    agrees: registerCents === ledgerCents,
    tills,
  }
}
