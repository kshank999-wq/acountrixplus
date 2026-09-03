import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { creditNotes, giftCards, retainers } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import {
  DATASETS,
  DATASET_LABELS,
  MANIFEST,
  exportCompanyData,
  type DatasetName,
} from '@/modules/tenancy/export'
import { decimal } from '@/modules/tenancy/exported-money'
import { createCustomer } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'

/**
 * The money the company is holding for somebody else (Phase 104).
 *
 * The export answered "what are we owed" and "what do we owe suppliers" and
 * said nothing about money on account. The ledger showed a liability balance
 * and the trail stopped there, so a leaving company got "Customer retainers:
 * 12,400" with no way to find out whose it was. You cannot honour a gift card
 * from a trial balance.
 *
 * The claim that matters most is the last one here: the manifest's outstanding
 * figure ties to what the tables actually hold, which is the reconciliation an
 * accountant does first.
 */

const cells = (line: string): string[] => {
  const out: string[] = []
  let current = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else quoted = false
      } else current += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(current)
      current = ''
    } else current += ch
  }

  out.push(current)
  return out
}

const parse = (content: string) => {
  const [header, ...lines] = content.trim().split('\r\n')
  const columns = cells(header)
  return lines.map((line) => {
    const values = cells(line)
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]))
  })
}

describe('the list of datasets', () => {
  it('is derived from the labels, so a dataset cannot be silently absent', () => {
    // `DatasetName`, `DATASETS` and `DATASET_LABELS` were three parallel
    // hand-written structures and only the record was checked. A dataset added
    // to the union, the labels and the switch but forgotten in `DATASETS`
    // would have compiled, been selectable by name, and never appeared in the
    // default export — a missing file in somebody's leaving archive.
    expect(DATASETS).toEqual(Object.keys(DATASET_LABELS))
    expect(new Set(DATASETS).size).toBe(DATASETS.length)
  })

  it('gives every dataset a label somebody can read', () => {
    for (const dataset of DATASETS) {
      expect(DATASET_LABELS[dataset].length, dataset).toBeGreaterThan(3)
    }
  })

  it('names the three that hold somebody else’s money', () => {
    for (const dataset of ['retainers', 'credit_notes', 'gift_cards'] as DatasetName[]) {
      expect(DATASETS).toContain(dataset)
    }
  })
})

describe('against the database', () => {
  const asOf = { datasets: undefined }
  void asOf

  it('names whose retainer it is, in the currency it arrived in', async () => {
    const fixture = await createCompanyFixture({ name: 'Retainer Co' })
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-01-05', rateMillionths: 1_100_000 })

    const patel = await createCustomer(fixture.ctx, { name: 'Mrs Patel' })

    await db.insert(retainers).values({
      companyId: fixture.companyId,
      customerId: patel.id,
      receivedOn: '2026-01-05',
      reference: 'On account for the spring work',
      currency: 'EUR',
      amountCents: 400_000,
      exchangeRateMillionths: 1_100_000,
      remainingCents: 250_000,
      functionalRemainingCents: 275_000,
    })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['retainers'] })
    const rows = parse(result.files.find((f) => f.name === 'retainers.csv')!.content)

    expect(rows).toHaveLength(1)
    // The thing a trial balance cannot tell you.
    expect(rows[0].customer).toBe('Mrs Patel')
    expect(rows[0].amount).toBe('4000.00')
    expect(rows[0].amount_currency).toBe('EUR')
    expect(rows[0].amount_functional).toBe('4400.00')
    expect(rows[0].remaining).toBe('2500.00')
    expect(rows[0].remaining_functional).toBe('2750.00')
    expect(rows[0].exchange_rate).toBe('1.100000')
  })

  it('says a gift card has a purchaser rather than an owner', async () => {
    const fixture = await createCompanyFixture({ name: 'Card Co' })
    const buyer = await createCustomer(fixture.ctx, { name: 'Alan Brody' })

    await db.insert(giftCards).values([
      {
        companyId: fixture.companyId,
        code: 'GC-1001',
        purchaserCustomerId: buyer.id,
        issuedCents: 5000,
        balanceCents: 3500,
        issuedOn: '2026-01-05',
      },
      {
        // Bought over the counter by somebody who left no name — which is the
        // ordinary case, not an error.
        companyId: fixture.companyId,
        code: 'GC-1002',
        issuedCents: 2000,
        balanceCents: 2000,
        issuedOn: '2026-01-06',
      },
    ])

    const result = await exportCompanyData(fixture.ctx, { datasets: ['gift_cards'] })
    const content = result.files.find((f) => f.name === 'gift_cards.csv')!.content
    const rows = parse(content)

    // The column is `purchaser`, not `customer`: naming the buyer as the owner
    // would be a plausible-looking wrong answer.
    expect(content.split('\r\n')[0]).toContain('purchaser')
    expect(content.split('\r\n')[0]).not.toContain('customer')

    expect(rows.find((r) => r.code === 'GC-1001')!.purchaser).toBe('Alan Brody')
    expect(rows.find((r) => r.code === 'GC-1002')!.purchaser).toBe('')

    // No currency column on the table, so every balance is the company's own
    // money by construction and the file says which that is.
    expect(rows[0].balance_currency).toBe('USD')
  })

  it('keeps a spent card in the file and out of the total', async () => {
    // Two readers, two needs: reconciling the liability account wants what is
    // outstanding; "was this card already used?" wants the row to exist.
    const fixture = await createCompanyFixture({ name: 'Spent Co' })

    await db.insert(giftCards).values([
      {
        companyId: fixture.companyId,
        code: 'GC-SPENT',
        issuedCents: 5000,
        balanceCents: 0,
        issuedOn: '2026-01-05',
      },
      {
        companyId: fixture.companyId,
        code: 'GC-LIVE',
        issuedCents: 4000,
        balanceCents: 4000,
        issuedOn: '2026-01-06',
      },
    ])

    const result = await exportCompanyData(fixture.ctx, { datasets: ['gift_cards'] })
    const cards = result.files.find((f) => f.name === 'gift_cards.csv')!

    expect(parse(cards.content).map((r) => r.code)).toEqual(['GC-SPENT', 'GC-LIVE'])
    // Tallied on the balance, not on what was issued — 9000 would be the
    // number that does not tie to anything.
    expect(cards.currencies).toEqual([{ currency: 'USD', rowCount: 2, totalCents: 4000 }])
  })

  it('names which side of the books a credit note is on', async () => {
    const fixture = await createCompanyFixture({ name: 'Credit Co' })
    const customer = await createCustomer(fixture.ctx, { name: 'Northgate Ltd' })

    await db.insert(creditNotes).values({
      companyId: fixture.companyId,
      party: 'customer',
      customerId: customer.id,
      number: 'CN-2001',
      issueDate: '2026-02-01',
      currency: 'USD',
      subtotalCents: 30_000,
      taxCents: 0,
      totalCents: 30_000,
      functionalTotalCents: 30_000,
      remainingCents: 12_000,
      functionalRemainingCents: 12_000,
    })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['credit_notes'] })
    const rows = parse(result.files.find((f) => f.name === 'credit_notes.csv')!.content)

    expect(rows[0].party).toBe('customer')
    expect(rows[0].party_name).toBe('Northgate Ltd')
    expect(rows[0].total).toBe('300.00')
    expect(rows[0].remaining).toBe('120.00')
  })

  /**
   * The property that makes this export checkable rather than merely present.
   *
   * The manifest's figure for each obligation dataset is what the company still
   * owes on it, so it has to equal what the tables hold. An accountant does
   * this against the liability account in `journal.csv`; asserting it here
   * against the source is the same check one step earlier.
   */
  it('reports an outstanding total that ties to what the tables hold', async () => {
    const fixture = await createCompanyFixture({ name: 'Tie Co' })
    const customer = await createCustomer(fixture.ctx, { name: 'Harbour Works' })

    await db.insert(retainers).values([
      {
        companyId: fixture.companyId,
        customerId: customer.id,
        receivedOn: '2026-01-05',
        currency: 'USD',
        amountCents: 500_000,
        remainingCents: 320_000,
        functionalRemainingCents: 320_000,
      },
      {
        companyId: fixture.companyId,
        customerId: customer.id,
        receivedOn: '2026-02-05',
        currency: 'USD',
        amountCents: 100_000,
        remainingCents: 0,
        functionalRemainingCents: 0,
      },
    ])

    await db.insert(giftCards).values({
      companyId: fixture.companyId,
      code: 'GC-TIE',
      issuedCents: 7500,
      balanceCents: 2500,
      issuedOn: '2026-01-10',
    })

    const result = await exportCompanyData(fixture.ctx)
    const manifest = parse(result.files.find((f) => f.name === MANIFEST)!.content)

    const [held] = await db
      .select({ n: sql<string>`coalesce(sum(${retainers.remainingCents}), 0)` })
      .from(retainers)
      .where(eq(retainers.companyId, fixture.companyId))

    const [cards] = await db
      .select({ n: sql<string>`coalesce(sum(${giftCards.balanceCents}), 0)` })
      .from(giftCards)
      .where(eq(giftCards.companyId, fixture.companyId))

    const line = (file: string) => manifest.find((row) => row.file === file)!

    expect(line('retainers.csv').total).toBe(decimal(Number(held.n)))
    expect(line('retainers.csv').total).toBe('3200.00')
    expect(line('gift_cards.csv').total).toBe(decimal(Number(cards.n)))
    expect(line('gift_cards.csv').total).toBe('25.00')
  })

  it('produces a file for every dataset, and the manifest', async () => {
    const fixture = await createCompanyFixture({ name: 'Complete Co' })

    const result = await exportCompanyData(fixture.ctx)
    const names = result.files.map((file) => file.name)

    // Derived from the list, so adding a dataset without a file is impossible
    // rather than merely unlikely.
    expect(names).toHaveLength(DATASETS.length + 1)
    expect(names[names.length - 1]).toBe(MANIFEST)
    for (const dataset of DATASETS) {
      expect(names.some((name) => name.startsWith(dataset)), dataset).toBe(true)
    }
  })

  it('tells an empty money file from one with no money in it', async () => {
    const fixture = await createCompanyFixture({ name: 'Empty Co' })

    const result = await exportCompanyData(fixture.ctx, {
      datasets: ['gift_cards', 'customers'],
    })
    const manifest = result.files.find((f) => f.name === MANIFEST)!.content

    // `customers.csv` has no money concept; `gift_cards.csv` has four money
    // columns and nothing in them. Both used to say "holds no money columns".
    expect(manifest).toContain('customers.csv holds no money columns.')
    expect(manifest).toContain('gift_cards.csv has money columns and no rows.')
  })

  it('keeps one company’s held money out of another’s export', async () => {
    const ours = await createCompanyFixture({ name: 'Ours Held Co' })
    const theirs = await createCompanyFixture({ name: 'Theirs Held Co' })
    const customer = await createCustomer(theirs.ctx, { name: 'Their Customer' })

    await db.insert(retainers).values({
      companyId: theirs.companyId,
      customerId: customer.id,
      receivedOn: '2026-01-05',
      currency: 'USD',
      amountCents: 900_000,
      remainingCents: 900_000,
      functionalRemainingCents: 900_000,
    })

    const result = await exportCompanyData(ours.ctx, { datasets: ['retainers'] })
    const held = result.files.find((f) => f.name === 'retainers.csv')!

    expect(held.rowCount).toBe(0)
    // An empty obligation file has money columns and no rows — which is not
    // the same as a file with no money in it, and the manifest says so
    // differently (Phase 104).
    expect(held.currencies).toEqual([])
  })
})
