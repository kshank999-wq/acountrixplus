import { describe, expect, it } from 'vitest'
import {
  DISCLOSING_WORDS,
  RECORD_KINDS,
  kindFor,
  missing,
} from '@/modules/errors/missing'
import { Refusal, messageFor } from '@/modules/errors'
import { audienceOf } from '@/modules/errors/audience'

/**
 * What "not found" is allowed to say (Phase 120). No database, no clock.
 *
 * 49 of the 74 `X not found` throws sat directly after a `scoped()` query, so
 * the message was answering two questions at once: *your link is stale*, and
 * *this system will not confirm whether that record exists in somebody else's
 * books.* The second is a security property, it was never written down, and the
 * friendly-sounding improvement — "that invoice belongs to another company" —
 * is a disclosure.
 */

describe('the record kinds', () => {
  it('names each one the way a screen does, not the way a table does', () => {
    for (const kind of RECORD_KINDS) {
      expect(kind.noun, kind.key).toMatch(/^[a-z][a-z -]*$/)
      // A table name would leak the schema and mean nothing to a bookkeeper.
      expect(kind.noun, kind.key).not.toMatch(/_/)
    }
  })

  it('records for each one whether the tenancy boundary is part of its answer', () => {
    // This is the fact that makes the wording load-bearing, so it is data
    // rather than a comment somewhere.
    const scoped = RECORD_KINDS.filter((kind) => kind.tenantScoped)
    expect(scoped.length).toBeGreaterThan(RECORD_KINDS.length / 2)
    for (const kind of RECORD_KINDS) {
      expect(kind.because.length, kind.key).toBeGreaterThan(80)
    }
  })

  it('has no duplicate keys, so a lookup has one answer', () => {
    const keys = RECORD_KINDS.map((kind) => kind.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('refuses a kind nobody declared', () => {
    // Phase 101's device: a new record type answers what to call it before a
    // lookup for it can fail politely.
    expect(() => kindFor('spaceship')).toThrow(/No record kind is declared/)
  })
})

describe('the sentence a failed lookup produces', () => {
  it('is a Refusal, so it reaches the person who clicked', () => {
    const refusal = missing('invoice')
    expect(refusal).toBeInstanceOf(Refusal)
    expect(messageFor(refusal, 'Something went wrong.')).toBe(refusal.message)
  })

  it('reads as written for a person, by the Phase 119 rules', () => {
    for (const kind of RECORD_KINDS) {
      expect(audienceOf(missing(kind.key).message), kind.key).toBe('person')
    }
  })

  it('says where the reader is and what to do', () => {
    expect(missing('invoice').message).toBe(
      'That invoice is not on these books. It may have been removed since this page was ' +
        'opened — reload and try again.',
    )
    expect(missing('costCodes', { plural: true }).message).toBe(
      'Some of those cost codes are not on these books. They may have been removed since ' +
        'this page was opened — reload and try again.',
    )
  })

  it('never says which of the three causes it was', () => {
    // Never existed, removed since the page was drawn, or belongs to another
    // company — the sentence is true of all three and distinguishes none.
    for (const kind of RECORD_KINDS) {
      for (const plural of [false, true]) {
        const text = missing(kind.key, { plural }).message.toLowerCase()
        for (const rule of DISCLOSING_WORDS) {
          expect(text, `${kind.key} / ${rule.word}`).not.toContain(rule.word)
        }
      }
    }
  })

  it('argues for each forbidden phrase rather than just listing it', () => {
    for (const rule of DISCLOSING_WORDS) {
      expect(rule.because.length, rule.word).toBeGreaterThan(80)
    }
  })

  it('says the same thing for a tenant-scoped kind as for an open one', () => {
    // If the two shapes differed, the difference would itself be the oracle.
    const scoped = RECORD_KINDS.find((kind) => kind.tenantScoped)!
    const openKind = RECORD_KINDS.find((kind) => !kind.tenantScoped)!

    const shape = (text: string, noun: string) => text.replace(noun, '<noun>')
    expect(shape(missing(scoped.key).message, scoped.noun)).toBe(
      shape(missing(openKind.key).message, openKind.noun),
    )
  })
})
