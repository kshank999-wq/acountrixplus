import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_BARE_REFUSALS,
  AUDIENCE_RULES,
  audienceOf,
} from '@/modules/errors/audience'
import { RegistryError, registryShaped } from '@/modules/errors/registry'
import { DomainError, Refusal, messageFor } from '@/modules/errors'

/**
 * Whether a refusal can be read by the person it refused (Phase 119).
 *
 * No database, no clock — it reads the source. This is the instrument the test
 * suite did not have: every other test calls a service directly and asserts on
 * the thrown message, which is exactly how 192 refusals sat for a hundred
 * phases arriving on screen as "Something went wrong."
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    // `.tsx` too, since Phase 120: a client component throws just as well as a
    // server action, and one of the 17 was in `src/app/m/receipt/capture.tsx`.
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

/** The message a reader would see: literals joined, interpolations as a word. */
function flatten(argument: string): string | null {
  const parts = argument.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)
  if (!parts) return null
  const text = parts.map((part) => part.slice(1, -1)).join(' ')
  return text.replace(/\$\{[^}]*\}/g, 'X').replace(/\s+/g, ' ').trim()
}

type Site = { file: string; line: number; message: string }

/**
 * Every `throw new Error(...)` left in the layers a person can reach, with its
 * sentence.
 *
 * `src/app` joined the scan in Phase 120. Phase 119 read `src/modules` only and
 * left 17 person-facing bare throws one directory over — 16 of them in
 * `src/app/actions/*.ts`, the very files that call `messageFor`.
 */
function bareThrows(): Site[] {
  const sites: Site[] = []
  for (const file of [...sourceFiles('src/modules'), ...sourceFiles('src/app')]) {
    const src = readFileSync(file, 'utf8')
    const opener = /throw new Error\(/g
    let match: RegExpExecArray | null
    while ((match = opener.exec(src))) {
      let i = opener.lastIndex
      let depth = 1
      let argument = ''
      while (i < src.length && depth > 0) {
        const c = src[i]
        if (c === '(') depth += 1
        else if (c === ')') depth -= 1
        if (depth > 0) argument += c
        i += 1
      }
      const message = flatten(argument)
      if (message === null) continue
      sites.push({ file, line: src.slice(0, match.index).split('\n').length, message })
    }
  }
  return sites
}

describe('what makes a message person-facing', () => {
  it('states an argument for every rule, not just a pattern', () => {
    for (const rule of AUDIENCE_RULES) {
      expect(rule.because.length, rule.name).toBeGreaterThan(80)
    }
  })

  it.each([
    'That is a vendor credit. It cannot be applied to an invoice.',
    'A cost code needs the job it belongs to. Choose a job as well.',
    'That change order was rejected. Raise a new one instead.',
    'Only X is held in retainage on this job.',
    'Say why it is being written off. An unexplained loss is worse than a loss.',
  ])('reads %j as written for a person', (message) => {
    expect(audienceOf(message)).toBe('person')
  })

  it.each([
    'Customer not found',
    'Deposit not found',
    'Unknown bank provider "X". Registered: X',
    'Not an RGB triplet: X',
    'One or more chart accounts were not found',
  ])('reads %j as written for an operator', (message) => {
    expect(audienceOf(message)).toBe('operator')
  })

  it('needs every rule, so no single one carries the verdict', () => {
    // A fragment that closes like a sentence but does not open like one, and
    // an opener with no close — each fails on exactly one rule.
    expect(audienceOf('invoices.balance_cents out of range.')).toBe('operator')
    expect(audienceOf('That invoice is voided')).toBe('operator')
    expect(audienceOf('Not found.')).toBe('operator')
  })
})

describe('the module layer, read as source', () => {
  const sites = bareThrows()

  it('finds throws to look at, so a broken scan cannot pass silently', () => {
    // If the parser ever stopped matching, every assertion below would pass on
    // an empty list. This is the guard against a green tripwire that reads
    // nothing.
    //
    // The floor was 50 when Phase 119 wrote it and 106 bare throws remained.
    // Phase 120 converted 74 `X not found` sites and the 17 in `src/app`,
    // leaving 31 — so the floor moved with them. It is a smoke test for the
    // scanner, not a budget for how many throws may exist.
    expect(sites.length).toBeGreaterThan(20)
  })

  // Keyed by the sentence rather than by line number: an allowlist that goes
  // stale the moment somebody adds an import above it is not an allowlist, it
  // is a trap.
  const key = (file: string, message: string) => `${file} ${message}`

  it('leaves no registry refusal thrown as a bare Error', () => {
    // The rule that replaced ten allowlist entries (Phase 132). A Phase 101
    // registry refuses an undeclared key with prose explaining what to
    // declare; `audienceOf` read that as a person's, so each registry bought
    // itself an exception, and the twelfth would have bought an eleventh.
    //
    // Both halves matter. This says a registry-shaped sentence must be a
    // `RegistryError`; the `maintainer` audience says it must not be shown.
    const bare = sites
      .filter((site) => registryShaped(site.message))
      .map((site) => `${site.file}:${site.line}  ${site.message}`)

    expect(bare).toEqual([])
  })

  it('leaves no person-facing sentence thrown as a bare Error', () => {
    const allowed = new Set(ALLOWED_BARE_REFUSALS.map((row) => key(row.file, row.message)))
    const unread = sites
      .filter((site) => audienceOf(site.message) === 'person')
      .filter((site) => !allowed.has(key(site.file, site.message)))
      .map((site) => `${site.file}:${site.line}  ${site.message}`)

    // Every one of these would reach a person as "Something went wrong."
    // Throw a `Refusal` instead, or argue for the exception in
    // ALLOWED_BARE_REFUSALS.
    expect(unread).toEqual([])
  })

  it('keeps every allowed exception pointing at a throw that is still there', () => {
    const bare = new Set(sites.map((site) => key(site.file, site.message)))
    const stale = ALLOWED_BARE_REFUSALS.filter(
      (row) => !bare.has(key(row.file, row.message)),
    ).map((row) => `${row.file}  ${row.message}`)

    // An allowlist that outlives what it excused is how a rule quietly stops
    // being one.
    expect(stale).toEqual([])
  })

  it('argues for each exception in the terms of who would read it', () => {
    for (const row of ALLOWED_BARE_REFUSALS) {
      expect(row.because.length, row.message).toBeGreaterThan(60)
    }
  })
})

describe('a Refusal reaches the person who caused it', () => {
  it('is shown, where a bare Error is replaced', () => {
    const sentence = 'That is a vendor credit. It cannot be applied to an invoice.'

    expect(messageFor(new Refusal(sentence), 'Something went wrong.')).toBe(sentence)
    expect(messageFor(new Error(sentence), 'Something went wrong.')).toBe(
      'Something went wrong.',
    )
  })

  it('is a DomainError, which is the whole mechanism', () => {
    expect(new Refusal('A count cannot be negative.')).toBeInstanceOf(DomainError)
  })

  it('still hides what was not written for a person', () => {
    // The half of ADR 0074 that was always right, and stays.
    const leak = 'Failed query: select "id", "password_hash" from "users" where email = $1'
    expect(messageFor(new Error(leak), 'Could not sign you in.')).toBe('Could not sign you in.')
  })
})
