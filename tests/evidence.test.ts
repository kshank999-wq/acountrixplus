import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, documentBlobs, documentBytes, documents, recordNotes } from '@/db/schema'
import { createCompanyFixture, insertTransaction, addUserWithRole } from './helpers'
import { PermissionError } from '@/modules/permissions'
import {
  DatabaseObjectStore,
  FilesystemObjectStore,
  digestOf,
  sweepOrphanedBlobs,
  type ObjectStore,
} from '@/modules/evidence/store'
import {
  attachDocument,
  deleteDocument,
  detachDocument,
  evidenceCounts,
  evidenceFor,
  evidenceForMany,
  listDocuments,
  MAX_EVIDENCE_BYTES,
  readDocument,
  storeDocument,
  usesOf,
  withoutEvidence,
} from '@/modules/evidence/service'
import {
  noteCounts,
  notesFor,
  openQuestions,
  resolveNote,
  writeNote,
} from '@/modules/evidence/notes'
import { NoSuchSubjectError } from '@/modules/evidence/subjects'
import { createInvoice, createCustomer } from '@/modules/receivables/service'
import { registerAsset } from '@/modules/assets/service'
import { attachReceipt, receiptsFor, uploadReceipt } from '@/modules/mobile/receipts'

/**
 * Attachments and accountant notes (spec §13, §18, Phase 20).
 *
 * Two claims under test:
 *
 *   **The same bytes are stored once, and removing one reference never breaks
 *   another.** Content addressing is only a saving if the delete path is
 *   right; get it wrong and one company's tidy-up destroys another's evidence.
 *
 *   **A document is reachable only through a record you may read.** The object
 *   store is deliberately *not* partitioned by tenant, so every guarantee rests
 *   on the `documents` lookup and the subject registry.
 */

const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n${marker}\n%%EOF`)
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

const temporaryDirectories: string[] = []

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('the object store', () => {
  it('addresses bytes by what they are', () => {
    expect(digestOf(pdf('a'))).toBe(digestOf(pdf('a')))
    expect(digestOf(pdf('a'))).not.toBe(digestOf(pdf('b')))
    expect(digestOf(pdf('a'))).toHaveLength(64)
  })

  it('round-trips through both adapters, and putting twice is a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evidence-'))
    temporaryDirectories.push(directory)

    const adapters: ObjectStore[] = [
      new DatabaseObjectStore(),
      new FilesystemObjectStore(directory),
    ]

    for (const store of adapters) {
      const data = pdf(`adapter-${store.key}`)
      const digest = digestOf(data)

      await store.put(digest, data, 'application/pdf')
      // Idempotent: a retry after a half-finished upload costs nothing.
      await store.put(digest, data, 'application/pdf')

      expect(await store.get(digest)).toEqual(data)

      await store.delete(digest)
      expect(await store.get(digest)).toBeNull()
      // Deleting what is not there is not an error, or a crash mid-cleanup
      // would leave the system unable to finish cleaning up.
      await store.delete(digest)
    }
  })

  it('reports nothing for bytes it does not hold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evidence-'))
    temporaryDirectories.push(directory)

    const store = new FilesystemObjectStore(directory)
    expect(await store.get(digestOf(pdf('never-written')))).toBeNull()
  })
})

describe('one file, stored once', () => {
  it('returns the same document when the same bytes arrive twice', async () => {
    const fixture = await createCompanyFixture({ name: 'Dedup Co' })
    const bytes = pdf('supplier-invoice-8841')

    const first = await storeDocument(fixture.ctx, {
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })
    const second = await storeDocument(fixture.ctx, {
      filename: 'invoice-copy.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })

    expect(second.id).toBe(first.id)
    expect(second.deduplicated).toBe(true)
    // The name of the row that already existed, not the one just offered:
    // renaming is a separate act from re-uploading.
    expect(second.filename).toBe('invoice.pdf')

    expect(await listDocuments(fixture.ctx)).toHaveLength(1)

    const [blob] = await db
      .select()
      .from(documentBlobs)
      .where(eq(documentBlobs.digest, digestOf(bytes)))
    expect(blob.referenceCount).toBe(1)
  })

  it('shares bytes between companies and counts each of them', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Co' })
    const bytes = pdf('the-same-government-form')

    await storeDocument(ours.ctx, {
      filename: 'form.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })
    await storeDocument(theirs.ctx, {
      filename: 'form.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })

    const [blob] = await db
      .select()
      .from(documentBlobs)
      .where(eq(documentBlobs.digest, digestOf(bytes)))

    expect(blob.referenceCount).toBe(2)
    expect(
      await db.select().from(documentBytes).where(eq(documentBytes.digest, digestOf(bytes))),
    ).toHaveLength(1)
  })

  it('never breaks one company by deleting the other', async () => {
    const ours = await createCompanyFixture({ name: 'Deleter Co' })
    const theirs = await createCompanyFixture({ name: 'Keeper Co' })
    const bytes = pdf('shared-evidence')
    const digest = digestOf(bytes)

    const mine = await storeDocument(ours.ctx, {
      filename: 'shared.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })
    const yours = await storeDocument(theirs.ctx, {
      filename: 'shared.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })

    expect(await deleteDocument(ours.ctx, mine.id)).toBe(true)

    // The whole claim: their copy still downloads.
    const read = await readDocument(theirs.companyId, yours.id)
    expect(read?.data).toEqual(bytes)

    const [blob] = await db
      .select()
      .from(documentBlobs)
      .where(eq(documentBlobs.digest, digest))
    expect(blob.referenceCount).toBe(1)

    // And when the last one goes, the bytes go too.
    expect(await deleteDocument(theirs.ctx, yours.id)).toBe(true)
    expect(
      await db.select().from(documentBlobs).where(eq(documentBlobs.digest, digest)),
    ).toHaveLength(0)
    expect(
      await db.select().from(documentBytes).where(eq(documentBytes.digest, digest)),
    ).toHaveLength(0)
  })

  it('collects a blob whose last document went without freeing it', async () => {
    const fixture = await createCompanyFixture({ name: 'Sweep Co' })
    const bytes = pdf('orphan-me')
    const digest = digestOf(bytes)

    const document = await storeDocument(fixture.ctx, {
      filename: 'orphan.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })

    // Exactly what a process that died between the commit and the free would
    // leave behind: the document row gone, the count decremented, the bytes
    // still there.
    await db.delete(documents).where(eq(documents.id, document.id))
    await db
      .update(documentBlobs)
      .set({ referenceCount: 0 })
      .where(eq(documentBlobs.digest, digest))

    expect(await sweepOrphanedBlobs()).toBeGreaterThanOrEqual(1)
    expect(
      await db.select().from(documentBlobs).where(eq(documentBlobs.digest, digest)),
    ).toHaveLength(0)
    expect(
      await db.select().from(documentBytes).where(eq(documentBytes.digest, digest)),
    ).toHaveLength(0)
  })

  it('does not free bytes a document still points at, whatever the count says', async () => {
    const fixture = await createCompanyFixture({ name: 'Drift Co' })
    const bytes = pdf('still-needed')
    const digest = digestOf(bytes)

    const document = await storeDocument(fixture.ctx, {
      filename: 'needed.pdf',
      contentType: 'application/pdf',
      data: bytes,
    })

    // A drifted cache. The rows are the authority, so this must change nothing.
    await db
      .update(documentBlobs)
      .set({ referenceCount: 0 })
      .where(eq(documentBlobs.digest, digest))

    expect(await sweepOrphanedBlobs()).toBe(0)
    expect((await readDocument(fixture.companyId, document.id))?.data).toEqual(bytes)
  })

  it('refuses what it will not keep', async () => {
    const fixture = await createCompanyFixture({ name: 'Refuse Co' })

    await expect(
      storeDocument(fixture.ctx, {
        filename: 'clever.svg',
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg onload="alert(1)"/>'),
      }),
    ).rejects.toThrow(/not a file type/i)

    await expect(
      storeDocument(fixture.ctx, {
        filename: 'nothing.pdf',
        contentType: 'application/pdf',
        data: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/empty/i)

    await expect(
      storeDocument(fixture.ctx, {
        filename: 'huge.pdf',
        contentType: 'application/pdf',
        data: Buffer.alloc(MAX_EVIDENCE_BYTES + 1),
      }),
    ).rejects.toThrow(/10 MB/)
  })
})

describe('one document, many records', () => {
  it('hangs on a bill, a payment and a journal entry at once', async () => {
    const fixture = await createCompanyFixture({ name: 'Links Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -12_000,
      description: 'ACME SUPPLIES',
    })
    const asset = await registerAsset(fixture.ctx, {
      name: 'Compressor',
      acquiredDate: '2026-01-01',
      inServiceDate: '2026-01-01',
      costCents: 400_000,
      method: 'straight_line',
      lifeMonths: 60,
    })

    const document = await storeDocument(fixture.ctx, {
      filename: 'purchase.pdf',
      contentType: 'application/pdf',
      data: pdf('one-invoice-two-homes'),
    })

    await attachDocument(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      documentId: document.id,
    })
    await attachDocument(fixture.ctx, {
      subjectType: 'fixed_asset',
      subjectId: asset.id,
      documentId: document.id,
    })

    expect(await usesOf(fixture.ctx, document.id)).toHaveLength(2)
    expect(await listDocuments(fixture.ctx)).toHaveLength(1)

    // Detaching one leaves the other, and leaves the file.
    expect(
      await detachDocument(fixture.ctx, {
        subjectType: 'bank_transaction',
        subjectId: transaction.id,
        documentId: document.id,
      }),
    ).toBe(true)

    expect(
      await evidenceFor(fixture.ctx, {
        subjectType: 'bank_transaction',
        subjectId: transaction.id,
      }),
    ).toHaveLength(0)
    expect(
      await evidenceFor(fixture.ctx, { subjectType: 'fixed_asset', subjectId: asset.id }),
    ).toHaveLength(1)
    expect(await listDocuments(fixture.ctx)).toHaveLength(1)
  })

  it('attaches once however many times the same request arrives', async () => {
    const fixture = await createCompanyFixture({ name: 'Replay Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -800,
      description: 'CAFE',
    })
    const document = await storeDocument(fixture.ctx, {
      filename: 'till.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    const ref = {
      subjectType: 'bank_transaction' as const,
      subjectId: transaction.id,
      documentId: document.id,
    }

    // Concurrent, which is what a phone reconnecting actually does.
    const results = await Promise.all([
      attachDocument(fixture.ctx, ref),
      attachDocument(fixture.ctx, ref),
      attachDocument(fixture.ctx, ref),
    ])

    expect(results.filter((result) => !result.alreadyAttached)).toHaveLength(1)
    expect(await evidenceFor(fixture.ctx, ref)).toHaveLength(1)
  })

  it('takes the document off every record when it is deleted', async () => {
    const fixture = await createCompanyFixture({ name: 'Cascade Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -500,
      description: 'ANYTHING',
    })
    const document = await storeDocument(fixture.ctx, {
      filename: 'gone.pdf',
      contentType: 'application/pdf',
      data: pdf('delete-me'),
    })

    await attachDocument(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      documentId: document.id,
    })

    await deleteDocument(fixture.ctx, document.id)

    expect(
      await evidenceFor(fixture.ctx, {
        subjectType: 'bank_transaction',
        subjectId: transaction.id,
      }),
    ).toHaveLength(0)
  })

  it('counts a page of records in one query, and names the bare ones', async () => {
    const fixture = await createCompanyFixture({ name: 'Counts Co' })
    const withPaper = await insertTransaction(fixture, {
      amountCents: -100,
      description: 'HAS ONE',
    })
    const without = await insertTransaction(fixture, {
      amountCents: -200,
      description: 'HAS NONE',
    })

    const document = await storeDocument(fixture.ctx, {
      filename: 'r.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })
    await attachDocument(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: withPaper.id,
      documentId: document.id,
    })

    const counts = await evidenceCounts(fixture.ctx, 'bank_transaction', [
      withPaper.id,
      without.id,
    ])
    expect(counts.get(withPaper.id)).toBe(1)
    expect(counts.has(without.id)).toBe(false)

    // The year-end question §13's attachments line exists to answer.
    expect(
      await withoutEvidence(fixture.ctx, 'bank_transaction', [withPaper.id, without.id]),
    ).toEqual([without.id])

    const grouped = await evidenceForMany(fixture.ctx, 'bank_transaction', [
      withPaper.id,
      without.id,
    ])
    expect(grouped.get(withPaper.id)).toHaveLength(1)
    expect(grouped.get(without.id)).toBeUndefined()
  })
})

describe('reachable only through a record you may read', () => {
  it('refuses a record belonging to another company', async () => {
    const ours = await createCompanyFixture({ name: 'Attacker Co' })
    const theirs = await createCompanyFixture({ name: 'Victim Co' })

    const theirTransaction = await insertTransaction(theirs, {
      amountCents: -900,
      description: 'THEIR SPEND',
    })
    const ourDocument = await storeDocument(ours.ctx, {
      filename: 'ours.pdf',
      contentType: 'application/pdf',
      data: pdf('mine'),
    })

    // A real uuid, a real record — just not ours.
    await expect(
      attachDocument(ours.ctx, {
        subjectType: 'bank_transaction',
        subjectId: theirTransaction.id,
        documentId: ourDocument.id,
      }),
    ).rejects.toBeInstanceOf(NoSuchSubjectError)
  })

  it('refuses a document belonging to another company', async () => {
    const ours = await createCompanyFixture({ name: 'Borrower Co' })
    const theirs = await createCompanyFixture({ name: 'Lender Co' })

    const ourTransaction = await insertTransaction(ours, {
      amountCents: -400,
      description: 'OURS',
    })
    const theirDocument = await storeDocument(theirs.ctx, {
      filename: 'theirs.pdf',
      contentType: 'application/pdf',
      data: pdf('not-yours'),
    })

    await expect(
      attachDocument(ours.ctx, {
        subjectType: 'bank_transaction',
        subjectId: ourTransaction.id,
        documentId: theirDocument.id,
      }),
    ).rejects.toThrow(/does not exist/i)
  })

  it('will not serve another company its neighbour’s bytes', async () => {
    const ours = await createCompanyFixture({ name: 'Reader Co' })
    const theirs = await createCompanyFixture({ name: 'Owner Co' })

    const theirDocument = await storeDocument(theirs.ctx, {
      filename: 'statement.pdf',
      contentType: 'application/pdf',
      data: pdf('bank-statement'),
    })

    // Knowing the id is not enough, which is the entire authorization story
    // for a store that is not partitioned by tenant.
    expect(await readDocument(ours.companyId, theirDocument.id)).toBeNull()
    expect(await readDocument(theirs.companyId, theirDocument.id)).not.toBeNull()
  })

  it('guards each kind of record with its own permission', async () => {
    const fixture = await createCompanyFixture({ name: 'Roles Co' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
    const transaction = await insertTransaction(fixture, {
      amountCents: -650,
      description: 'FUEL',
    })

    const document = await storeDocument(bookkeeper, {
      filename: 'fuel.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    // A bookkeeper attaches a receipt to a transaction all day.
    await attachDocument(bookkeeper, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      documentId: document.id,
    })

    // And has no business on a payroll run, where the evidence is what people
    // are paid. It fails on the permission, before the record is even looked up.
    await expect(
      attachDocument(bookkeeper, {
        subjectType: 'payroll_run',
        subjectId: transaction.id,
        documentId: document.id,
      }),
    ).rejects.toBeInstanceOf(PermissionError)
  })

  it('lets a read-only auditor see the evidence and not remove it', async () => {
    const fixture = await createCompanyFixture({ name: 'Auditor Co' })
    const auditor = await addUserWithRole(fixture, 'readonly')
    const transaction = await insertTransaction(fixture, {
      amountCents: -1_100,
      description: 'INSURANCE',
    })
    const document = await storeDocument(fixture.ctx, {
      filename: 'policy.pdf',
      contentType: 'application/pdf',
      data: pdf('policy'),
    })
    await attachDocument(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      documentId: document.id,
    })

    const ref = { subjectType: 'bank_transaction' as const, subjectId: transaction.id }

    expect(await evidenceFor(auditor, ref)).toHaveLength(1)
    await expect(
      detachDocument(auditor, { ...ref, documentId: document.id }),
    ).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('accountant notes', () => {
  it('records why, where the audit log only records what', async () => {
    const fixture = await createCompanyFixture({ name: 'Notes Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -2_400,
      description: 'AMBIGUOUS PAYMENT',
    })
    const ref = { subjectType: 'bank_transaction' as const, subjectId: transaction.id }

    await writeNote(fixture.ctx, {
      ...ref,
      body: 'Supplier confirms this is a deposit, not a prepayment.',
    })

    const notes = await notesFor(fixture.ctx, ref)
    expect(notes).toHaveLength(1)
    expect(notes[0].authorName).toBe(fixture.ctx.userName)
    expect(notes[0].isQuestion).toBe(false)

    const audited = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'note.write'))
    expect(audited.length).toBeGreaterThanOrEqual(1)
  })

  it('refuses an empty note', async () => {
    const fixture = await createCompanyFixture({ name: 'Empty Note Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -100,
      description: 'ANY',
    })

    await expect(
      writeNote(fixture.ctx, {
        subjectType: 'bank_transaction',
        subjectId: transaction.id,
        body: '   ',
      }),
    ).rejects.toThrow(/needs something/i)
  })

  it('puts a question on the work list until somebody answers it', async () => {
    const fixture = await createCompanyFixture({ name: 'Questions Co' })
    const customer = await createCustomer(fixture.ctx, { name: 'Ridge Holdings' })
    const revenue = await fixture.account('4000')
    const receivable = await fixture.account('1200')

    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      lines: [
        {
          description: 'Consulting',
          quantityMilli: 1_000,
          unitPriceCents: 50_000,
          chartAccountId: revenue.id,
        },
      ],
    })
    expect(receivable).toBeDefined()

    const ref = { subjectType: 'invoice' as const, subjectId: invoice.id }

    const question = await writeNote(fixture.ctx, {
      ...ref,
      body: 'Is this the March or April engagement?',
      isQuestion: true,
    })
    await writeNote(fixture.ctx, { ...ref, body: 'Filed under the March folder.' })

    const open = await openQuestions(fixture.ctx)
    expect(open.map((row) => row.id)).toContain(question.id)
    // A remark is not a question and never appears here.
    expect(open).toHaveLength(1)

    const counts = await noteCounts(fixture.ctx, 'invoice', [invoice.id])
    expect(counts.get(invoice.id)).toEqual({ total: 2, openQuestions: 1 })

    // Answering keeps the question and adds the answer beside it.
    expect(await resolveNote(fixture.ctx, question.id, 'March. Confirmed by email.')).toBe(true)
    expect(await openQuestions(fixture.ctx)).toHaveLength(0)

    const after = await notesFor(fixture.ctx, ref)
    expect(after).toHaveLength(3)
    expect(after.map((note) => note.body)).toContain('Is this the March or April engagement?')
    expect(after.map((note) => note.body)).toContain('March. Confirmed by email.')
  })

  it('answers a question once, however many people click at the same moment', async () => {
    const fixture = await createCompanyFixture({ name: 'Race Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -700,
      description: 'CONTESTED',
    })

    const question = await writeNote(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      body: 'Whose card is this?',
      isQuestion: true,
    })

    const outcomes = await Promise.all([
      resolveNote(fixture.ctx, question.id),
      resolveNote(fixture.ctx, question.id),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })

  it('refuses to resolve a remark, in the database', async () => {
    const fixture = await createCompanyFixture({ name: 'Remark Co' })
    const transaction = await insertTransaction(fixture, {
      amountCents: -300,
      description: 'PLAIN',
    })

    const remark = await writeNote(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      body: 'Coded to office supplies as usual.',
    })

    await expect(resolveNote(fixture.ctx, remark.id)).rejects.toThrow(/remark/i)

    // And the CHECK constraint says so too, so no other path can do it either.
    // The constraint name is on the driver error rather than in its message.
    const refused = await db
      .update(recordNotes)
      .set({ resolvedAt: new Date() })
      .where(eq(recordNotes.id, remark.id))
      .then(() => null)
      .catch((error: { cause?: { constraint_name?: string } }) => error)

    expect(refused).not.toBeNull()
    expect((refused as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
      'record_notes_resolvable',
    )
  })

  it('keeps one company’s questions out of another’s work list', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Notes Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Notes Co' })

    const theirTransaction = await insertTransaction(theirs, {
      amountCents: -100,
      description: 'THEIRS',
    })
    await writeNote(theirs.ctx, {
      subjectType: 'bank_transaction',
      subjectId: theirTransaction.id,
      body: 'What is this?',
      isQuestion: true,
    })

    expect(await openQuestions(ours.ctx)).toHaveLength(0)
    expect(await openQuestions(theirs.ctx)).toHaveLength(1)
  })

  it('hides a question about payroll from somebody who may not see payroll', async () => {
    const fixture = await createCompanyFixture({ name: 'Payroll Notes Co' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
    const transaction = await insertTransaction(fixture, {
      amountCents: -100,
      description: 'ORDINARY',
    })

    await writeNote(fixture.ctx, {
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
      body: 'Which account?',
      isQuestion: true,
    })

    // The bookkeeper sees the transaction question and, were there one, would
    // not see a payroll question — the list is filtered kind by kind rather
    // than gated once.
    const visible = await openQuestions(bookkeeper)
    expect(visible).toHaveLength(1)
    expect(visible[0].subjectType).toBe('bank_transaction')
  })
})

describe('the mobile receipt path, now on the same store', () => {
  it('uploads, attaches idempotently, and reads back through evidence', async () => {
    const fixture = await createCompanyFixture({ name: 'Receipts Co' })
    const bookkeeper = await addUserWithRole(fixture, 'bookkeeper')
    const transaction = await insertTransaction(fixture, {
      amountCents: -3_400,
      description: 'HOME DEPOT 6612',
    })

    const receipt = await uploadReceipt(bookkeeper, {
      filename: 'till.jpg',
      contentType: 'image/jpeg',
      data: jpeg(),
    })

    await attachReceipt(bookkeeper, transaction.id, receipt.id)
    await attachReceipt(bookkeeper, transaction.id, receipt.id)

    expect(await receiptsFor(bookkeeper, transaction.id)).toHaveLength(1)

    // And it is an ordinary document — visible on the documents page, countable
    // with everything else. That is the point of the migration.
    const held = await listDocuments(fixture.ctx)
    expect(held).toHaveLength(1)
    expect(held[0].attachedTo).toBe(1)
  })

  it('keeps the phone’s tighter size limit', async () => {
    const fixture = await createCompanyFixture({ name: 'Phone Limit Co' })

    // Under the desk limit of 10 MB and over the phone's 2 MB: the mobile
    // ceiling protects somebody's data allowance, not the server.
    await expect(
      uploadReceipt(fixture.ctx, {
        filename: 'huge.jpg',
        contentType: 'image/jpeg',
        data: Buffer.alloc(3 * 1024 * 1024),
      }),
    ).rejects.toThrow(/2 MB/)
  })
})
