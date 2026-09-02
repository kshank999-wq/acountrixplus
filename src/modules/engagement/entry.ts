/**
 * What a timeline entry shows, and where each part of it came from (Phase 92).
 *
 * ## The letter the timeline points at and never reads
 *
 * Phase 22 built the communications log to answer the question
 * `transactional_messages` cannot: *what have we said to this client?* When a
 * letter goes to an address the CRM knows, `recordOutboundMail` files it on that
 * contact's timeline beside the phone calls somebody logged by hand — and it
 * stores the row's `transactional_message_id`, so the two are already joined in
 * the schema.
 *
 * Nothing ever followed the join. The readers use that column as a boolean —
 * `is not null` becomes `wasSentByTheSystem` — and the entry's own `body` is
 * **null for a letter that arrived**. So the timeline says "we sent them an
 * invoice on the 3rd" and cannot say what the invoice said.
 *
 * Until Phase 91 that was honest, because nobody kept the words. Phase 91 kept
 * them. The link has been there since Phase 22 and the text since Phase 91; this
 * is the phase that reads one through the other.
 *
 * ## The judgement: two sources, never blended
 *
 * An entry can carry two different texts:
 *
 * - a **note**, which is what a person at this company wrote down; and
 * - a **letter**, which is what this company sent to somebody else.
 *
 * The tempting shape is one `body` field that falls back from the first to the
 * second. It is wrong, and the reason is not tidiness. In a dispute — the case
 * a communications log exists for — *"what we told the customer"* and *"what our
 * salesperson wrote down about a call"* are different kinds of evidence, and
 * only one of them is something the customer also holds a copy of. A screen that
 * renders both as unlabelled body text lets one be read as the other.
 *
 * So an entry resolves to an ordered list of **labelled parts**, and a screen
 * cannot render one without saying which it is.
 *
 * ## Why a bounce shows both
 *
 * `recordOutboundMail` writes a note only when the letter did *not* arrive
 * ("The mail provider refused this address. Nobody has been told."). That is
 * exactly the entry where both parts matter: somebody needs to see that it
 * failed *and* what it was going to say, so they can decide whether to resend it
 * or telephone. The note comes first because it changes what the letter means.
 *
 * Nothing here touches the database or the clock.
 */

export type PartSource = 'note' | 'letter'

export type Part = {
  source: PartSource
  /** Shown to a reader, so the two can never be confused for one another. */
  label: string
  text: string
}

export const PART_LABELS: Record<PartSource, string> = {
  note: 'Noted here',
  letter: 'What we sent',
}

export type Entry = {
  /** `communications.body` — typed by a person, or written by the mailer. */
  note: string | null
  /** `transactional_messages.body` — the letter's own words, from Phase 91. */
  letter: string | null
  /** Whether this entry is a letter this application sent. */
  sentByTheSystem: boolean
}

/**
 * The parts of one entry, in reading order.
 *
 * The note first: on the only entries that have both, the note is the mailer
 * saying the letter did not arrive, and that changes what the letter below it
 * means.
 *
 * A letter is shown **only** when the entry is a system send. An entry somebody
 * logged by hand has no letter to show, and surfacing text from a row it merely
 * happens to reference would attribute words to this company that it never sent.
 */
export function partsOf(entry: Entry): Part[] {
  const parts: Part[] = []

  const note = entry.note?.trim()
  if (note) parts.push({ source: 'note', label: PART_LABELS.note, text: note })

  if (entry.sentByTheSystem) {
    const letter = entry.letter?.trim()
    if (letter) parts.push({ source: 'letter', label: PART_LABELS.letter, text: letter })
  }

  return parts
}

/**
 * Why there is nothing to read, when there is nothing to read.
 *
 * Three different silences, and telling them apart is worth a sentence each —
 * the same argument `explain()` makes in `mobile/decision`. A person looking at
 * an empty entry should not have to guess whether the letter is gone, was never
 * kept, or was never a letter at all.
 *
 * Returns null when there *is* something to read, so a caller renders the parts
 * or the sentence and never both.
 */
export function emptyBecause(entry: Entry): string | null {
  if (partsOf(entry).length > 0) return null

  if (!entry.sentByTheSystem) {
    // Somebody logged that a conversation happened and wrote no more than the
    // summary. That is a complete entry, not a missing one.
    return 'No more was written down.'
  }

  // Sent before Phase 91 kept the words, or swept by retention at a year.
  return 'This letter’s wording is no longer kept.'
}

/**
 * Whether an entry has a letter a reader could open.
 *
 * For a list that wants to show a control only where one would do something.
 */
export function hasLetter(entry: Entry): boolean {
  return partsOf(entry).some((part) => part.source === 'letter')
}
