import { describe, expect, it } from 'vitest'
import {
  blockedMessage,
  GUARD_COOLOFF_MINUTES,
  GUARD_MAX_ATTEMPTS,
  standingFrom,
  warningLetter,
  type GuardAttempt,
} from '@/modules/auth/guard-attempts'

/**
 * Counting the guessing at a guarded act (Phase 100).
 *
 * The property that matters most is what this core does *not* touch: signing
 * in. Putting these failures in `login_attempts` would have let five fumbles on
 * the security page lock the account out of the sign-in form, which hands
 * somebody holding a session a way to lock the real owner out. That is asserted
 * where it can be — in the database tests — and the shape here keeps the count
 * per act so it cannot leak.
 */

const NOW = new Date('2026-09-03T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

const fails = (count: number, from = 0): GuardAttempt[] =>
  Array.from({ length: count }, (_, i) => ({
    act: 'address.claim' as const,
    ok: false,
    at: minutesAgo(from + i),
  }))

describe('standing', () => {
  it('is open with nothing against it', () => {
    expect(standingFrom([], { now: NOW })).toEqual({
      blocked: false,
      failedCount: 0,
      retryAfter: null,
      shouldWarn: false,
    })
  })

  it('counts failures without blocking under the limit', () => {
    const standing = standingFrom(fails(GUARD_MAX_ATTEMPTS - 1), { now: NOW })

    expect(standing.blocked).toBe(false)
    expect(standing.failedCount).toBe(GUARD_MAX_ATTEMPTS - 1)
  })

  it('blocks at the limit and says when it opens again', () => {
    const standing = standingFrom(fails(GUARD_MAX_ATTEMPTS), { now: NOW })

    expect(standing.blocked).toBe(true)
    expect(standing.retryAfter).toEqual(
      new Date(minutesAgo(GUARD_MAX_ATTEMPTS - 1).getTime() + GUARD_COOLOFF_MINUTES * 60_000),
    )
  })

  it('is cleared by getting it right', () => {
    // Somebody who mistyped four times and then remembered is not held for a
    // quarter of an hour. `lockoutState`'s shape, deliberately.
    const attempts: GuardAttempt[] = [
      { act: 'address.claim', ok: true, at: minutesAgo(0) },
      ...fails(GUARD_MAX_ATTEMPTS + 3, 1),
    ]

    expect(standingFrom(attempts, { now: NOW })).toMatchObject({
      blocked: false,
      failedCount: 0,
    })
  })

  it('forgets failures older than the window', () => {
    const stale = fails(GUARD_MAX_ATTEMPTS, GUARD_COOLOFF_MINUTES + 1)
    expect(standingFrom(stale, { now: NOW }).failedCount).toBe(0)
  })

  it('counts only the failures inside the window, not the run before it', () => {
    const attempts = [...fails(2), ...fails(9, GUARD_COOLOFF_MINUTES + 5)]
    expect(standingFrom(attempts, { now: NOW })).toMatchObject({
      blocked: false,
      failedCount: 2,
    })
  })
})

describe('warning the owner', () => {
  it('warns exactly as the count crosses the limit', () => {
    expect(standingFrom(fails(GUARD_MAX_ATTEMPTS), { now: NOW }).shouldWarn).toBe(true)
  })

  it('does not warn again while it stays over', () => {
    // A mailbox full of one sentence is a mailbox nobody reads.
    for (const extra of [1, 2, 5]) {
      expect(standingFrom(fails(GUARD_MAX_ATTEMPTS + extra), { now: NOW }).shouldWarn).toBe(false)
    }
  })

  it('does not warn under the limit', () => {
    expect(standingFrom(fails(GUARD_MAX_ATTEMPTS - 1), { now: NOW }).shouldWarn).toBe(false)
  })

  it('writes a letter that names the act and carries no link', () => {
    const letter = warningLetter({
      act: 'mfa.recovery_codes',
      failedCount: GUARD_MAX_ATTEMPTS,
      companyName: 'Hartley & Co',
    })

    expect(letter.subject).toContain('Hartley & Co')
    const body = letter.body.join(' ')
    expect(body).toContain('replace the codes')
    expect(body).toContain('only reachable from a signed-in session')

    // Phase 98's rule: a letter warning that a session may be in the wrong
    // hands must not also carry a way to act on the account.
    expect(body).not.toMatch(/https?:\/\//)
  })

  it('tells them what to actually do', () => {
    const body = warningLetter({
      act: 'address.claim',
      failedCount: 6,
      companyName: 'Hartley & Co',
    }).body.join(' ')

    expect(body).toContain('change your password')
    expect(body).toContain('end the other sessions')
  })
})

describe('what the person guessing reads', () => {
  it('says how long, and that the account is untouched', () => {
    const standing = standingFrom(fails(GUARD_MAX_ATTEMPTS), { now: NOW })
    const message = blockedMessage(standing, NOW)

    expect(message).toContain(`${GUARD_MAX_ATTEMPTS} wrong ones`)
    expect(message).toContain('minutes')
    // The honest worry at that moment is that guessing has locked them out of
    // everything. It has not, and saying so is the point.
    expect(message).toContain('You can still sign in as normal')
  })

  it('counts a single remaining minute as one minute', () => {
    const standing = standingFrom(fails(GUARD_MAX_ATTEMPTS), { now: NOW })
    const nearlyOver = new Date((standing.retryAfter as Date).getTime() - 30_000)

    expect(blockedMessage(standing, nearlyOver)).toContain('in 1 minute.')
  })
})
