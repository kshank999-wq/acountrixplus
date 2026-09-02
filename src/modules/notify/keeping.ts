/**
 * What of a letter is worth keeping (Phase 91).
 *
 * ## The letter nobody kept
 *
 * `sendTransactional` renders a letter's text and HTML, hands both to the
 * provider, and records the subject, the address, the outcome and the provider's
 * message id. **It does not record what the letter said.** The words exist for
 * the length of one function call and then only in somebody's inbox.
 *
 * For eighteen phases that was survivable, because every question asked of that
 * table was a delivery question — *did the mail go* — which the subject and the
 * outcome answer. Phase 90 made it not survivable: it gave the firm's brief a
 * decision record and told a person, on their own roster, that a letter was
 * sent. The obvious next question is *what did it say*, and the honest answer
 * was that nobody knows.
 *
 * Phase 90 also asserted, in an ADR and a schema comment, that the text was
 * "already in `transactional_messages`". That was wrong. It is corrected there
 * rather than quietly, because a wrong reason written down is worse than no
 * reason: the next person builds on it.
 *
 * ## The judgement: the body is what was said, the link is what it granted
 *
 * Keeping a letter verbatim is not free, and the reason is in `renderText`
 * itself — it appends `action.url` to the text. That URL is a **capability** in
 * every kind this application sends: a password reset's single-use token, an
 * invitation's join token, a signed invoice or statement link that anybody
 * holding it can open. Storing the rendered text would turn a 365-day delivery
 * log into a store of live credentials, readable by everybody who can read that
 * table.
 *
 * So the split is not per-kind. It is:
 *
 * - the **paragraphs** and the footnote are what a person was told, and are kept;
 * - the **action URL** is what the letter granted, and is never kept;
 * - the action's **label** is kept in the URL's place, so a reader can see there
 *   was a button without holding what it opened.
 *
 * Deliberately one rule rather than an allow-list of kinds that may be stored.
 * An allow-list is a thing to forget — the next `TransactionalKind` is added by
 * somebody who has not read this file, and forgetting to list it either loses a
 * letter or stores a token. A rule that holds for every kind has nothing to
 * forget.
 *
 * Nothing here touches the database or the clock.
 */

/** Stands where a link was, so a kept letter reads as a letter. */
export const OMITTED_LINK = '[link omitted]'

/**
 * How much of one letter is kept, in characters.
 *
 * Every body this application composes is bounded by construction — the longest
 * is a firm's brief, which names at most three clients. The cap is here for the
 * one that is not: a subject or a note carried in from a person's own typing.
 */
export const BODY_LIMIT = 20_000

export type Letter = {
  body: string[]
  action?: { label: string; url: string } | null
  footnote?: string | null
}

/**
 * The text to store: everything the letter said, and nothing it granted.
 *
 * Mirrors `renderText` paragraph for paragraph, deliberately — a stored letter
 * that reads differently from the one that arrived is worse than no stored
 * letter, because a person comparing the two would conclude that one of them
 * had been tampered with.
 *
 * Returns null when a letter said nothing, so "we kept nothing" and "there was
 * nothing to keep" are the same absent value rather than an empty string that a
 * screen would render as a blank panel.
 */
export function keptBodyFor(letter: Letter): string | null {
  const parts = letter.body.map((line) => line.trim()).filter((line) => line.length > 0)

  if (letter.action) {
    // The label, never the URL. A person re-reading this can see that the
    // letter offered them somewhere to go; they cannot go there twice.
    parts.push(`${letter.action.label}: ${OMITTED_LINK}`)
  }

  const footnote = letter.footnote?.trim()
  if (footnote) parts.push(footnote)

  if (parts.length === 0) return null

  return parts.join('\n\n').slice(0, BODY_LIMIT)
}

/**
 * Whether a stored body still holds something that looks like a link.
 *
 * Not a sanitiser — `keptBodyFor` is the only writer and it never emits one.
 * This is the assertion that lets a test say so about *every* letter this
 * application composes, rather than about the ones somebody remembered to check.
 */
export function holdsALink(kept: string | null): boolean {
  if (kept === null) return false
  return /https?:\/\//i.test(kept)
}
