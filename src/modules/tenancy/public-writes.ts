/**
 * Every write a stranger can reach (Phase 174).
 *
 * ## Why a register and not a sentence
 *
Three files kept this count in prose, and all three were wrong.
 *
 * `modules/crm/intake.ts` and its test both said *"this is the only
 * unauthenticated write path in the system"*; the acceptance route said *"the
 * second"*; and Phase 174's question route said *"the third"*. The answer is
 * **five**, because the scan written alongside this register immediately found
 * two nobody had ever written down: the unsubscribe link and the email webhook.
 *
 * Four stale sentences, none of them wrong in a way anything could detect.
 *
 * That is Phase 110's defect — a declaration argued from a fact that is not a
 * fact — and Phase 135's: a false sentence is exactly as long as a true one. The
 * fix is not a better sentence. It is to stop keeping the count in prose.
 *
 * ## What makes this list worth having
 *
 * Every entry here is a path where **the credential is not a session**. The
 * thing standing between it and abuse differs per entry and is the first thing
 * anybody reviewing one needs to know, so it is a field rather than a paragraph
 * somewhere.
 *
 * `tests/public-writes.test.ts` holds the register to the source in both
 * directions: an entry whose file does not exist is stale, and a route handler
 * that writes without an actor and is not declared here is the case the register
 * exists to catch.
 */

import { RegistryError } from '@/modules/errors/registry'

export type PublicWrite = {
  /** The module that decides whether the write may happen. */
  module: string
  /** What a stranger presents instead of a session. */
  credential: string
  /** Why that credential is enough, and what else stands behind it. */
  because: string
  /** The phase that opened this path. */
  phase: number
}

export const PUBLIC_WRITES: readonly PublicWrite[] = [
  {
    module: 'src/modules/crm/intake.ts',
    credential: 'A public intake key, issued per form and revocable.',
    because:
      'A lead form is published on a website, so it is the one path here that is *meant* to be ' +
      'found. Everything that makes it survivable is therefore in the module rather than in the ' +
      'credential: an origin allowlist, a per-key hourly limit, a honeypot field, and a ' +
      'truncated IP so the log cannot become a tracking record. It writes an organization, a ' +
      'contact and an opportunity — the widest blast radius of the three.',
    phase: 6,
  },
  {
    module: 'src/modules/crm/acceptance.ts',
    credential: 'The proposal’s 32-byte public token.',
    because:
      'Accepting a proposal is the most consequential thing a stranger can do in this system: it ' +
      'wins a deal, converts an opportunity and can raise an invoice. What makes the token ' +
      'sufficient is that the total is **recomputed server-side** from the client’s selection ' +
      'rather than taken from the payload, so the worst a tampered request can do is accept a ' +
      'different set of optional lines at their real prices.',
    phase: 77,
  },
  {
    module: 'src/modules/engagement/questions.ts',
    credential: 'The proposal’s 32-byte public token.',
    because:
      'A question writes prose onto a client’s timeline, so the risk is nuisance and storage ' +
      'rather than money. The token is the credential; a draft takes no questions at all, because ' +
      'a question on one means the token leaked; the limit is per proposal rather than per address, ' +
      'since a client behind a corporate gateway shares an address with their colleagues; and the ' +
      'refusals share one sentence so the endpoint cannot be used to tell a real token from a ' +
      'guess.',
    phase: 174,
  },
  {
    module: 'src/modules/marketing/engagement.ts',
    credential: 'A per-recipient unsubscribe token in the link.',
    because:
      'Found by this register\'s own scan, having never been written down anywhere. Unsubscribing ' +
      'is the one public write that a regulator expects to be *easy* — §19 and §10 both require ' +
      'suppression to work — so the token deliberately carries no session and the route refuses to ' +
      'distinguish an invalid token from one already used, for the same reason the question route ' +
      'does: a different answer per case is an oracle. It can only ever add a suppression, which ' +
      'is the narrowest blast radius of the five.',
    phase: 19,
  },
  {
    module: 'src/app/api/email/events/route.ts',
    credential: 'A shared secret in `Authorization: Bearer`, from the environment.',
    because:
      'The one entry whose decision is in the route rather than a module, and it is listed as the ' +
      'exception rather than tidied: a webhook\'s credential check *is* its HTTP envelope, and ' +
      'moving a bearer comparison into a module would add indirection without adding a test worth ' +
      'having. It refuses outright when `EMAIL_WEBHOOK_SECRET` is unset, which is the right ' +
      'default — an unconfigured webhook that accepted events would let anybody write delivery ' +
      'history for any recipient.',
    phase: 22,
  },
]

export function publicWriteFor(module: string): PublicWrite {
  const found = PUBLIC_WRITES.find((entry) => entry.module === module)
  if (found) return found

  throw new RegistryError({
    registry: 'PUBLIC_WRITES',
    key: module,
    message:
      `No unauthenticated write path is declared for "${module}". This register is the list of ` +
      'places a stranger can write to the database, and the reason it exists is that two files ' +
      'each kept the count in prose and both were wrong. A new one is an entry here with what ' +
      `stands between it and abuse. Declared: ${PUBLIC_WRITES.map((entry) => entry.module).join(', ')}.`,
  })
}

/**
 * Route handlers whose credential check is their own, with the reason.
 *
 * One entry, and it exists so the test below can assert that every *other*
 * public write delegates its decision to a module tests can drive directly.
 * Without this, the rule would have to be weakened to "most of them".
 */
export const INLINE_DECIDERS: readonly string[] = ['src/app/api/email/events/route.ts']

/**
 * Whether an entry still argues for itself.
 *
 * The `credential` and `because` floors are the Phase 101 device. The reason
 * they are high here is that this is the register somebody reads when deciding
 * whether a new public endpoint is safe, and "the token" is not an argument.
 */
export function publicWriteStands(entry: PublicWrite): string[] {
  const problems: string[] = []

  if (entry.because.length < 240) {
    problems.push(
      `${entry.module} does not say what stands behind its credential — "because" is ` +
        `${entry.because.length} characters, and this is the register somebody reads before ` +
        'adding the fourth one.',
    )
  }
  if (entry.credential.length < 20) {
    problems.push(`${entry.module} does not say what a stranger presents instead of a session.`)
  }

  return problems
}
