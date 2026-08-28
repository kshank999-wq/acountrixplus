import { randomBytes } from 'node:crypto'
import { appBaseUrl } from '@/modules/notify/transactional'
import { DEFAULT_FEE_SCHEDULE, feeFor } from './settlement'
import type {
  Checkout,
  PaymentProvider,
  ProviderPayment,
  ProviderPayout,
} from './provider'

/**
 * In-memory card processor used for development, demos, and tests (spec §21).
 *
 * ## What it is honest about
 *
 * It charges the same fee shape a real processor does and holds the money
 * before paying it out, because those are the two facts the *ledger* has to
 * cope with, and getting them right against a mock is what makes the real
 * adapter a swap rather than a rewrite. Everything downstream — the clearing
 * account, the fee expense, the payout entry, the tie-out — is real.
 *
 * ## What it is not
 *
 * It takes no card details and moves no money. `createCheckout` returns a URL
 * on this application rather than a processor's, because there is nowhere else
 * for it to point; that page says out loud that nothing is being charged.
 *
 * A payment "succeeds" the moment it is confirmed, which is the one place the
 * mock is kinder than reality — a real processor declines cards, and the
 * adapter reports that through `status: 'failed'` with the reason. The
 * declined path is exercised by asking for an amount ending in 13 cents,
 * which is a deliberate seam for testing rather than a joke: there has to be
 * *some* way to see a decline without a real card, and a magic amount is what
 * every processor's own sandbox uses.
 */

type MockPayment = {
  providerCheckoutId: string
  providerPaymentId: string | null
  status: 'pending' | 'succeeded' | 'failed'
  grossCents: number
  feeCents: number
  currency: string
  companyId: string
  createdAt: Date
  failureReason?: string
  /** Set once a payout has swept it, so it is not paid out twice. */
  paidOutIn: string | null
}

/**
 * Module-level, so a checkout created by one request is visible to the next.
 *
 * Lost on restart, which is correct for a mock and stated plainly: a demo that
 * survived a deploy would be pretending to be a database.
 */
const payments = new Map<string, MockPayment>()

/** A card that declines, for anybody who needs to see the unhappy path. */
const DECLINE_SENTINEL = 13

export class MockPaymentProvider implements PaymentProvider {
  readonly key = 'mock'
  /** Always ready. It is the one adapter that needs no credentials. */
  readonly configured = true

  async createCheckout(input: {
    companyId: string
    invoiceId: string
    amountCents: number
    currency: string
    description: string
    customerEmail: string | null
    returnUrl: string
  }): Promise<Checkout> {
    const providerCheckoutId = `mock_cs_${randomBytes(9).toString('hex')}`

    payments.set(providerCheckoutId, {
      providerCheckoutId,
      providerPaymentId: null,
      status: 'pending',
      grossCents: input.amountCents,
      feeCents: 0,
      currency: input.currency,
      companyId: input.companyId,
      createdAt: new Date(),
      paidOutIn: null,
    })

    // Stands in for the processor's own hosted page. On this application
    // because there is nowhere else for it to point, and that page says out
    // loud that no card is being taken and no money is moving.
    const url = new URL(`${appBaseUrl()}/pay/${providerCheckoutId}`)
    url.searchParams.set('return', input.returnUrl)

    return {
      providerCheckoutId,
      url: url.toString(),
      // Long enough that a customer can leave the tab open over lunch, short
      // enough that a stale link does not settle an invoice paid last week.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }
  }

  async getPayment(providerCheckoutId: string): Promise<ProviderPayment> {
    const held = payments.get(providerCheckoutId)

    if (!held) {
      // `unknown`, not `failed`. A processor that has never heard of a
      // checkout has not declined it — and a sweep that read this as a
      // decline would mark a real payment dead. The mock loses its store on
      // restart, so this is the answer a demo genuinely gets after a reload,
      // which makes it the right one to exercise.
      return {
        providerCheckoutId,
        providerPaymentId: null,
        status: 'unknown',
        grossCents: 0,
        feeCents: 0,
        currency: 'USD',
        failureReason: 'No record of this checkout.',
      }
    }

    return { ...held }
  }

  /**
   * Confirms a payment. The mock's stand-in for the customer typing a card.
   *
   * Not on the `PaymentProvider` interface — a real adapter has nothing like
   * it, because a real customer does this on the processor's own page. The
   * caller reaches for it through `mockPaymentProvider` explicitly, which
   * keeps the seam honest: nothing generic can accidentally settle a payment.
   */
  async confirm(providerCheckoutId: string): Promise<ProviderPayment> {
    const held = payments.get(providerCheckoutId)
    if (!held) return this.getPayment(providerCheckoutId)

    // Already settled. Confirming twice is a customer double-clicking, and it
    // must not produce a second payment.
    if (held.status !== 'pending') return { ...held }

    if (held.grossCents % 100 === DECLINE_SENTINEL) {
      held.status = 'failed'
      held.failureReason = 'The card was declined.'
      payments.set(providerCheckoutId, held)
      return { ...held }
    }

    held.status = 'succeeded'
    held.providerPaymentId = `mock_pi_${randomBytes(9).toString('hex')}`
    held.feeCents = feeFor(held.grossCents, DEFAULT_FEE_SCHEDULE).feeCents
    payments.set(providerCheckoutId, held)

    return { ...held }
  }

  /**
   * Batches everything succeeded and unswept into one payout.
   *
   * One batch, not one per payment, because the batching is the whole reason
   * the clearing account exists — a mock that paid out singly would let a
   * wrong implementation pass.
   */
  async listPayouts(companyId: string, since: string): Promise<ProviderPayout[]> {
    const sweepable = [...payments.values()].filter(
      (payment) =>
        payment.companyId === companyId &&
        payment.status === 'succeeded' &&
        payment.paidOutIn === null,
    )

    if (sweepable.length === 0) return []

    const providerPayoutId = `mock_po_${randomBytes(9).toString('hex')}`
    const amountCents = sweepable.reduce(
      (sum, payment) => sum + payment.grossCents - payment.feeCents,
      0,
    )

    for (const payment of sweepable) {
      payment.paidOutIn = providerPayoutId
      payments.set(payment.providerCheckoutId, payment)
    }

    // Arrives today, because this batch is being paid out now.
    //
    // A real processor announces a batch two working days ahead and reports it
    // `pending` until it lands — and `importPayouts` refuses to post one of
    // those, because a deposit dated Friday must not credit the bank on
    // Wednesday. The mock does not need to reproduce the wait to exercise
    // that: the settlement delay it *does* model is the one that matters,
    // money sitting at the processor until a payout exists at all.
    const arrival = new Date()

    return [
      {
        providerPayoutId,
        arrivalDate: arrival.toISOString().slice(0, 10),
        amountCents,
        currency: sweepable[0].currency,
        paymentIds: sweepable.map((payment) => payment.providerPaymentId!).filter(Boolean),
        status: 'paid' as const,
      },
    ].filter((payout) => payout.arrivalDate >= since || since === '')
  }

  /** Empties the store. For tests, which must not see each other's payments. */
  reset(): void {
    payments.clear()
  }
}

/**
 * The single mock instance.
 *
 * Exported by name so the confirm path — which exists only here — is reached
 * deliberately rather than by casting whatever `getPaymentProvider` returned.
 */
export const mockPaymentProvider = new MockPaymentProvider()
