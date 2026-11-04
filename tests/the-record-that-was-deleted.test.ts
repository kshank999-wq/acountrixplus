import { describe, expect, it } from 'vitest'
import { eq, getTableName, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bankTransactions,
  documentLinks,
  documents,
  evidenceSubjects,
  recordNotes,
} from '@/db/schema'
import { createCompanyFixture, insertTransaction, type Fixture } from './helpers'
import { attachDocument, storeDocument } from '@/modules/evidence/service'
import { openQuestions, resolveNote, writeNote } from '@/modules/evidence/notes'
import {
  EVIDENCE_SUBJECTS,
  subjectColumnFor,
  subjectDefinition,
} from '@/modules/evidence/subjects'
import { discardDraftEntry, draftJournalEntry } from '@/modules/ledger/journal'
import { createCustomer } from '@/modules/receivables/service'
import { mergeParties } from '@/modules/parties/service'

/**
 * The record that was deleted (Phase 184).
 *
 * ADR 0183 nominated converting `document_links` away from twelve keyless
 * polymorphic subject references. The measurement found it is **two** tables
 * with that shape, not one — `record_notes` is identical — and that the
 * weakness is not theoretical.
 *
 * `subjects.ts` says the polymorphic shape is acceptable because the check
 * lives in code:
 *
 * > It is the whole reason a missing foreign key is acceptable: the check that
 * > a constraint would do is done here, under the tenant filter, before
 * > anything is written.
 *
 * That is true of *writing* a link and says nothing about the subject being
 * deleted afterwards. A foreign key is two guarantees and this argument
 * accounts for one of them.
 */

const PDF = Buffer.from('255044462d312e340a25', 'hex')

/** `journalEntryId` → `journal_entry_id`, as Postgres spells it. */
const snakeCase = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/**
 * What the driver actually said, which is never in the message.
 *
 * `error.message` is `Failed query: insert into …` with the parameters
 * appended, so a `toThrow(/my_constraint/)` passes for any rejected write and
 * fails for the right one — the trap Phase 177 fell into twice. The code, the
 * constraint and the column are on `cause`.
 */
async function refusalFor(
  write: Promise<unknown>,
): Promise<{ code?: string; constraint?: string; column?: string } | undefined> {
  try {
    await write
    return undefined
  } catch (error) {
    const cause = (error as {
      cause?: { code?: string; constraint_name?: string; column_name?: string }
    }).cause

    return cause
      ? { code: cause.code, constraint: cause.constraint_name, column: cause.column_name }
      : undefined
  }
}

const constraintBrokenBy = async (write: Promise<unknown>) =>
  (await refusalFor(write))?.constraint

async function aDraftEntryWithEvidence(fixture: Fixture) {
  const cash = await fixture.account('1000')
  const expense = await fixture.account('6000')

  const entry = await draftJournalEntry(fixture.ctx, {
    entryDate: '2026-03-01',
    memo: 'Reclassification, pending the client email',
    lines: [
      { chartAccountId: expense.id, debitCents: 4200 },
      { chartAccountId: cash.id, creditCents: 4200 },
    ],
  })

  const document = await storeDocument(fixture.ctx, {
    filename: 'working-paper.pdf',
    contentType: 'application/pdf',
    data: PDF,
  })

  await attachDocument(fixture.ctx, {
    documentId: document.id,
    subjectType: 'journal_entry',
    subjectId: entry.id,
  })

  const question = await writeNote(fixture.ctx, {
    subjectType: 'journal_entry',
    subjectId: entry.id,
    body: 'Is this the deposit or the prepayment? Asked the client 14 Aug.',
    isQuestion: true,
  })

  return { entryId: entry.id, documentId: document.id, questionId: question.id }
}

describe('discarding a draft takes its evidence with it', () => {
  it('leaves no link behind', async () => {
    const fixture = await createCompanyFixture()
    const { entryId } = await aDraftEntryWithEvidence(fixture)

    await discardDraftEntry(fixture.ctx, entryId)

    /*
      `discardDraftEntry`'s own comment reads "Lines cascade" — true, through a
      real foreign key, and incomplete. `document_links` had no foreign key, so
      the working paper's link survived the entry and pointed at a uuid that no
      longer existed.
    */
    const links = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(documentLinks)
      .where(eq(documentLinks.subjectId, entryId))

    expect(links[0].n).toBe(0)
  })

  it('takes the accountant\'s question off the work list', async () => {
    const fixture = await createCompanyFixture()
    const { entryId } = await aDraftEntryWithEvidence(fixture)

    expect((await openQuestions(fixture.ctx)).map((q) => q.subjectId)).toContain(entryId)

    await discardDraftEntry(fixture.ctx, entryId)

    /*
      The sharpest consequence, and the reason this is not a silent orphan.
      `openQuestions` is the work list — "every unanswered question in the
      company" — and it reads `record_notes` with no join to the subject. So an
      orphaned question appeared on an accountant's list forever, about a record
      that did not exist.
    */
    expect((await openQuestions(fixture.ctx)).map((q) => q.subjectId)).not.toContain(entryId)

    const notes = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recordNotes)
      .where(eq(recordNotes.subjectId, entryId))

    expect(notes[0].n).toBe(0)
  })

  it('does not leave a question that cannot be answered', async () => {
    const fixture = await createCompanyFixture()
    const { entryId, questionId } = await aDraftEntryWithEvidence(fixture)

    await discardDraftEntry(fixture.ctx, entryId)

    /*
      What made the orphan worse than untidy. `resolveNote` marks the question
      answered and then, if an answer was typed, calls `writeNote` — which calls
      `requireSubject` and throws `NoSuchSubjectError`. Inside one transaction,
      so the resolve rolls back too.

      The accountant therefore saw a question on their work list, typed the
      answer, and was told *"That journal entry does not exist"* — about a
      record they had not asked about, with no way to clear the item. Resolving
      it **without** an answer worked, which is the one path that looked fine.
    */
    expect(await resolveNote(fixture.ctx, questionId, 'The deposit. Client confirmed.')).toBe(
      false,
    )
  })
})

describe('the three paths that were latent', () => {
  /**
   * Not reachable from a screen in this phase, and fixed anyway.
   *
   * `bank_transactions` and `reconciliations` cascade from
   * `financial_accounts`, and `proposal_versions` from `proposals`. No
   * application path deletes a financial account or a proposal today — which is
   * the whole reason these were latent rather than defects — and "remove this
   * bank connection" is an ordinary screen to want. The day it is written, a
   * receipt on every transaction in that account becomes an orphan.
   *
   * Asserted at the database, because that is where the fix is and because a
   * test that went through a screen could not test a screen that does not
   * exist.
   */
  it('takes a transaction\'s receipt with the transaction', async () => {
    const fixture = await createCompanyFixture()

    const transaction = await insertTransaction(fixture, {
      amountCents: -4200,
      description: 'Screwfix',
      postedDate: '2026-03-02',
    })

    const document = await storeDocument(fixture.ctx, {
      filename: 'receipt.pdf',
      contentType: 'application/pdf',
      data: PDF,
    })

    await attachDocument(fixture.ctx, {
      documentId: document.id,
      subjectType: 'bank_transaction',
      subjectId: transaction.id,
    })

    await db.delete(bankTransactions).where(eq(bankTransactions.id, transaction.id))

    const links = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(documentLinks)
      .where(eq(documentLinks.subjectId, transaction.id))

    expect(links[0].n).toBe(0)
  })

  it('leaves the document itself alone', async () => {
    const fixture = await createCompanyFixture()
    const { entryId, documentId } = await aDraftEntryWithEvidence(fixture)

    await discardDraftEntry(fixture.ctx, entryId)

    /*
      The cascade is on the **link**, not the file. A receipt attached to the
      wrong record is the common case, and deleting the photograph would mean
      re-photographing a piece of paper that is now in a bin — the argument
      `detachDocument` already makes, and the reason this is a link table at
      all: one blob, one document, three links.
    */
    const kept = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, documentId))

    expect(kept).toHaveLength(1)
  })
})

describe('what the database now refuses', () => {
  /**
   * Five refusals, every one of them the database's.
   *
   * The reason they are asserted around the service rather than through it:
   * `ensureSubject` refuses four of these first, in a sentence a person can
   * read, and that is right — but a refusal in a function is a refusal somebody
   * can forget to call, which is exactly what the old shape relied on. These
   * prove the floor underneath it (Phase 116).
   */
  async function aCompanyWithAnEntry(name: string) {
    const fixture = await createCompanyFixture({ name })
    const cash = await fixture.account('1000')
    const expense = await fixture.account('6000')

    const entry = await draftJournalEntry(fixture.ctx, {
      entryDate: '2026-03-01',
      memo: 'Draft',
      lines: [
        { chartAccountId: expense.id, debitCents: 1000 },
        { chartAccountId: cash.id, creditCents: 1000 },
      ],
    })

    return { fixture, entryId: entry.id }
  }

  it('refuses a subject row belonging to another company', async () => {
    const mine = await createCompanyFixture({ name: 'Mine' })
    const theirs = await aCompanyWithAnEntry('Theirs')

    // The composite key, doing the job the function used to do alone: my
    // company cannot declare their journal entry a subject of mine.
    expect(
      await constraintBrokenBy(
        db
          .insert(evidenceSubjects)
          .values({ companyId: mine.companyId, journalEntryId: theirs.entryId }),
      ),
    ).toBe('evidence_subjects_journal_entry_fkey')
  })

  it('refuses a row that is two kinds at once', async () => {
    const { fixture, entryId } = await aCompanyWithAnEntry('Two Kinds')
    const customer = await createCustomer(fixture.ctx, { name: 'Acme' })

    expect(
      await constraintBrokenBy(
        db.insert(evidenceSubjects).values({
          companyId: fixture.companyId,
          journalEntryId: entryId,
          customerId: customer.id,
        }),
      ),
    ).toBe('evidence_subjects_one_kind_check')
  })

  it('refuses a row that is no kind at all, by the primary key', async () => {
    const fixture = await createCompanyFixture()

    /*
      No CHECK of its own. `subject_type` and `subject_id` are generated and
      resolve to NULL when nothing is set, and a primary key cannot hold a NULL
      — so the key refuses it. One constraint doing two jobs, which is the
      argument for generating the pair rather than storing it.
    */
    // `23502` is not-null violation, and the column it names is the generated
    // one — not a CHECK, which is the point.
    expect(await refusalFor(db.insert(evidenceSubjects).values({ companyId: fixture.companyId })))
      .toMatchObject({ code: '23502', column: 'subject_type' })
  })

  it('refuses a link naming the wrong kind for a real id', async () => {
    const { fixture, entryId } = await aCompanyWithAnEntry('Wrong Kind')

    const document = await storeDocument(fixture.ctx, {
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      data: PDF,
    })

    await attachDocument(fixture.ctx, {
      documentId: document.id,
      subjectType: 'journal_entry',
      subjectId: entryId,
    })

    /*
      New capability, not merely a constraint for an existing check. The old
      shape would store `subject_type: 'bill'` beside a journal entry's uuid and
      nothing anywhere noticed: the pair simply resolved to no record, so the
      link was invisible rather than wrong. Now `(company_id, subject_type,
      subject_id)` has to exist in `evidence_subjects`, and the entry is only
      there as a `journal_entry`.
    */
    expect(
      await constraintBrokenBy(
        db.insert(documentLinks).values({
          companyId: fixture.companyId,
          documentId: document.id,
          subjectType: 'bill',
          subjectId: entryId,
        }),
      ),
    ).toBe('document_links_subject_fkey')
  })

  it('refuses a note on a record nothing declared', async () => {
    const fixture = await createCompanyFixture()

    expect(
      await constraintBrokenBy(
        db.insert(recordNotes).values({
          companyId: fixture.companyId,
          subjectType: 'invoice',
          subjectId: '00000000-0000-0000-0000-000000000000',
          body: 'What is this?',
          authorName: 'Nobody',
        }),
      ),
    ).toBe('record_notes_subject_fkey')
  })

  it('still answers in a sentence when the service is used', async () => {
    const fixture = await createCompanyFixture()

    /*
      Phase 119, and the reason `requireSubject` survives the constraint. The
      person who mistypes a record id should read "That invoice does not exist",
      not `record_notes_subject_fkey`. The constraint is what makes it true; the
      function is what makes it legible.
    */
    await expect(
      writeNote(fixture.ctx, {
        subjectType: 'invoice',
        subjectId: '00000000-0000-0000-0000-000000000000',
        body: 'What is this?',
      }),
    ).rejects.toThrow(/invoice does not exist/)
  })
})

describe('three lists that have to agree', () => {
  /**
   * The register, the enum, and the table.
   *
   * Before this phase a kind existed in two places — `EVIDENCE_SUBJECTS` and
   * the `evidence_subject` enum — and the schema's own comment said so: *"Adding
   * a kind means adding it here **and** to the registry."* Now there is a third,
   * the column on `evidence_subjects` that carries the foreign key, and it is
   * the one that would be forgotten, because forgetting it breaks nothing at
   * compile time and nothing at run time until somebody deletes a record.
   *
   * So the three are measured against each other rather than trusted. This is
   * the device Phase 182 used for `PROPOSAL_COMPONENTS` against `docs/SPEC.md`
   * and Phase 181 for `BLOCK_SURFACES`: a count is a sentence, and a comparison
   * is a check.
   */
  it('has the same twelve kinds in the register and the enum, in the same order', async () => {
    const rows = (await db.execute(sql`
      select e.enumlabel as label
      from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'evidence_subject'
      order by e.enumsortorder
    `)) as unknown as Array<{ label: string }>

    expect(rows.map((row) => row.label)).toEqual(EVIDENCE_SUBJECTS)
    expect(EVIDENCE_SUBJECTS).toHaveLength(12)
  })

  it('gives every kind a column on evidence_subjects with a cascading key', async () => {
    const rows = (await db.execute(sql`
      select a.attname as column_name,
             c.conname as constraint_name,
             c.confdeltype as on_delete,
             ref.relname as target
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_class ref on ref.oid = c.confrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[2]
      where cl.relname = 'evidence_subjects' and c.contype = 'f'
    `)) as unknown as Array<{
      column_name: string
      constraint_name: string
      on_delete: string
      target: string
    }>

    const byColumn = new Map(rows.map((row) => [row.column_name, row]))

    for (const subject of EVIDENCE_SUBJECTS) {
      const column = subjectColumnFor(subject).replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      )
      const key = byColumn.get(column)

      // A kind with no column is a kind whose evidence outlives its record,
      // which is the defect this phase exists for.
      expect(key, `${subject} has no composite key on evidence_subjects`).toBeDefined()

      // `c` is cascade. Anything else — set null, no action, restrict — would
      // either leave the orphan or refuse the delete, and refusing to delete a
      // draft entry because somebody asked a question about it is not the
      // answer either.
      expect(key!.on_delete, `${subject} does not cascade`).toBe('c')

      // And the target table is the register's, rather than whichever table
      // happens to have a matching name — `expense` is stored in `expense_id`
      // and lives in `billable_expenses`.
      expect(key!.target, `${subject} points at the wrong table`).toBe(
        getTableName(subjectDefinition(subject).table),
      )
    }

    expect(rows).toHaveLength(EVIDENCE_SUBJECTS.length)
  })

  it('refuses a column lookup for a kind nobody declared', () => {
    // The register device's floor (Phase 101): `undefined` would be a kind
    // reported as homed while nothing referenced it.
    expect(() => subjectColumnFor('receipt' as never)).toThrow(/Nothing can be attached/)
  })

  it('maps each column back to the kind the register names', async () => {
    /*
      The other direction, and the one a test could easily skip.
      `evidence_subjects_*_fkey` proves **column → table**; this proves
      **column → kind**, by reading the generation expression the database
      actually stores.

      Worth asserting because a transposed pair of CASE arms — `bill_id` giving
      `'invoice'` — compiles, migrates, and passes every other test here: the
      row exists, the key resolves, the cascade fires. It would simply file a
      bill's receipt under the word "invoice" forever, in the one table whose
      job is saying what a record is.
    */
    const [row] = (await db.execute(sql`
      select pg_get_expr(d.adbin, d.adrelid) as expression
      from pg_attrdef d
      join pg_class c on c.oid = d.adrelid
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where c.relname = 'evidence_subjects' and a.attname = 'subject_type'
    `)) as unknown as Array<{ expression: string }>

    expect(row?.expression, 'subject_type is not a generated column').toBeDefined()

    for (const subject of EVIDENCE_SUBJECTS) {
      const column = snakeCase(subjectColumnFor(subject))

      expect(
        row.expression.replace(/\s+/g, ' '),
        `${subject} is not derived from ${column}`,
      ).toContain(`WHEN (${column} IS NOT NULL) THEN '${subject}'`)
    }
  })

  it('writes the column the register names, for every kind', () => {
    // Phase 49 at twelve columns: a column with no writer is a field that does
    // not exist. `ensureSubject` is the only writer and it takes the name from
    // here, so a kind naming a column the table does not have would write
    // nothing and be caught by the one-kind CHECK at run time rather than now.
    for (const subject of EVIDENCE_SUBJECTS) {
      expect(Object.keys(evidenceSubjects), subject).toContain(subjectColumnFor(subject))
    }
  })
})

describe('merging two records of one business', () => {
  /**
   * What the conversion made possible, and what it exposed.
   *
   * `PARTY_REFERENCES` is checked against the database's own catalogue so that
   * a table referring to a customer cannot join the schema without joining the
   * merge. `document_links.subject_id` and `record_notes.subject_id` held a
   * customer's uuid with **no foreign key**, so the catalogue could not see
   * them and neither could the register — which means every customer merge
   * since Phase 20 left the receipts and the notes on the losing record.
   *
   * Registering them was not possible before this phase. It is the clearest
   * answer to "what is a missing foreign key actually costing": not only the
   * orphan, but every mechanism that reads the catalogue to find out what
   * refers to what.
   */
  async function twoCustomersWithEvidence() {
    const fixture = await createCompanyFixture()
    const winner = await createCustomer(fixture.ctx, { name: 'Northwind Ltd' })
    const loser = await createCustomer(fixture.ctx, { name: 'Northwind Limited' })

    const document = await storeDocument(fixture.ctx, {
      filename: 'signed-terms.pdf',
      contentType: 'application/pdf',
      data: PDF,
    })

    return { fixture, winner, loser, document }
  }

  it('moves the losing record\'s evidence to the winner', async () => {
    const { fixture, winner, loser, document } = await twoCustomersWithEvidence()

    await attachDocument(fixture.ctx, {
      documentId: document.id,
      subjectType: 'customer',
      subjectId: loser.id,
    })

    await writeNote(fixture.ctx, {
      subjectType: 'customer',
      subjectId: loser.id,
      body: 'Terms signed by the parent company, not this entity.',
    })

    await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'One business, two records on one inbox.',
    })

    /*
      One `UPDATE` of one `evidence_subjects` row did this. The link and the
      note followed through `ON UPDATE CASCADE`, because the key they reference
      is generated from the column the merge changed.
    */
    const links = await db
      .select({ subjectId: documentLinks.subjectId })
      .from(documentLinks)
      .where(eq(documentLinks.companyId, fixture.companyId))

    const notes = await db
      .select({ subjectId: recordNotes.subjectId })
      .from(recordNotes)
      .where(eq(recordNotes.companyId, fixture.companyId))

    expect(links.map((row) => row.subjectId)).toEqual([winner.id])
    expect(notes.map((row) => row.subjectId)).toEqual([winner.id])
  })

  it('keeps both questions when both records carried one', async () => {
    const { fixture, winner, loser } = await twoCustomersWithEvidence()

    await writeNote(fixture.ctx, {
      subjectType: 'customer',
      subjectId: winner.id,
      body: 'Is this the trading name or the registered one?',
      isQuestion: true,
    })
    await writeNote(fixture.ctx, {
      subjectType: 'customer',
      subjectId: loser.id,
      body: 'Why do we have two of these?',
      isQuestion: true,
    })

    await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'One business, two records.',
    })

    /*
      The colliding path: both records had an identity row, so the links and
      notes move by hand and the loser's row is deleted after nothing
      references it. Notes have no uniqueness on purpose — two people asking
      the same question of two records of one business is two questions, and
      both deserve an answer.
    */
    const questions = await openQuestions(fixture.ctx)

    expect(questions).toHaveLength(2)
    expect(questions.map((q) => q.subjectId)).toEqual([winner.id, winner.id])
  })

  it('leaves one link when the same document was on both', async () => {
    const { fixture, winner, loser, document } = await twoCustomersWithEvidence()

    for (const customer of [winner, loser]) {
      await attachDocument(fixture.ctx, {
        documentId: document.id,
        subjectType: 'customer',
        subjectId: customer.id,
      })
    }

    await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'One business, two records.',
    })

    /*
      `document_links_unique` is `(document_id, subject_type, subject_id)`, so
      repointing the second would be the same row twice. The duplicate is
      dropped rather than the merge being refused: one document on one record
      afterwards loses no fact, which is exactly what is not true of a
      `subcontractors` row carrying insurance expiry.
    */
    const links = await db
      .select({ id: documentLinks.id })
      .from(documentLinks)
      .where(eq(documentLinks.companyId, fixture.companyId))

    expect(links).toHaveLength(1)
  })

  it('leaves the loser with nothing, and no identity row', async () => {
    const { fixture, winner, loser, document } = await twoCustomersWithEvidence()

    await attachDocument(fixture.ctx, {
      documentId: document.id,
      subjectType: 'customer',
      subjectId: loser.id,
    })

    await mergeParties(fixture.ctx, {
      side: 'customer',
      winnerId: winner.id,
      loserId: loser.id,
      reason: 'One business, two records.',
    })

    // The order inside `moveEvidence` is load-bearing: deleting the loser's
    // identity row before moving its links would cascade them away — the defect
    // this phase is about, committed by the function fixing it.
    const rows = await db
      .select({ customerId: evidenceSubjects.customerId })
      .from(evidenceSubjects)
      .where(eq(evidenceSubjects.companyId, fixture.companyId))

    expect(rows.map((row) => row.customerId)).toEqual([winner.id])
  })
})
