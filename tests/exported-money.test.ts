import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { invoices } from '@/db/schema'
import { createCompanyFixture } from './helpers'
import {
  columnsFor,
  decimal,
  mixesCurrencies,
  moneyColumns,
  spread,
  summarise,
  tally,
} from '@/modules/tenancy/exported-money'
import { exportCompanyData, MANIFEST, toCsv } from '@/modules/tenancy/export'
import { createCustomer, createInvoice } from '@/modules/receivables/service'
import { putRate } from '@/modules/fx/service'

/**
 * Money in an exported file (Phase 103).
 *
 * `invoices.csv` had a `total` column holding the amount in the currency each
 * invoice was *issued* in, with no currency anywhere in the file. Twenty USD
 * invoices and two EUR ones went into one column, and summing it gave a number
 * that was not money in any currency.
 *
 * The claim that matters is the last one in this file: a euro invoice and a
 * dollar invoice come out distinguishable, and the manifest says the file
 * cannot be summed.
 */

describe('rendering one money field', () => {
  it('never produces an amount without a currency', () => {
    const columns = moneyColumns({ cents: 108_000, currency: 'eur' }, { cents: 117_045, currency: 'usd' })

    expect(columns).toEqual({
      amount: '1080.00',
      currency: 'EUR',
      functionalAmount: '1170.45',
      functionalCurrency: 'USD',
    })
  })

  it('says the functional figure is the same rather than leaving it blank', () => {
    // A blank functional column would read as "not applicable" when it means
    // "the same" — and a shape that changes with whether a company happens to
    // have traded abroad breaks every formula written against the file.
    const columns = moneyColumns({ cents: 5000, currency: 'USD' })

    expect(columns.functionalAmount).toBe('50.00')
    expect(columns.functionalCurrency).toBe('USD')
  })

  it('generates the header names from the same place as the values', () => {
    // The header row and the value object used to be two hand-written lists,
    // so adding a column meant editing both — and getting them out of step
    // shifts every value in the file by one position.
    const prefix = 'total'
    const names = columnsFor(prefix)
    const row = spread(prefix, moneyColumns({ cents: 100, currency: 'GBP' }))

    expect(names).toEqual(['total', 'total_currency', 'total_functional', 'total_functional_currency'])
    expect(Object.keys(row)).toEqual(names)
  })

  it('renders negatives and sub-unit amounts the way a spreadsheet reads them', () => {
    expect(decimal(-4250)).toBe('-42.50')
    expect(decimal(7)).toBe('0.07')
    expect(decimal(0)).toBe('0.00')
    expect(decimal(null)).toBe('')
  })
})

describe('what a file adds up to', () => {
  it('totals each currency separately and sorts them', () => {
    const tallies = tally([
      { cents: 1000, currency: 'USD' },
      { cents: 500, currency: 'eur' },
      { cents: 2000, currency: 'USD' },
    ])

    expect(tallies).toEqual([
      { currency: 'EUR', rowCount: 1, totalCents: 500 },
      { currency: 'USD', rowCount: 2, totalCents: 3000 },
    ])
  })

  it('knows a file with two currencies cannot be summed', () => {
    expect(mixesCurrencies(tally([{ cents: 1, currency: 'USD' }]))).toBe(false)
    expect(
      mixesCurrencies(tally([{ cents: 1, currency: 'USD' }, { cents: 1, currency: 'EUR' }])),
    ).toBe(true)
  })

  it('says so in a sentence, naming what each currency holds', () => {
    const one = summarise('bills.csv', tally([{ cents: 25_000, currency: 'USD' }]))
    expect(one).toBe('bills.csv is entirely in USD and totals 250.00.')

    const two = summarise(
      'invoices.csv',
      tally([{ cents: 650_000, currency: 'EUR' }, { cents: 8_134_894, currency: 'USD' }]),
    )
    expect(two).toContain('2 currencies (EUR 6500.00, USD 81348.94)')
    expect(two).toContain('no single total')
  })

  it('keeps its order between runs, so an export can be diffed', () => {
    const forwards = tally([{ cents: 1, currency: 'USD' }, { cents: 1, currency: 'EUR' }])
    const backwards = tally([{ cents: 1, currency: 'EUR' }, { cents: 1, currency: 'USD' }])

    expect(forwards).toEqual(backwards)
  })
})

describe('against the database', () => {
  /**
   * Splits one CSV line, respecting quotes.
   *
   * Written properly rather than as `line.split(',')`, which is the exact
   * failure this module defends against and which the first draft of this file
   * walked straight into: a chart-account description containing a comma made
   * the naive version count seven cells in a six-column file and fail a test
   * about the export, which was correct.
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

  /** Parses a CSV back into rows, so assertions read the file as a reader would. */
  const parse = (content: string) => {
    const [header, ...lines] = content.trim().split('\r\n')
    const columns = cells(header)
    return lines.map((line) => {
      const values = cells(line)
      return Object.fromEntries(columns.map((column, index) => [column, values[index]]))
    })
  }

  it('tells a euro invoice from a dollar one, and says what each was booked at', async () => {
    const fixture = await createCompanyFixture({ name: 'Trading Co' })
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-01-05', rateMillionths: 1_083_500 })

    const customer = await createCustomer(fixture.ctx, { name: 'Continental Ltd' })
    const income = await fixture.account('4000')

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-01-05',
      dueDate: '2026-02-05',
      currency: 'EUR',
      lines: [{ description: 'Work in euros', unitPriceCents: 650_000, chartAccountId: income.id }],
    })

    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-01-06',
      dueDate: '2026-02-06',
      lines: [{ description: 'Work at home', unitPriceCents: 100_000, chartAccountId: income.id }],
    })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['invoices'] })
    const rows = parse(result.files.find((f) => f.name === 'invoices.csv')!.content)

    const euro = rows.find((row) => row.total_currency === 'EUR')!
    const home = rows.find((row) => row.total_currency === 'USD')!

    // The defect, stated: before Phase 103 both of these were a bare `total`
    // column and the two were indistinguishable.
    expect(euro.total).toBe('6500.00')
    expect(euro.total_functional).toBe('7042.75')
    expect(euro.total_functional_currency).toBe('USD')

    expect(home.total).toBe('1000.00')
    expect(home.total_functional).toBe('1000.00')
  })

  it('says in the manifest that the file cannot be summed', async () => {
    const fixture = await createCompanyFixture({ name: 'Manifest Co' })
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-01-05', rateMillionths: 1_083_500 })

    const customer = await createCustomer(fixture.ctx, { name: 'Continental Ltd' })
    const income = await fixture.account('4000')

    for (const currency of ['EUR', 'USD'] as const) {
      await createInvoice(fixture.ctx, {
        customerId: customer.id,
        issueDate: '2026-01-05',
        dueDate: '2026-02-05',
        currency,
        lines: [
          { description: 'Work', unitPriceCents: 100_000, chartAccountId: income.id },
        ],
      })
    }

    const result = await exportCompanyData(fixture.ctx, { datasets: ['invoices'] })
    const manifest = result.files.find((file) => file.name === MANIFEST)!

    expect(manifest.content).toContain('invoices.csv,EUR')
    expect(manifest.content).toContain('invoices.csv,USD')
    expect(manifest.content).toContain('no single total')
  })

  it('counts the manifest as a file but not as rows of books', async () => {
    const fixture = await createCompanyFixture({ name: 'Counting Co' })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['customers'] })

    // The manifest describes the export; it is not part of what was exported.
    expect(result.files.map((file) => file.name)).toEqual(['customers.csv', MANIFEST])
    expect(result.rowCount).toBe(0)
  })

  it('names the company currency on the files that have no other', async () => {
    const fixture = await createCompanyFixture({ name: 'Ledger Co' })
    const cash = await fixture.account('1000')
    const revenue = await fixture.account('4000')
    const { postManualEntry } = await import('@/modules/ledger/journal')

    await postManualEntry(fixture.ctx, {
      entryDate: '2026-01-05',
      memo: 'A sale',
      lines: [
        { chartAccountId: cash.id, debitCents: 25_000 },
        { chartAccountId: revenue.id, creditCents: 25_000 },
      ],
    })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['journal'] })
    const rows = parse(result.files.find((f) => f.name === 'journal.csv')!.content)

    // The ledger is functional-currency by definition, so one column names it
    // for the whole file — and no money column in this export is bare.
    expect(rows.every((row) => row.currency === 'USD')).toBe(true)
  })

  it('lists the copies somebody took newest first', async () => {
    // This ordered `asc` until Phase 103, so the security page — which asks for
    // ten — answered "who took a copy of everything" with the first ten the
    // company ever took, and stopped changing after that.
    const fixture = await createCompanyFixture({ name: 'Copies Co' })
    const { listExports } = await import('@/modules/tenancy/export')

    await exportCompanyData(fixture.ctx, { datasets: ['customers'] })
    await exportCompanyData(fixture.ctx, { datasets: ['vendors'] })
    await exportCompanyData(fixture.ctx, { datasets: ['chart_of_accounts'] })

    const listed = await listExports(fixture.ctx, { limit: 2 })

    expect(listed).toHaveLength(2)
    expect(listed[0].datasets).toBe('chart_of_accounts')
    expect(listed[1].datasets).toBe('vendors')
  })

  it('still quotes a customer whose name holds a comma', async () => {
    // The failure this module already defended against, re-asserted because
    // the header and the row are now generated rather than written out.
    const fixture = await createCompanyFixture({ name: 'Quoting Co' })
    await createCustomer(fixture.ctx, { name: 'Smith, Jones & Co' })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['customers'] })
    const content = result.files[0].content

    expect(content).toContain('"Smith, Jones & Co"')
  })

  it('gives every row the same number of cells as the header', async () => {
    // A row and a header that disagree shift every value by one position, which
    // is the same failure as an unquoted comma reached from the other side.
    const fixture = await createCompanyFixture({ name: 'Shape Co' })
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-01-05', rateMillionths: 1_083_500 })

    const customer = await createCustomer(fixture.ctx, { name: 'Continental Ltd' })
    const income = await fixture.account('4000')
    await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-01-05',
      dueDate: '2026-02-05',
      currency: 'EUR',
      lines: [{ description: 'Work', unitPriceCents: 650_000, chartAccountId: income.id }],
    })

    const result = await exportCompanyData(fixture.ctx)

    for (const exported of result.files) {
      const lines = exported.content.trim().split('\r\n')
      const width = cells(lines[0]).length
      for (const [index, line] of lines.entries()) {
        expect(cells(line).length, `${exported.name} line ${index}`).toBe(width)
      }
    }
  })

  it('leaves the raw CSV writer alone', () => {
    expect(toCsv([{ a: 1, b: 'x,y' }], ['a', 'b'])).toBe('a,b\r\n1,"x,y"\r\n')
  })

  it('does not restate a foreign invoice at a later rate', async () => {
    // The rate moves after the invoice is raised. The export must still say
    // what it was booked at — Phase 35's whole reason for storing rates.
    const fixture = await createCompanyFixture({ name: 'Stable Co' })
    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-01-05', rateMillionths: 1_083_500 })

    const customer = await createCustomer(fixture.ctx, { name: 'Continental Ltd' })
    const income = await fixture.account('4000')
    const invoice = await createInvoice(fixture.ctx, {
      customerId: customer.id,
      issueDate: '2026-01-05',
      dueDate: '2026-02-05',
      currency: 'EUR',
      lines: [{ description: 'Work', unitPriceCents: 650_000, chartAccountId: income.id }],
    })

    const [stored] = await db
      .select({ functional: invoices.functionalTotalCents })
      .from(invoices)
      .where(eq(invoices.id, invoice.id))

    await putRate(fixture.ctx, { baseCurrency: 'EUR', rateDate: '2026-06-01', rateMillionths: 1_500_000 })

    const result = await exportCompanyData(fixture.ctx, { datasets: ['invoices'] })
    const rows = parse(result.files.find((f) => f.name === 'invoices.csv')!.content)

    expect(rows[0].total_functional).toBe(decimal(stored.functional))
    expect(rows[0].total_functional).toBe('7042.75')
  })
})
