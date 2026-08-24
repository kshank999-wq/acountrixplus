import { describe, expect, it, vi } from 'vitest'
import { DomainError, messageFor } from '@/modules/errors'
import { FundError } from '@/modules/funds/service'
import { PermissionError } from '@/modules/permissions'
import { RateError } from '@/modules/fx/rates'

/**
 * What reaches a person after a `catch`.
 *
 * The case that produced this file: registering against an unreachable database
 * put the SQL *and the address somebody had just typed* on screen, while the
 * one useful fact — `ENOTFOUND` on the database host — stayed on the `cause`
 * where nobody saw it.
 */
describe('messageFor', () => {
  it('shows a refusal the application wrote on purpose', () => {
    const error = new FundError('That fund is already closed.')
    expect(messageFor(error, 'Could not update the fund.')).toBe('That fund is already closed.')
  })

  it('shows it for every deliberate error, not a hand-kept list', () => {
    // The three below are unrelated modules written phases apart. What they
    // have in common is being meant for a reader.
    expect(new FundError('x')).toBeInstanceOf(DomainError)
    expect(new PermissionError('accounting:journal')).toBeInstanceOf(DomainError)
    expect(new RateError('x')).toBeInstanceOf(DomainError)
  })

  it('is still an Error, so existing catch sites and tests are unaffected', () => {
    expect(new FundError('x')).toBeInstanceOf(Error)
  })

  it('hides a database error behind the caller’s sentence', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Shaped like the real one: postgres.js names the SQL, and puts the thing
    // that actually broke on `cause`.
    const query = 'select "id", "email", "password_hash" from "users" where "email" = $1'
    const failure = new Error(`Failed query: ${query} params: someone@example.com,1`)
    failure.cause = Object.assign(new Error('getaddrinfo ENOTFOUND db.example.supabase.co'), {
      code: 'ENOTFOUND',
    })

    expect(messageFor(failure, 'Could not create the company.')).toBe(
      'Could not create the company.',
    )

    spy.mockRestore()
  })

  it('leaks neither the query nor what somebody typed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const failure = new Error(
      'Failed query: select "password_hash" from "users" params: someone@example.com,1',
    )
    const shown = messageFor(failure, 'Could not sign in.')

    expect(shown).not.toContain('password_hash')
    expect(shown).not.toContain('someone@example.com')
    expect(shown).not.toContain('select')

    spy.mockRestore()
  })

  it('logs the cause chain, which is where the answer usually is', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const failure = new Error('Failed query: select 1')
    failure.cause = Object.assign(new Error('getaddrinfo ENOTFOUND db.example.supabase.co'), {
      code: 'ENOTFOUND',
    })

    messageFor(failure, 'Could not create the company.')

    const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).toContain('ENOTFOUND')
    expect(logged).toContain('db.example.supabase.co')
    expect(logged).toContain('Could not create the company.')

    spy.mockRestore()
  })

  it('handles something thrown that is not an Error at all', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(messageFor('a bare string', 'Could not do the thing.')).toBe('Could not do the thing.')
    expect(messageFor(undefined, 'Could not do the thing.')).toBe('Could not do the thing.')
    spy.mockRestore()
  })
})
