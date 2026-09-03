/**
 * What the retainers say against what the ledger says (Phase 105).
 *
 * ## The defect
 *
 * The integrity register checks every other kind of money the company holds for
 * somebody else — gift cards against 2590, tenant deposits against 2580,
 * customer overpayments against 2520, practitioner earnings against 2320 — and
 * had nothing for retainers, which are a client's money taken before the work is
 * done.
 *
 * `receivables.customer_credit` wrote the lesson down in Phase 53: *"Added with
 * the account rather than after it, because Phase 48 found a clearing account
 * with no check on it and $28,700 in it that nothing in the application could
 * clear. Once is enough to learn that."* Retainers were built in Phase 15 with
 * their own liability account and never got one.
 *
 * ## Why the verdict is not simply "are these equal"
 *
 * `retainerAccount` resolves `2550 Client Retainers Held`, **or `2500 Unearned
 * Revenue` where the industry pack did not install it** — and that fallback is
 * the common case, not the rare one: six of the seven companies in the
 * development database have no 2550.
 *
 * On a shared account, equality is not true and never was: 2500 legitimately
 * holds every other kind of deferred revenue as well. A check demanding equality
 * would cry wolf on most companies, and a check that cries wolf is a check
 * somebody turns off.
 *
 * So there are two claims, and which one was made is part of the answer:
 *
 * - **dedicated** — the two must be equal, because nothing else posts there;
 * - **shared** — the retainers must not *exceed* the account, because unearned
 *   revenue cannot legitimately be negative, so client money exceeding all
 *   deferred revenue means a ledger half is missing.
 *
 * Both are faults. The weaker claim is still one nothing legitimate can break,
 * which is the line this register draws between a fault and a position.
 *
 * No database and no clock: this file decides, and `reporting.ts` fetches.
 */

/** Whether the liability account holds only retainers, or other things too. */
export type Holding = 'dedicated' | 'shared'

export type Position = {
  /** Σ `functional_remaining_cents` — the company's own money, never a mix. */
  heldCents: number
  /** The balance on whichever account the retainers were posted to. */
  ledgerCents: number
  holding: Holding
  accountNumber: string
  accountName: string
  /** Retainers with something still on them, for the sentence. */
  openCount: number
}

export type Verdict = {
  agrees: boolean
  /** What was actually compared, so a reader knows which question was answered. */
  claim: string
  /** The sentence the register shows. Empty when everything agrees. */
  detail: string | undefined
}

const money = (cents: number): string => {
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const text = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
  return negative ? `-${text}` : text
}

const retainerWord = (count: number): string =>
  `${count} retainer${count === 1 ? '' : 's'}`

/**
 * What the register should say about this position.
 *
 * The `claim` is deliberately part of the return rather than a comment. A check
 * that quietly downgrades what it asserts is worse than one that is absent,
 * because the screen shows a tick either way and nobody can tell which question
 * was answered.
 */
export function verdictFor(position: Position): Verdict {
  const { heldCents, ledgerCents, holding, accountNumber, accountName, openCount } = position

  const account = `${accountNumber} ${accountName}`

  if (holding === 'dedicated') {
    const agrees = heldCents === ledgerCents
    return {
      agrees,
      claim: `Σ retainers equals ${account}`,
      detail: agrees
        ? undefined
        : `${retainerWord(openCount)} hold ${money(heldCents)} between them; ` +
          `${account} carries ${money(ledgerCents)}. ` +
          'Taking a retainer and drawing on it both post in the same transaction ' +
          'that maintains the balance, so a difference means one half happened ' +
          'without the other.',
    }
  }

  // Shared: the strongest true claim, and an instruction for getting a
  // stronger one.
  const agrees = heldCents <= ledgerCents
  return {
    agrees,
    claim: `Σ retainers does not exceed ${account}`,
    detail: agrees
      ? undefined
      : `${retainerWord(openCount)} hold ${money(heldCents)} between them, which is more ` +
        `than the ${money(ledgerCents)} on ${account} — and that account holds every other ` +
        'kind of deferred revenue too, so it should be the larger of the two. ' +
        'A ledger half is missing.',
  }
}

/**
 * What a company gains by installing the dedicated account.
 *
 * Returned separately from the verdict because it is true whether or not the
 * check passed: on a shared account the tick means less than it appears to, and
 * saying so is the difference between a limitation and a silent one.
 */
export function weakerBecauseShared(position: Position): string | undefined {
  if (position.holding === 'dedicated') return undefined

  return (
    `Checked against ${position.accountNumber} ${position.accountName}, which also holds other ` +
    'deferred revenue, so only "not more than" could be checked rather than "equal to". ' +
    'Installing 2550 Client Retainers Held would let this compare exactly.'
  )
}
