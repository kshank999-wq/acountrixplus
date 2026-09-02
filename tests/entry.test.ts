import { describe, expect, it } from 'vitest'
import {
  PART_LABELS,
  emptyBecause,
  hasLetter,
  partsOf,
  type Entry,
} from '@/modules/engagement/entry'

/**
 * What a timeline entry shows (Phase 92).
 *
 * The property the whole module exists for is the one asserted first: a note and
 * a letter are never blended into one unlabelled body. In a dispute — the case a
 * communications log exists for — "what we told the customer" and "what our
 * salesperson wrote down" are different kinds of evidence.
 */

function entry(over: Partial<Entry> = {}): Entry {
  return { note: null, letter: null, sentByTheSystem: false, ...over }
}

describe('partsOf', () => {
  it('shows a hand-written note as a note', () => {
    const parts = partsOf(entry({ note: 'Rang about the March invoice. Will pay Friday.' }))

    expect(parts).toEqual([
      {
        source: 'note',
        label: PART_LABELS.note,
        text: 'Rang about the March invoice. Will pay Friday.',
      },
    ])
  })

  it('shows a sent letter as a letter', () => {
    const parts = partsOf(
      entry({ letter: 'Your invoice is ready.', sentByTheSystem: true }),
    )

    expect(parts).toHaveLength(1)
    expect(parts[0].source).toBe('letter')
    expect(parts[0].text).toBe('Your invoice is ready.')
  })

  it('labels every part, so neither can be read as the other', () => {
    const parts = partsOf(
      entry({ note: 'Bounced.', letter: 'Your invoice is ready.', sentByTheSystem: true }),
    )

    expect(parts.map((part) => part.label)).toEqual([
      PART_LABELS.note,
      PART_LABELS.letter,
    ])
    expect(new Set(parts.map((part) => part.label)).size).toBe(2)
  })

  it('puts the note first on a bounce, because it changes what the letter means', () => {
    // The only entries carrying both are failed sends: the mailer's note says
    // it did not arrive, and the letter below is what nobody read.
    const parts = partsOf(
      entry({
        note: 'The mail provider refused this address. Nobody has been told.',
        letter: 'Your invoice is ready.',
        sentByTheSystem: true,
      }),
    )

    expect(parts.map((part) => part.source)).toEqual(['note', 'letter'])
  })

  /** The guard that stops words being attributed to a company that never sent them. */
  it('never shows a letter on an entry nobody sent', () => {
    const parts = partsOf(
      entry({ note: 'Met at the trade show.', letter: 'Your invoice is ready.' }),
    )

    expect(parts).toHaveLength(1)
    expect(parts[0].source).toBe('note')
  })

  it('treats whitespace as nothing written', () => {
    expect(partsOf(entry({ note: '   ' }))).toEqual([])
    expect(partsOf(entry({ letter: '\n\n', sentByTheSystem: true }))).toEqual([])
  })

  it('trims what it shows', () => {
    expect(partsOf(entry({ note: '  Rang about March.  ' }))[0].text).toBe(
      'Rang about March.',
    )
  })

  it('is empty when there is nothing at all', () => {
    expect(partsOf(entry())).toEqual([])
  })
})

describe('emptyBecause', () => {
  it('says nothing when there is something to read', () => {
    // So a caller renders the parts or the sentence, never both.
    expect(emptyBecause(entry({ note: 'Rang about March.' }))).toBeNull()
    expect(
      emptyBecause(entry({ letter: 'Your invoice is ready.', sentByTheSystem: true })),
    ).toBeNull()
  })

  it('distinguishes a complete short entry from a lost letter', () => {
    // Somebody logged a call and wrote no more than the summary. That is a
    // finished entry, not a missing one.
    const logged = emptyBecause(entry())
    // Sent before Phase 91 kept the words, or swept by retention at a year.
    const lost = emptyBecause(entry({ sentByTheSystem: true }))

    expect(logged).toBe('No more was written down.')
    expect(lost).toContain('no longer kept')
    expect(logged).not.toBe(lost)
  })

  it('calls a letter lost even when it was refused for the wrong reason', () => {
    // A system send whose note was whitespace is still a system send.
    expect(emptyBecause(entry({ note: '  ', sentByTheSystem: true }))).toContain(
      'no longer kept',
    )
  })
})

describe('hasLetter', () => {
  it('is true only where a reader could open something', () => {
    expect(hasLetter(entry({ letter: 'Words.', sentByTheSystem: true }))).toBe(true)
    // Points at a letter whose words are gone.
    expect(hasLetter(entry({ sentByTheSystem: true }))).toBe(false)
    // Has words on a row nobody sent.
    expect(hasLetter(entry({ letter: 'Words.' }))).toBe(false)
    expect(hasLetter(entry({ note: 'Rang about March.' }))).toBe(false)
  })
})

describe('the two sources are never blended', () => {
  /**
   * Asserted over the whole space rather than case by case: for every
   * combination of note, letter and origin, no part may carry text that came
   * from the other source.
   */
  const notes = [null, '', 'A note.']
  const letters = [null, '', 'A letter.']

  it('keeps each part’s text with its own source, in every combination', () => {
    for (const note of notes) {
      for (const letter of letters) {
        for (const sentByTheSystem of [true, false]) {
          const parts = partsOf(entry({ note, letter, sentByTheSystem }))

          for (const part of parts) {
            const expected = part.source === 'note' ? note : letter
            expect(part.text).toBe(expected?.trim())
          }

          // And a reader always has exactly one of the two things to render.
          const empty = emptyBecause(entry({ note, letter, sentByTheSystem }))
          expect(parts.length > 0).toBe(empty === null)
        }
      }
    }
  })
})
