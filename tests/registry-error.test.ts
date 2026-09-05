import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REGISTRY_SHAPES,
  RegistryError,
  registryShaped,
} from '@/modules/errors/registry'
import { ALLOWED_BARE_REFUSALS, audienceOf } from '@/modules/errors/audience'
import { DomainError, messageFor } from '@/modules/errors'

/**
 * One answer to how a registry refuses (Phase 132).
 *
 * No database, no clock — it reads the source, like the tripwire it belongs to.
 *
 * Ten allowlist entries said the same thing ten ways, one per registry, and
 * three ADRs recorded the follow-up before anything was done about it. What
 * makes this more than tidying is the eleventh: `policyFor` has thrown since
 * Phase 101 and was never in the list, because its sentence is a fragment and
 * the audience rules read it as an operator's.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

/** Every `new RegistryError({ registry: 'X', … })` in the module layer. */
function thrownRegistries(): { file: string; registry: string }[] {
  const found: { file: string; registry: string }[] = []
  for (const file of sourceFiles('src/modules')) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/new RegistryError\(\{\s*registry: '(\w+)'/g)) {
      found.push({ file, registry: m[1] })
    }
  }
  return found
}

describe('what a registry refusal is', () => {
  it('carries the registry and the key beside the sentence', () => {
    const error = new RegistryError({
      registry: 'CURRENCY_CARRIERS',
      key: 'journal_lines',
      message: 'No currency carrier is declared for "journal_lines".',
    })

    // The one capability the bare Errors never had: a log line can say which
    // registry and which key without parsing prose.
    expect(error.registry).toBe('CURRENCY_CARRIERS')
    expect(error.key).toBe('journal_lines')
    expect(error.name).toBe('RegistryError')
    expect(error.message).toBe('No currency carrier is declared for "journal_lines".')
  })

  it('stays hidden from whoever is using the application', () => {
    // The half of ADR 0074 that must not move. An undeclared key is a defect in
    // this repository, not something a person did, and the sentence names files
    // to go and edit. `Refusal` extends `DomainError` and is shown; this does
    // not and is not.
    const error = new RegistryError({
      registry: 'FALSIFIERS',
      key: 'banking.cash_tie_out',
      message: 'No falsifier is declared for the check "banking.cash_tie_out".',
    })

    expect(error).not.toBeInstanceOf(DomainError)
    expect(messageFor(error, 'Something went wrong.')).toBe('Something went wrong.')
  })
})

describe('the shape a registry writes in', () => {
  it('argues each shape from the sentences that use it', () => {
    for (const shape of REGISTRY_SHAPES) {
      expect(shape.because.length, shape.name).toBeGreaterThan(140)
    }
  })

  it.each([
    'No currency carrier is declared for "invoices". Say whose currency it is.',
    'No falsifier is declared for the check "x". A check has to say what would make it disagree.',
    'No basis is declared for Row in board.tsx. Money reaching a screen has to say what it is.',
    'Nothing declares how a payment settles a document.',
    'Nothing declares how a credit_note moves accounts_receivable.',
    'No prompt registered for "bookkeeping.categorize"',
    'No retention policy named background_jobs',
  ])('reads %j as a registry refusing a key', (message) => {
    expect(registryShaped(message)).toBe(true)
    expect(audienceOf(message)).toBe('maintainer')
  })

  /**
   * The line that keeps the new rule from swallowing six sentences that are
   * not this.
   *
   * A provider key comes from configuration — an operator can produce an
   * unknown one by typing it into an environment variable — and the sentence
   * they need lists what is registered. A registry key is a literal in this
   * repository and only a developer can produce an undeclared one. They look
   * alike and are addressed to different people.
   */
  it.each([
    'Unknown bank provider "x". Registered: mock',
    'Unknown payment provider "x". Registered: mock',
    'Unknown transactional email provider "x". Available: mock, http.',
    'Unknown object store "x". Registered: filesystem',
    'Unknown AI provider "x". Registered: mock',
    'Unknown module: x',
  ])('leaves %j to the operator it was written for', (message) => {
    expect(registryShaped(message)).toBe(false)
    expect(audienceOf(message)).not.toBe('maintainer')
  })

  it('still tells a person’s sentence from an operator’s', () => {
    // The Phase 119 classifier, unchanged underneath the new question.
    expect(audienceOf('That is a vendor credit. It cannot be applied to an invoice.')).toBe(
      'person',
    )
    expect(audienceOf('Customer not found')).toBe('operator')
  })
})

describe('every registry refuses the same way', () => {
  const thrown = thrownRegistries()

  it('finds the throws to check, so a broken scan cannot pass silently', () => {
    // Measured, not bounded (Phase 126's lesson). Eleven: ten that each held an
    // allowlist entry, plus RETENTION_POLICIES, which held none and was found
    // by measuring for this phase rather than by reading the list.
    expect(thrown.length).toBe(11)
  })

  it('names a registry that is really exported from the file it throws in', () => {
    // Both directions of the Phase 116 device, applied to this phase's own
    // work: a typo in the registry name would sail through typechecking and
    // put a word in a log that names nothing.
    const wrong = thrown
      .filter(({ file, registry }) => !readFileSync(file, 'utf8').includes(`const ${registry}`))
      .map(({ file, registry }) => `${file} names ${registry}`)

    expect(wrong).toEqual([])
  })

  it('includes the one that was never in the allowlist', () => {
    expect(thrown.map((row) => row.registry)).toContain('RETENTION_POLICIES')
  })

  it('leaves an exception list that is genuinely miscellaneous', () => {
    // Twenty-one entries, ten of them one pattern, is a rule with a category
    // missing rather than a rule with exceptions. What is left is configuration,
    // crypto envelopes and invariants — no two alike.
    expect(ALLOWED_BARE_REFUSALS.length).toBe(11)
    expect(ALLOWED_BARE_REFUSALS.filter((row) => registryShaped(row.message))).toEqual([])
  })
})
