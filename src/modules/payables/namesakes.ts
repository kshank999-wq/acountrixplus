/**
 * Two records for one supplier (spec §13, §19, Phase 47).
 *
 * ## Found in the browser, in this phase's own demo
 *
 * The supplier dropdown offered **Delta Electrical twice**. Two vendor rows,
 * one supplier — and that is not a cosmetic problem, it is the thing that
 * defeats everything else this phase built.
 *
 * The duplicate rule is keyed on the vendor: the same supplier may not repeat
 * their own invoice number. Split that supplier across two records and the
 * same invoice entered against each is, to the rule, two suppliers using the
 * same number — which is the case the phase deliberately allows. The check at
 * the door is blind to exactly the duplicate it exists to stop, and the pair
 * finder never pairs them either.
 *
 * A split supplier is also its own problem without any of that: their balance,
 * their aging and their 1099 total are each half right, and a remittance goes
 * out for one record while the other still shows the debt.
 *
 * ## Warned, not refused
 *
 * Same reasoning as everywhere else in this phase. Two genuinely different
 * businesses can share a name — there is more than one "Smith & Sons" — and
 * refusing outright would leave somebody unable to record a supplier who
 * exists. So: an exact name match is a question, and the person typing it
 * answers.
 *
 * Nothing here touches the database.
 */

/**
 * A party name reduced to what it identifies.
 *
 * Case and spacing are noise: "delta electrical", "Delta  Electrical" and
 * "Delta Electrical " are one supplier. Punctuation is **kept**, because
 * "Smith & Sons" and "Smith and Sons" being told apart matters less than
 * "A.B.C." and "ABC" being told apart — and stripping it would start refusing
 * names that are genuinely different.
 */
export function normaliseName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

export type Namesake = { id: string; name: string }

/**
 * Whether a new party name is already on the books.
 *
 * Only exact matches after normalising. Nothing fuzzy: a near-match warning
 * fires on "Northern Supplies" versus "Northern Supply Co", which are usually
 * two companies, and a warning that is usually wrong is one people learn to
 * click through — taking the exact match with it.
 */
export function namesakeOf(name: string, existing: Namesake[]): Namesake | null {
  const key = normaliseName(name)
  if (key === '') return null

  return existing.find((party) => normaliseName(party.name) === key) ?? null
}

/** What a person reads, naming the record already there. */
export function describeNamesake(
  match: Namesake,
  kind: 'customer' | 'supplier',
): string {
  const consequence =
    kind === 'supplier'
      ? 'Two records for one supplier split their balance and their aging in two, and stop this ' +
        'system noticing when the same invoice is entered against both.'
      : 'Two records for one customer split their balance, their aging and their statement in two.'

  return `A ${kind} called ${match.name} is already on the books. ${consequence} Use the one that is there, or say this is a different business.`
}
