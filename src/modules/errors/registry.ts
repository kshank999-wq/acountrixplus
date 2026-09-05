/**
 * How a registry refuses a key nobody declared (Phase 132).
 *
 * ## The defect, recorded three times before it was built
 *
 * Phase 101 set a device this codebase has used eleven times since: a registry
 * of named data where every entry carries the argument for itself, and a lookup
 * that **throws** on a key nobody declared rather than returning `undefined` —
 * because `undefined` lets somebody walk past the question the registry exists
 * to ask.
 *
 * Every one of those eleven throws a bare `Error` with a sentence explaining
 * what to declare. Phase 119's tripwire reads those sentences as prose written
 * for a person, which they are not, so each cost an entry in
 * `ALLOWED_BARE_REFUSALS`. Three ADRs recorded the same follow-up:
 *
 * | ADR | At | The sentence |
 * | --- | -- | --- |
 * | 0127 | eight | *the argument for a RegistryError subclass rather than an allowlist entry per registry* |
 * | 0128 | nine | *each new registry costs a tenth* |
 * | 0131 | ten | *it cost exactly what the ninth said the next one would* |
 *
 * Phase 31 taught and Phase 33 wrote down what a follow-up repeated across
 * consecutive ADRs usually means. Phase 130 acted on it at three. This is the
 * same shape, and the evidence is measured rather than argued: **ten entries
 * differing only in which registry they name.**
 *
 * ## The eleventh, which was never in the list
 *
 * Measuring for this phase found `policyFor` in `retention/policy.ts`, which
 * has thrown `No retention policy named X` since Phase 101 and has **no
 * allowlist entry at all**. Not because anybody argued it away — because the
 * sentence is a fragment, so `audienceOf` reads it as an operator's and the
 * rule never asked. The eleventh instance of the device was invisible to the
 * rule about the device, kept out by an accident of wording.
 *
 * Worse, the sixth allowlist entry names *"prompts, retention policies, record
 * kinds and falsifiers"* as the five that came before it. Retention policies
 * were never there. That is the Phase 110 failure again — a declaration argued
 * from a fact that is not a fact — in the registry whose whole purpose is to be
 * trusted.
 *
 * ## Why a class here, when `Refusal` argued against classes
 *
 * `Refusal`'s own prose refuses this move, and it is right to:
 *
 * > Inventing twenty-four module classes to fix that would add twenty-four
 * > things to import and nothing to catch — the ceremony of a type system
 * > without the use of one.
 *
 * Three things make this the opposite case. It is **one** class, not
 * twenty-four. It **subtracts** ceremony — ten allowlist entries go, and the
 * twelfth registry costs nothing. And there is something that catches it:
 * `tests/refusal-audience.test.ts`, which matched these by file and message
 * text and now matches them by shape. A type read by a scanner is still a type
 * being used.
 *
 * ## What it does not change
 *
 * It does not extend `DomainError`, so nothing reaches a screen that did not
 * before. An undeclared key is a defect in this repository, not something a
 * person did, and ADR 0074's deny-by-default is exactly right for it. The
 * sentences are carried through verbatim for the same reason: each was written
 * to tell a maintainer what to declare, and several are quoted in tests.
 */

/**
 * A lookup refused because nothing declares the key.
 *
 * `registry` and `key` are carried beside the sentence rather than only inside
 * it, so a log line can say which registry and which key without parsing prose
 * — the one capability the bare `Error`s never had.
 */
export class RegistryError extends Error {
  /** The registry that was asked, by the name it has in the source. */
  readonly registry: string
  /** What it was asked for. */
  readonly key: string

  constructor(input: { registry: string; key: string; message: string }) {
    super(input.message)
    this.name = 'RegistryError'
    this.registry = input.registry
    this.key = input.key
  }
}

/**
 * What makes a thrown sentence a registry's refusal rather than a person's.
 *
 * A heuristic, and stated as one — the same standing as `AUDIENCE_RULES`, and
 * for the same reason: its job is to be a tripwire's rule, so the twelfth
 * registry is caught by the rule instead of costing an entry in a list.
 *
 * Each shape carries the argument for itself, on the Phase 101 device. A bare
 * list of regular expressions is a fact that looks the same whether it is right
 * or wrong.
 */
export type RegistryShape = {
  name: string
  because: string
  matches: (message: string) => boolean
}

export const REGISTRY_SHAPES: readonly RegistryShape[] = [
  {
    name: 'nothing is declared for this key',
    because:
      'The phrasing eight of the eleven arrived at independently — "No currency carrier is ' +
      'declared for", "No falsifier is declared for", "No basis is declared for". It names the ' +
      'thing that is missing and the key that wanted it, which is what a maintainer needs and ' +
      'what nobody would write for somebody who had clicked a button.',
    matches: (message) => /^No .+?\bis declared\b/i.test(message.trim()),
  },
  {
    name: 'nothing declares how this behaves',
    because:
      'The active voice of the same sentence, used by the two ledger registries: "Nothing ' +
      'declares how a payment settles a document." The subject is the registry rather than the ' +
      'entry, and the reader is still whoever is adding the kind that has no entry.',
    matches: (message) => /^Nothing declares\b/i.test(message.trim()),
  },
  {
    name: 'nothing is registered or named for this key',
    because:
      'The two that predate the phrasing above and were left alone: "No prompt registered for" ' +
      'and "No retention policy named". The second is why this shape is here at all — it is a ' +
      'fragment, so the audience rules read it as an operator\'s and it has sat outside the ' +
      'allowlist since Phase 101 while ten of its siblings each argued their way in.',
    matches: (message) => /^No .+?\b(registered|named)\b/i.test(message.trim()),
  },
]

/**
 * Whether a sentence is a registry refusing an undeclared key.
 *
 * **Any** shape is enough, unlike `audienceOf`, which requires every rule. That
 * asymmetry is deliberate and worth saying out loud: `audienceOf` is looking
 * for evidence that somebody wrote prose, so each rule is weak alone and they
 * accumulate. This is looking for one specific sentence a registry writes, and
 * the three forms above are that sentence in the three voices it has been
 * written in. A message matching any of them is not a borderline case.
 *
 * ## What this deliberately does not match
 *
 * `Unknown bank provider "x". Registered: mock` and its five siblings —
 * payments, payroll, push, email, object storage. They look like the same
 * device and are not, and the line between them is where the key comes from:
 *
 * - A **registry** key is a literal in this repository. Nobody but a developer
 *   editing the source can produce one that is undeclared, so the sentence is
 *   addressed to a maintainer.
 * - A **provider** key comes from configuration. An operator can produce an
 *   unknown one by typing it into an environment variable, and the sentence
 *   they need names the variable and lists what is registered.
 *
 * They stay `operator`, which is what they have always been and what ADR 0074
 * is for.
 */
export function registryShaped(message: string): boolean {
  return REGISTRY_SHAPES.some((shape) => shape.matches(message))
}
