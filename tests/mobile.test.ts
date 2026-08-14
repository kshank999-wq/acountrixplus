import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactions,
  idempotencyKeys,
  journalEntries,
  journalLines,
  notificationLog,
  pushSubscriptions,
  sessions,
} from '@/db/schema'
import { createCompanyFixture, insertTransaction, addUserWithRole } from './helpers'
import {
  fingerprint,
  IdempotencyConflictError,
  isReplayableOperation,
  pruneIdempotencyKeys,
  runOnce,
} from '@/modules/mobile/idempotency'
import { applyOperation } from '@/modules/mobile/operations'
import {
  applyOutcome,
  backoffFor,
  classifyResponse,
  compact,
  discard,
  enqueue,
  MAX_ATTEMPTS,
  readyToSend,
  retryFailed,
  summarize,
  supersedes,
  type OutboxEntry,
} from '@/modules/mobile/outbox'
import { describeUserAgent, listDevices, registerDevice, revokeDevice } from '@/modules/mobile/devices'
import { createSession, resolveSession } from '@/modules/auth/session'
import { attachReceipt, detachReceipt, receiptsFor, uploadReceipt } from '@/modules/mobile/receipts'
import {
  notify,
  nudgeReviewQueue,
  preferences,
  REVIEW_NUDGE_THRESHOLD,
  setPreference,
  subscribe,
  unsubscribe,
} from '@/modules/mobile/notifications'
import { getPushProvider, MockPushProvider } from '@/modules/mobile/push-provider'
import { trialBalance } from '@/modules/ledger/balances'
import { historyFor } from '@/modules/audit'
import { PermissionError } from '@/modules/permissions'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { createProposal, sendProposal } from '@/modules/crm/proposals'
import { acceptProposal } from '@/modules/crm/acceptance'

/**
 * Phase 8: the mobile app (spec §3, §18, §19).
 *
 * The claim this phase has to earn is spec §19's: accounting operations are
 * idempotent. An offline queue is only a feature if replaying it is safe, and
 * "replay is safe" is a testable statement — see "replaying an operation" at
 * the top and "an offline session, end to end" at the bottom.
 */

const mockPush = getPushProvider('mock') as MockPushProvider

beforeEach(() => {
  mockPush.reset()
})

describe('replaying an operation', () => {
  it('does the work once, however many times it is sent', async () => {
    const fixture = await createCompanyFixture()
    const account = await fixture.account('6350')
    const transaction = await insertTransaction(fixture, {
      amountCents: -4_500,
      description: 'STAPLES 0142',
    })

    const key = crypto.randomUUID()
    const payload = { transactionId: transaction.id, chartAccountId: account.id }

    const first = await applyOperation(fixture.ctx, {
      key,
      operation: 'transaction.categorize',
      payload,
    })
    const second = await applyOperation(fixture.ctx, {
      key,
      operation: 'transaction.categorize',
      payload,
    })
    const third = await applyOperation(fixture.ctx, {
      key,
      operation: 'transaction.categorize',
      payload,
    })

    expect(first.executed).toBe(true)
    expect(second.executed).toBe(false)
    expect(third.executed).toBe(false)
    // The replays return the first result rather than an error or a null.
    expect(second.result).toEqual(first.result)

    // And the thing that actually matters: one journal entry, not three.
    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      )

    expect(entries).toHaveLength(1)
  })

  it('survives concurrent retries', async () => {
    const fixture = await createCompanyFixture()
    const account = await fixture.account('6350')
    const transaction = await insertTransaction(fixture, {
      amountCents: -1_200,
      description: 'SHELL OIL 8842',
    })

    const key = crypto.randomUUID()
    const payload = { transactionId: transaction.id, chartAccountId: account.id }

    // Six at once, which is what a phone reconnecting actually does.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        applyOperation(fixture.ctx, { key, operation: 'transaction.categorize', payload }),
      ),
    )

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const executed = fulfilled.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.executed,
    )

    // Exactly one did the work. The others either replayed its answer or were
    // told to retry because it had not committed yet — both are correct, and
    // neither posted a second entry.
    expect(executed).toHaveLength(1)

    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      )

    expect(entries).toHaveLength(1)
  })

  it('refuses a key reused with different arguments', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const fuel = await fixture.account('6800')
    const transaction = await insertTransaction(fixture, {
      amountCents: -900,
      description: 'STAPLES 0142',
    })

    const key = crypto.randomUUID()

    await applyOperation(fixture.ctx, {
      key,
      operation: 'transaction.categorize',
      payload: { transactionId: transaction.id, chartAccountId: office.id },
    })

    // A client bug, not a retry. Silently returning the first result would
    // discard this request without telling anyone.
    await expect(
      applyOperation(fixture.ctx, {
        key,
        operation: 'transaction.categorize',
        payload: { transactionId: transaction.id, chartAccountId: fuel.id },
      }),
    ).rejects.toThrow(IdempotencyConflictError)
  })

  it('fingerprints independently of key order', () => {
    expect(fingerprint('op', { a: 1, b: 2 })).toBe(fingerprint('op', { b: 2, a: 1 }))
    expect(fingerprint('op', { a: 1 })).toBe(fingerprint('op', { a: 1, b: undefined }))
    expect(fingerprint('op', { a: 1 })).not.toBe(fingerprint('op', { a: 2 }))
    expect(fingerprint('op', { a: 1 })).not.toBe(fingerprint('other', { a: 1 }))
    // Nesting and arrays are covered too, since payloads carry split lines.
    expect(fingerprint('op', { l: [{ x: 1, y: 2 }] })).toBe(
      fingerprint('op', { l: [{ y: 2, x: 1 }] }),
    )
  })

  it('scopes keys to a company', async () => {
    const ours = await createCompanyFixture()
    const theirs = await createCompanyFixture()

    const key = 'shared-key-value'

    await runOnce(ours.ctx, { key, operation: 'transaction.note', payload: { a: 1 } }, async () => ({
      who: 'ours',
    }))

    // The same key from another tenant is a different key. Anything else would
    // let one company's client stop another's operation from running.
    const theirOutcome = await runOnce(
      theirs.ctx,
      { key, operation: 'transaction.note', payload: { a: 2 } },
      async () => ({ who: 'theirs' }),
    )

    expect(theirOutcome.executed).toBe(true)
    expect(theirOutcome.result).toEqual({ who: 'theirs' })
  })

  it('rolls the key back when the work fails', async () => {
    const fixture = await createCompanyFixture()
    const key = crypto.randomUUID()

    await expect(
      runOnce(fixture.ctx, { key, operation: 'transaction.note', payload: {} }, async () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')

    // No key row survived, so a corrected retry is not locked out by the
    // failure — the key and the work commit together or not at all.
    const rows = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.companyId, fixture.companyId))

    expect(rows).toHaveLength(0)
  })

  it('records the operation and the actor on the key', async () => {
    const fixture = await createCompanyFixture()
    const account = await fixture.account('6350')
    const transaction = await insertTransaction(fixture, {
      amountCents: -500,
      description: 'STAPLES 0142',
    })

    const key = crypto.randomUUID()
    await applyOperation(fixture.ctx, {
      key,
      operation: 'transaction.categorize',
      payload: { transactionId: transaction.id, chartAccountId: account.id },
    })

    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))

    expect(row.operation).toBe('transaction.categorize')
    expect(row.userId).toBe(fixture.userId)
    expect(row.result).not.toBeNull()
  })

  it('prunes expired keys and leaves fresh ones', async () => {
    const fixture = await createCompanyFixture()

    await runOnce(
      fixture.ctx,
      { key: crypto.randomUUID(), operation: 'transaction.note', payload: {} },
      async () => ({ ok: true }),
    )

    expect(await pruneIdempotencyKeys(new Date(Date.now() - 60_000))).toBe(0)
    expect(await pruneIdempotencyKeys(new Date(Date.now() + 60_000))).toBe(1)
  })

  it('only accepts operations on the replayable list', () => {
    expect(isReplayableOperation('transaction.categorize')).toBe(true)
    // Nothing that posts money directly is queueable from a phone.
    expect(isReplayableOperation('journal.post')).toBe(false)
    expect(isReplayableOperation('period.close')).toBe(false)
    expect(isReplayableOperation('anything.else')).toBe(false)
  })
})

describe('the mobile API is the same door, not a different building', () => {
  it('attributes a queued categorization to the person, through the ordinary service', async () => {
    const fixture = await createCompanyFixture()
    const account = await fixture.account('6350')
    const transaction = await insertTransaction(fixture, {
      amountCents: -7_800,
      description: 'HOME DEPOT 6612',
    })

    await applyOperation(fixture.ctx, {
      key: crypto.randomUUID(),
      operation: 'transaction.categorize',
      payload: { transactionId: transaction.id, chartAccountId: account.id },
    })

    const history = await historyFor(fixture.ctx, 'bank_transaction', transaction.id)

    // Exactly what a browser categorization writes. Nothing in the record says
    // "from a phone", because nothing about the accounting is different.
    expect(history[0].action).toBe('transaction.categorize')
    expect(history[0].userId).toBe(fixture.userId)

    const balances = await trialBalance(fixture.ctx, {})
    expect(balances.isBalanced).toBe(true)
  })

  it('enforces permission the same way', async () => {
    const fixture = await createCompanyFixture()
    const readonly = await addUserWithRole(fixture, 'readonly')
    const account = await fixture.account('6350')
    const transaction = await insertTransaction(fixture, {
      amountCents: -100,
      description: 'STAPLES 0142',
    })

    await expect(
      applyOperation(readonly, {
        key: crypto.randomUUID(),
        operation: 'transaction.categorize',
        payload: { transactionId: transaction.id, chartAccountId: account.id },
      }),
    ).rejects.toThrow(PermissionError)
  })

  it('cannot reach another tenant with a foreign id', async () => {
    const ours = await createCompanyFixture()
    const theirs = await createCompanyFixture()

    const theirAccount = await theirs.account('6350')
    const ourTransaction = await insertTransaction(ours, {
      amountCents: -100,
      description: 'STAPLES 0142',
    })

    await expect(
      applyOperation(ours.ctx, {
        key: crypto.randomUUID(),
        operation: 'transaction.categorize',
        payload: { transactionId: ourTransaction.id, chartAccountId: theirAccount.id },
      }),
    ).rejects.toThrow()
  })

  it('applies a split through the same validation as the web', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const fuel = await fixture.account('6800')
    const transaction = await insertTransaction(fixture, {
      amountCents: -10_000,
      description: 'COSTCO 8811',
    })

    // The lines must sum to the parent — enforced in the service, not the API.
    await expect(
      applyOperation(fixture.ctx, {
        key: crypto.randomUUID(),
        operation: 'transaction.split',
        payload: {
          transactionId: transaction.id,
          lines: [
            { chartAccountId: office.id, amountCents: -6_000 },
            { chartAccountId: fuel.id, amountCents: -3_000 },
          ],
        },
      }),
    ).rejects.toThrow(/must match exactly/i)

    const applied = await applyOperation(fixture.ctx, {
      key: crypto.randomUUID(),
      operation: 'transaction.split',
      payload: {
        transactionId: transaction.id,
        lines: [
          { chartAccountId: office.id, amountCents: -6_000 },
          { chartAccountId: fuel.id, amountCents: -4_000 },
        ],
      },
    })

    expect(applied.result.lines).toBe(2)

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.companyId, fixture.companyId))

    // Two category lines and one bank line.
    expect(lines).toHaveLength(3)
  })
})

describe('the outbox', () => {
  const base = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
    id: overrides.id ?? 'entry-1',
    operation: overrides.operation ?? 'transaction.categorize',
    payload: overrides.payload ?? {},
    entityId: overrides.entityId ?? 'tx-1',
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    queuedAt: overrides.queuedAt ?? 1_000,
    nextAttemptAt: overrides.nextAttemptAt ?? 0,
    lastError: overrides.lastError,
  })

  it('collapses a superseded decision but keeps every receipt', () => {
    const first = enqueue([], {
      id: 'a',
      operation: 'transaction.categorize',
      entityId: 'tx-1',
      payload: { chartAccountId: 'office' },
      queuedAt: 1,
    })
    const second = enqueue(first, {
      id: 'b',
      operation: 'transaction.categorize',
      entityId: 'tx-1',
      payload: { chartAccountId: 'fuel' },
      queuedAt: 2,
    })

    // Changing your mind sends one answer, not two.
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe('b')

    const receipts = enqueue(
      enqueue([], {
        id: 'r1',
        operation: 'receipt.attach',
        entityId: 'tx-1',
        payload: {},
        queuedAt: 1,
      }),
      { id: 'r2', operation: 'receipt.attach', entityId: 'tx-1', payload: {}, queuedAt: 2 },
    )

    // Two photos of two receipts are two attachments.
    expect(receipts).toHaveLength(2)
    expect(supersedes('receipt.attach')).toBe(false)
  })

  it('does not collapse an entry that is already in flight', () => {
    const queue = [base({ id: 'a', status: 'sending' })]
    const next = enqueue(queue, {
      id: 'b',
      operation: 'transaction.categorize',
      entityId: 'tx-1',
      payload: {},
      queuedAt: 2,
    })

    // The in-flight one may already have reached the server.
    expect(next).toHaveLength(2)
  })

  it('sends at most one operation per entity, oldest first', () => {
    const queue = [
      base({ id: 'b', entityId: 'tx-1', queuedAt: 200 }),
      base({ id: 'a', entityId: 'tx-1', queuedAt: 100, operation: 'transaction.note' }),
      base({ id: 'c', entityId: 'tx-2', queuedAt: 150 }),
    ]

    const ready = readyToSend(queue, 1_000)

    // Two decisions about one transaction have to land in the order they were
    // made, so only the older of the pair goes this round.
    expect(ready.map((entry) => entry.id)).toEqual(['a', 'c'])
  })

  it('blocks an entity behind a parked entry', () => {
    const queue = [
      base({ id: 'a', entityId: 'tx-1', queuedAt: 100, status: 'failed' }),
      base({ id: 'b', entityId: 'tx-1', queuedAt: 200 }),
    ]

    // Sending b past a would reorder the person's decisions.
    expect(readyToSend(queue, 1_000)).toHaveLength(0)
  })

  it('respects the backoff window', () => {
    const queue = [base({ nextAttemptAt: 5_000 })]

    expect(readyToSend(queue, 4_000)).toHaveLength(0)
    expect(readyToSend(queue, 5_000)).toHaveLength(1)
  })

  it('backs off further on each attempt, then parks', () => {
    expect(backoffFor(1)).toBeLessThan(backoffFor(3))
    expect(backoffFor(3)).toBeLessThan(backoffFor(5))
    // Bounded: a queue that waits an hour between tries is a queue nobody
    // notices is broken.
    expect(backoffFor(99)).toBe(backoffFor(MAX_ATTEMPTS - 1))

    let entry = base()
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      entry = applyOutcome(entry, { kind: 'retry', error: 'offline' }, 0)
    }

    expect(entry.status).toBe('failed')
    expect(entry.attempts).toBe(MAX_ATTEMPTS)
  })

  it('parks a permanent failure immediately rather than retrying six times', () => {
    const entry = applyOutcome(base(), { kind: 'permanent', error: 'Period closed.' }, 0)

    expect(entry.status).toBe('failed')
    expect(entry.attempts).toBe(1)
    expect(entry.lastError).toBe('Period closed.')
  })

  it('tells a retryable response from a permanent one', () => {
    expect(classifyResponse(200).kind).toBe('ok')
    expect(classifyResponse(201).kind).toBe('ok')

    expect(classifyResponse(500).kind).toBe('retry')
    expect(classifyResponse(429).kind).toBe('retry')
    expect(classifyResponse(408).kind).toBe('retry')

    // The subtle one: 409 means two different things, told apart by the code.
    expect(classifyResponse(409, { code: 'in_flight' }).kind).toBe('retry')
    expect(classifyResponse(409, { code: 'key_conflict' }).kind).toBe('permanent')

    // The server understood and refused. Retrying is a slower way to fail.
    expect(classifyResponse(403).kind).toBe('permanent')
    expect(classifyResponse(404).kind).toBe('permanent')
    expect(classifyResponse(422).kind).toBe('permanent')
  })

  it('summarizes what the person needs to know', () => {
    const queue = [
      base({ id: 'a', status: 'pending' }),
      base({ id: 'b', status: 'sending' }),
      base({ id: 'c', status: 'failed' }),
      base({ id: 'd', status: 'done' }),
    ]

    const summary = summarize(queue)

    expect(summary).toMatchObject({ pending: 1, sending: 1, failed: 1, total: 3 })
    expect(summary.needsAttention).toBe(true)
    expect(summarize(compact(queue))).toMatchObject({ total: 3 })
    expect(summarize([base({ status: 'done' })]).needsAttention).toBe(false)
  })

  it('can retry or abandon parked work', () => {
    const queue = [base({ id: 'a', status: 'failed', attempts: 6, lastError: 'boom' })]

    const retried = retryFailed(queue, 9_000)
    expect(retried[0]).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: 9_000 })

    expect(discard(queue, 'a')).toHaveLength(0)
  })
})

describe('devices', () => {
  it('names a device from its user agent without fingerprinting it', () => {
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toMatchObject({
      label: 'iPhone',
      platform: 'ios',
    })
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel) Mobile')).toMatchObject({
      platform: 'android',
    })
    expect(describeUserAgent('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537')).toMatchObject({
      label: 'Chrome on Mac',
      platform: 'web',
    })
    expect(describeUserAgent(null).platform).toBe('web')
  })

  it('signs out one device and leaves the others alone', async () => {
    const fixture = await createCompanyFixture()

    const phone = await registerDevice({
      userId: fixture.userId,
      companyId: fixture.companyId,
      userAgent: 'Mozilla/5.0 (iPhone)',
    })
    const laptop = await registerDevice({
      userId: fixture.userId,
      companyId: fixture.companyId,
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537',
    })

    const phoneSession = await createSession(fixture.userId, fixture.companyId, phone.id)
    const laptopSession = await createSession(fixture.userId, fixture.companyId, laptop.id)

    expect(await resolveSession(phoneSession.cookieValue)).not.toBeNull()

    await revokeDevice(fixture.ctx, phone.id)

    // The lost phone is out immediately...
    expect(await resolveSession(phoneSession.cookieValue)).toBeNull()
    // ...and the laptop doing the revoking is untouched.
    expect(await resolveSession(laptopSession.cookieValue)).not.toBeNull()

    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, fixture.userId))

    expect(remaining.every((session) => session.deviceId !== phone.id)).toBe(true)
  })

  it('keeps a revoked device in the history rather than deleting it', async () => {
    const fixture = await createCompanyFixture()
    const phone = await registerDevice({ userId: fixture.userId, companyId: fixture.companyId })

    await revokeDevice(fixture.ctx, phone.id)

    // Absent from the list a person sees...
    expect(await listDevices(fixture.ctx)).toHaveLength(0)
    // ...but the audit trail can still say which device did what.
    const history = await historyFor(fixture.ctx, 'device', phone.id)
    expect(history[0]?.action).toBe('device.revoke')
  })

  it("refuses to revoke somebody else's device", async () => {
    const fixture = await createCompanyFixture()
    const colleague = await addUserWithRole(fixture, 'bookkeeper')

    const theirPhone = await registerDevice({
      userId: colleague.userId,
      companyId: fixture.companyId,
    })

    // Scoped to the acting user: this is not a way to lock a colleague out.
    await expect(revokeDevice(fixture.ctx, theirPhone.id)).rejects.toThrow(/not found/i)
  })

  it('leaves a session with no device working', async () => {
    const fixture = await createCompanyFixture()
    const legacy = await createSession(fixture.userId, fixture.companyId)

    // Every session created before Phase 8 is this shape.
    expect(await resolveSession(legacy.cookieValue)).not.toBeNull()
  })
})

describe('receipts', () => {
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

  it('lets a bookkeeper capture one without the brand-library permission', async () => {
    const fixture = await createCompanyFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    const asset = await uploadReceipt(bookkeeper, {
      filename: 'till.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    expect(asset.kind).toBe('document')
    expect(asset.companyId).toBe(fixture.companyId)
  })

  it('refuses a type that can carry script', async () => {
    const fixture = await createCompanyFixture()

    await expect(
      uploadReceipt(fixture.ctx, {
        filename: 'receipt.svg',
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg onload="alert(1)"/>'),
      }),
    ).rejects.toThrow(/Unsupported file type/i)
  })

  it('attaches idempotently, so replaying does not duplicate', async () => {
    const fixture = await createCompanyFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -3_400,
      description: 'HOME DEPOT 6612',
    })
    const asset = await uploadReceipt(fixture.ctx, {
      filename: 'till.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    await attachReceipt(fixture.ctx, transaction.id, asset.id)
    await attachReceipt(fixture.ctx, transaction.id, asset.id)
    await attachReceipt(fixture.ctx, transaction.id, asset.id)

    // The guarantee holds even for a client that lost its idempotency key.
    expect(await receiptsFor(fixture.ctx, transaction.id)).toHaveLength(1)
  })

  it("refuses another tenant's asset", async () => {
    const ours = await createCompanyFixture()
    const theirs = await createCompanyFixture()

    const transaction = await insertTransaction(ours, {
      amountCents: -100,
      description: 'STAPLES 0142',
    })
    const theirAsset = await uploadReceipt(theirs.ctx, {
      filename: 'till.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    await expect(
      attachReceipt(ours.ctx, transaction.id, theirAsset.id),
    ).rejects.toThrow(/not found/i)
  })

  it('keeps the file when an attachment is removed', async () => {
    const fixture = await createCompanyFixture()
    const transaction = await insertTransaction(fixture, {
      amountCents: -100,
      description: 'STAPLES 0142',
    })
    const asset = await uploadReceipt(fixture.ctx, {
      filename: 'till.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    await attachReceipt(fixture.ctx, transaction.id, asset.id)
    await detachReceipt(fixture.ctx, transaction.id, asset.id)

    expect(await receiptsFor(fixture.ctx, transaction.id)).toHaveLength(0)

    // Attaching to the wrong transaction is the common case; the photograph
    // must survive the correction.
    await attachReceipt(fixture.ctx, transaction.id, asset.id)
    expect(await receiptsFor(fixture.ctx, transaction.id)).toHaveLength(1)
  })
})

describe('notifications', () => {
  const subscription = (endpoint: string) => ({
    endpoint,
    p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbNZ4',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  })

  it('is on by default and off once switched off', async () => {
    const fixture = await createCompanyFixture()
    await subscribe(fixture.ctx, subscription('https://push.example/one'))

    const first = await notify({
      companyId: fixture.companyId,
      userId: fixture.userId,
      topic: 'invoice_paid',
      message: { title: 'Paid', body: 'An invoice was paid.' },
    })
    expect(first.sent).toBe(1)

    await setPreference(fixture.ctx, 'invoice_paid', false)

    const second = await notify({
      companyId: fixture.companyId,
      userId: fixture.userId,
      topic: 'invoice_paid',
      message: { title: 'Paid', body: 'Another invoice was paid.' },
    })
    expect(second.suppressed).toBe(true)
    expect(second.sent).toBe(0)

    // A different topic is unaffected: one switch does not silence the rest.
    const other = await notify({
      companyId: fixture.companyId,
      userId: fixture.userId,
      topic: 'proposal_decided',
      message: { title: 'Signed', body: 'A proposal was accepted.' },
    })
    expect(other.sent).toBe(1)
  })

  it('records every attempt, including the ones that sent nothing', async () => {
    const fixture = await createCompanyFixture()

    // No subscription at all.
    const none = await notify({
      companyId: fixture.companyId,
      userId: fixture.userId,
      topic: 'invoice_paid',
      message: { title: 'Paid', body: 'x' },
    })
    expect(none).toMatchObject({ sent: 0, suppressed: false })

    const rows = await db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.companyId, fixture.companyId))

    // "Why did I not get told about that" has an answer.
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('no_subscription')
  })

  it('drops a subscription the push service says is gone', async () => {
    const fixture = await createCompanyFixture()
    await subscribe(fixture.ctx, subscription('https://push.example/gone/abc'))

    const result = await notify({
      companyId: fixture.companyId,
      userId: fixture.userId,
      topic: 'invoice_paid',
      message: { title: 'Paid', body: 'x' },
    })

    expect(result.failed).toBe(1)

    // Nothing to recover and nothing to retry.
    const remaining = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.companyId, fixture.companyId))

    expect(remaining).toHaveLength(0)
  })

  it('counts failures for a service that is merely unwell', async () => {
    const fixture = await createCompanyFixture()
    await subscribe(fixture.ctx, subscription('https://push.example/fail/abc'))

    await notify({
      companyId: fixture.companyId,
      userId: fixture.userId,
      topic: 'invoice_paid',
      message: { title: 'Paid', body: 'x' },
    })

    const [row] = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.companyId, fixture.companyId))

    // Kept, not deleted: a bad afternoon is not a dead subscription.
    expect(row.failureCount).toBe(1)
    expect(row.disabledAt).toBeNull()
  })

  it('replaces rather than duplicates when a browser re-subscribes', async () => {
    const fixture = await createCompanyFixture()

    await subscribe(fixture.ctx, subscription('https://push.example/same'))
    await subscribe(fixture.ctx, subscription('https://push.example/same'))

    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.companyId, fixture.companyId))

    expect(rows).toHaveLength(1)

    await unsubscribe(fixture.ctx, 'https://push.example/same')
    expect(
      await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.companyId, fixture.companyId)),
    ).toHaveLength(0)
  })

  it('does not nudge about one transaction', async () => {
    const fixture = await createCompanyFixture()
    await subscribe(fixture.ctx, subscription('https://push.example/nudge'))

    const quiet = await nudgeReviewQueue({
      companyId: fixture.companyId,
      userId: fixture.userId,
      waiting: REVIEW_NUDGE_THRESHOLD - 1,
    })
    expect(quiet.sent).toBe(0)

    const loud = await nudgeReviewQueue({
      companyId: fixture.companyId,
      userId: fixture.userId,
      waiting: REVIEW_NUDGE_THRESHOLD,
    })
    expect(loud.sent).toBe(1)
    expect(mockPush.sent.at(-1)?.message.title).toContain(String(REVIEW_NUDGE_THRESHOLD))
  })

  it('lists every topic with its default', async () => {
    const fixture = await createCompanyFixture()
    const topics = await preferences(fixture.ctx)

    // Six since Phase 10 added `remittance_due` — a reminder about money owed
    // to an agency is not the same interruption as a review queue.
    expect(topics).toHaveLength(6)
    expect(topics.every((topic) => topic.enabled)).toBe(true)
  })
})

describe('the events that fire on their own', () => {
  it('tells the company when a client signs, without a person doing anything', async () => {
    const fixture = await createCompanyFixture()
    await subscribe(fixture.ctx, {
      endpoint: 'https://push.example/owner',
      p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbNZ4',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    })

    const organization = await createOrganization(fixture.ctx, { name: 'Harborview LLC' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Foundation work',
      expectedValueCents: 500_000,
    })
    const revenue = await fixture.account('4100')

    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Foundation proposal',
      items: [
        { description: 'Foundation', unitPriceCents: 500_000, chartAccountId: revenue.id },
      ],
    })
    await sendProposal(fixture.ctx, proposal.id)

    const result = await acceptProposal(proposal.publicToken, {
      signerName: 'Jo Harbor',
      signerEmail: 'jo@harborview.test',
      signatureText: 'Jo Harbor',
      agreed: true,
      selectedItemIds: [],
    })

    expect(result.ok).toBe(true)

    // Phase 10 moved this off the acceptance's critical path. The acceptance
    // now commits with an event beside it, and the worker delivers — so the
    // push arrives after a tick rather than during the signature.
    //
    // This is a stronger assertion than the one it replaces, because it goes
    // through the outbox, the relay, the queue, and the handler rather than a
    // direct call that could not fail visibly.
    expect(mockPush.sent).toHaveLength(0)

    const { runOnce } = await import('@/modules/worker/runner')
    await runOnce({ workerId: 'mobile-test' })

    // The whole reason the app is on a phone: this happened while nobody was
    // looking at a screen.
    expect(mockPush.sent).toHaveLength(1)
    expect(mockPush.sent[0].message.title).toContain('Jo Harbor')
    expect(mockPush.sent[0].message.url).toBe('/crm')
  })

  it('does not tell somebody who cannot see proposals', async () => {
    const fixture = await createCompanyFixture()
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')

    await subscribe(bookkeeper, {
      endpoint: 'https://push.example/bookkeeper',
      p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFbNZ4',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    })

    const organization = await createOrganization(fixture.ctx, { name: 'Harborview LLC' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Foundation work',
      expectedValueCents: 500_000,
    })
    const revenue = await fixture.account('4100')
    const proposal = await createProposal(fixture.ctx, {
      opportunityId: opportunity.id,
      title: 'Foundation proposal',
      items: [
        { description: 'Foundation', unitPriceCents: 500_000, chartAccountId: revenue.id },
      ],
    })
    await sendProposal(fixture.ctx, proposal.id)

    await acceptProposal(proposal.publicToken, {
      signerName: 'Jo Harbor',
      signerEmail: 'jo@harborview.test',
      signatureText: 'Jo Harbor',
      agreed: true,
      selectedItemIds: [],
    })

    // A bookkeeper has no `proposals:manage`, so a notification about a
    // signature is not theirs to receive — the same rule the workspace uses.
    expect(mockPush.sent.some((sent) => sent.endpoint.includes('bookkeeper'))).toBe(false)
  })
})

describe('an offline session, end to end', () => {
  /**
   * The scenario the whole phase exists for: six decisions made with no
   * signal, sent when the connection returns, and one of them sent twice
   * because the first response was lost.
   */
  it('applies a queue once and leaves the books balanced', async () => {
    const fixture = await createCompanyFixture()
    const office = await fixture.account('6350')
    const fuel = await fixture.account('6800')

    const transactions = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        insertTransaction(fixture, {
          amountCents: -(1_000 + index * 100),
          description: `MERCHANT ${index}`,
        }),
      ),
    )

    // What the phone queued, with the keys it generated at queue time.
    const queued = transactions.map((transaction, index) => ({
      key: crypto.randomUUID(),
      operation: 'transaction.categorize' as const,
      payload: {
        transactionId: transaction.id,
        chartAccountId: index % 2 === 0 ? office.id : fuel.id,
      },
    }))

    for (const entry of queued) await applyOperation(fixture.ctx, entry)

    // The connection dropped mid-response on two of them, so the phone retried
    // with the same keys.
    const replays = await Promise.all([
      applyOperation(fixture.ctx, queued[1]),
      applyOperation(fixture.ctx, queued[4]),
    ])

    expect(replays.every((replay) => !replay.executed)).toBe(true)

    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      )

    // Six decisions, six entries. Not eight.
    expect(entries).toHaveLength(6)

    const balances = await trialBalance(fixture.ctx, {})
    expect(balances.isBalanced).toBe(true)

    const reviewed = await db
      .select()
      .from(bankTransactions)
      .where(eq(bankTransactions.companyId, fixture.companyId))

    expect(reviewed.every((row) => row.reviewState === 'categorized')).toBe(true)
  })

  /**
   * A regression test for a deadlock this phase uncovered — and that predated
   * it.
   *
   * Every table has a foreign key to `companies`, so inserting an audit event
   * takes a `FOR KEY SHARE` lock on the company row. Journal numbering used to
   * take `FOR UPDATE` on that same row, so two concurrent postings each held
   * KEY SHARE and each waited for the other to release it. Two people
   * categorizing at the same moment was enough. See `nextEntryNumber`.
   */
  it('posts concurrently in one company without deadlocking', async () => {
    const fixture = await createCompanyFixture()
    const account = await fixture.account('6350')

    const transactions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        insertTransaction(fixture, {
          amountCents: -(100 + index),
          description: `CONCURRENT ${index}`,
        }),
      ),
    )

    const outcomes = await Promise.allSettled(
      transactions.map((transaction) =>
        applyOperation(fixture.ctx, {
          key: crypto.randomUUID(),
          operation: 'transaction.categorize',
          payload: { transactionId: transaction.id, chartAccountId: account.id },
        }),
      ),
    )

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true)

    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      )

    // Eight entries with eight distinct numbers: the lock still serializes
    // numbering, it just no longer fights the foreign keys.
    expect(entries).toHaveLength(8)
    expect(new Set(entries.map((entry) => entry.entryNumber)).size).toBe(8)
  })

  it('lets a rejected operation fail without stranding the rest', async () => {
    const fixture = await createCompanyFixture()
    const account = await fixture.account('6350')

    const good = await insertTransaction(fixture, {
      amountCents: -500,
      description: 'GOOD 1',
    })
    const alsoGood = await insertTransaction(fixture, {
      amountCents: -600,
      description: 'GOOD 2',
    })

    const outcomes = await Promise.allSettled([
      applyOperation(fixture.ctx, {
        key: crypto.randomUUID(),
        operation: 'transaction.categorize',
        payload: { transactionId: good.id, chartAccountId: account.id },
      }),
      // A transaction that no longer exists — deleted on the web while the
      // phone was offline.
      applyOperation(fixture.ctx, {
        key: crypto.randomUUID(),
        operation: 'transaction.categorize',
        payload: { transactionId: crypto.randomUUID(), chartAccountId: account.id },
      }),
      applyOperation(fixture.ctx, {
        key: crypto.randomUUID(),
        operation: 'transaction.categorize',
        payload: { transactionId: alsoGood.id, chartAccountId: account.id },
      }),
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ])

    // The two good ones landed. One bad entry does not strand the batch.
    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, fixture.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      )

    expect(entries).toHaveLength(2)
  })
})
