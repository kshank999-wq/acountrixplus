import { DomainError } from '@/modules/errors'

/**
 * Card payment provider abstraction (spec §13, §19).
 *
 * The receivables domain talks only to this interface. Swapping one processor
 * for another means writing one adapter — nothing about a vendor may leak
 * past these types, and in particular **no card data ever passes through this
 * application**. The customer is sent to the processor's own page; what comes
 * back is an identifier and an amount.
 *
 * That is not only a compliance convenience. A payment form served from here
 * would put this application in scope for PCI DSS, which is a different
 * product with a different budget, and spec §19 is explicit that payment
 * features need a security review before production use. Redirecting is the
 * only shape that keeps the promise the rest of the system makes.
 */

/** Where a customer is sent to pay, and what identifies it afterwards. */
export type Checkout = {
  /** The processor's own id for this attempt. Stored, and the dedup key. */
  providerCheckoutId: string
  /** Where to send the customer's browser. */
  url: string
  expiresAt: Date
}

export type ProviderPaymentStatus = 'pending' | 'succeeded' | 'failed'

export type ProviderPayment = {
  providerCheckoutId: string
  /**
   * The processor's id for the money itself, once there is any.
   *
   * Distinct from the checkout: one abandoned attempt and one successful
   * retry are two checkouts and one payment, and conflating them is how an
   * invoice gets settled twice.
   */
  providerPaymentId: string | null
  status: ProviderPaymentStatus
  /** What the customer was charged, in minor units. */
  grossCents: number
  /** What the processor kept. Providers reporting this late send zero first. */
  feeCents: number
  currency: string
  /** The processor's own words when it failed. Never shown to the customer raw. */
  failureReason?: string
}

export type ProviderPayout = {
  /** Stable id at the processor. The dedup key for importing payouts. */
  providerPayoutId: string
  /** ISO date the money reaches the bank. */
  arrivalDate: string
  /** What the processor says it deposited, net of everything. */
  amountCents: number
  currency: string
  /** The payments this batch settles, by `providerPaymentId`. */
  paymentIds: string[]
  status: 'pending' | 'paid'
}

export interface PaymentProvider {
  /** Adapter key stored on `payment_settings.provider`. */
  readonly key: string

  /**
   * True when the adapter has what it needs to reach a real processor.
   *
   * Checked before a customer is ever sent anywhere: a Pay button that leads
   * to a configuration error is worse than no Pay button, because the
   * customer concludes the business cannot take their money.
   */
  readonly configured: boolean

  /** Starts a hosted checkout. The customer goes to `url`. */
  createCheckout(input: {
    companyId: string
    invoiceId: string
    amountCents: number
    currency: string
    description: string
    customerEmail: string | null
    /** Where the processor returns the customer afterwards. */
    returnUrl: string
  }): Promise<Checkout>

  /** What happened to a checkout. Polled, and driven by webhook where one exists. */
  getPayment(providerCheckoutId: string): Promise<ProviderPayment>

  /** Payouts on or after a date, so a sync can be incremental. */
  listPayouts(companyId: string, since: string): Promise<ProviderPayout[]>
}

/** Raised when a provider call fails in a way the caller should surface. */
export class PaymentProviderError extends DomainError {
  readonly status = 502
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'PaymentProviderError'
  }
}
