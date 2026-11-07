import { describe, expect, it } from 'vitest'
import {
  byGuard,
  readableSource,
  scanReads,
  statementAt,
} from '@/modules/source/isolation-scan'
import { ALL_ISOLATION_GUARDS, readGuardFor } from '@/modules/tenancy/isolation'

/**
 * What a read stands on (Phase 150, spec §14/§19).
 *
 * No database, no clock — it reads the source.
 *
 * ADR 0149 nominated this: a `select` that returns another company's rows is a
 * breach whether or not anything was written, and that phase measured only the
 * writes because they are the shape that can be aimed.
 *
 * **The scanner moved to `modules/source/isolation-scan` in Phase 187.** It
 * lived here for thirty-seven phases, and the cost of that was precise:
 * `PINNED_CLAIMS` could not measure the sentence in `isolation.ts` that quotes
 * these numbers, so the entry was declared unmeasured and then corrected by
 * hand in every phase that touched a read — 180, 183, 184, 185 and 186. This
 * file now asserts what the module measures, and the register measures it too,
 * from the same function.
 */

const READS = scanReads()

describe('every read from a company-scoped table', () => {
  it('has a guard, all eight hundred and sixty-six of them', () => {
    // **The assertion the phase exists for.** A select with nothing
    // establishing whose rows it returns is a breach whether or not anything
    // was written, and ADR 0149 left this half unmeasured.
    const unguarded = READS.filter((r) => r.kind === null).map(
      (r) => `${r.file}:${r.line} ${r.symbol} — from ${r.table}`,
    )

    expect(unguarded).toEqual([])
  })

  it('counts them, and what each one stands on', () => {
    // Measured, not bounded (Phase 126).
    const by = byGuard(READS)

    // Eight hundred and sixty-six since Phase 151: `recordContribution` reads
    // the bank account through `bankGlAccountFor` now instead of selecting it
    // itself, so a read left this file for a gate that was already counted.
    // Eight hundred and sixty-eight since Phase 154, which added two: the
    // billing schedule a proposal carries, read per proposal when one is
    // converted and in bulk for the list. Both go through `scoped()`, which is
    // why the whole increase lands on one guard.
    //
    // Eight hundred and seventy-five since Phase 155 and `stage-invoicing.ts`,
    // which reads the schedule, the proposal, the opportunity's client and the
    // proposal's revenue account to bill a stage. All seven go through
    // `scoped()` — measured, not assumed: the length assertion fails before this
    // map is compared, so the figure below came from running it and reading the
    // diff rather than from counting call sites.
    //
    // Eight hundred and seventy-eight since Phase 156 and `stageStatesFor`, which
    // reads the stored stages to ask whether a schedule may be replaced. Three
    // reads, all `scoped-read`, measured the same way: by writing the length and
    // reading which guard the map said had grown.
    //
    // Eight hundred and eighty-three since Phase 158 and the accountant export
    // engine. Five reads, and all five land on `explicit-company` rather than
    // `scoped()` — the first time a phase's additions have gone entirely to that
    // guard, which is worth a sentence rather than letting the figure move.
    //
    // Four are in `exporter/package.ts`: the general ledger detail, its totals,
    // the orphan-line count and the draft count. Each joins `journal_lines` to
    // `journal_entries` and filters on the company column of the table the date
    // and status filters are already on — the same three filters
    // `accountBalances` applies, written a second time on purpose, because
    // §11's `detail_ties_to_balances` is what notices if the two ever stop
    // matching. The fifth is `exportHistory` over the export log.
    //
    // `companyProfile` and `taxIdentifier` are not here, and should not be: they
    // read the `companies` row itself, which carries no `company_id` because its
    // own `id` is the tenant. Measured the same way as the phases above — by
    // writing the length and reading which guard the map said had grown.
    /*
      **911 since Phase 179, and the number is the finding.** 883 was written in
      Phase 158 and did not move for twenty phases, across twenty-eight new
      reads from company-scoped tables — the longest-standing stale count this
      session found, and found only by its first complete full-suite run.

      What makes it survivable rather than serious is the assertion below it:
      every read this scan finds has to stand on a guard, and all 911 do. So
      twenty phases of reads were written correctly and counted wrongly. The
      count is what nobody maintained; the property it is attached to held.

      The distribution moved in three places and nowhere else — `scoped-read`
      +15, `explicit-company` +10, `established-above` +3 — which says the new
      reads were written in the shapes already here rather than inventing a new
      guard nobody had argued for.
    */
    /*
      916 since Phase 180, all five on `scoped-read`: the four reads
      `asset-links.ts` makes of `asset_links`, plus the one `assets` join that
      the scan counts separately. Every one goes through `scoped()`, which is
      what the distribution moving in exactly one place says.
    */
    /*
      921 since Phase 183 and the team directory. Four on `scoped-read` — the
      headcount `addTeamMember` checks the limit against, the id list
      `reorderTeamMembers` validates an order against, `loadMember`, and
      `listTeamMembers` — and one on `explicit-company`: `teamForDocument`,
      which takes a bare `companyId` rather than an actor because the public
      proposal page renders for somebody with no session at all.

      That last one is the distribution saying something true. A read with no
      actor behind it is the shape that has to be looked at hardest, and it is
      the shape the client-facing document necessarily has.
    */
    /*
      922 since Phase 185, and the one new read is `explicit-company`: the
      brand kit's `logoAssetId`, read by `proposalRenderInput` so a `cover`
      block can print the logo. Explicit rather than `scoped()` because the
      public proposal page renders for somebody with no session, which is the
      same shape `teamForDocument` has and for the same reason.

      `readAsset` is not a second one. It gained an `Executor` parameter so the
      send path reads the picture inside the transaction that writes the
      version — the read itself is the one that was already there.
    */
    /*
      924 since Phase 186 and the two reads a crop needs: `assetSizes`, which
      is `explicit-company` because the client-facing proposal page has no
      session behind it, and `measureStoredAssets`, which is `scoped-read`
      because it is an operation somebody with `company:manage` runs.

      The split is the distribution saying something true again: the read that
      serves a stranger is explicit, and the one that serves an operator goes
      through `scoped()`.
    */
    /*
      929 since Phase 188 and `client-link.ts`, which serves a client the
      version they were sent rather than the live record.

      The spread is what the module is: two `scoped-read` where the design
      document and the brand kit are read as a fallback for a version written
      before the snapshot carried them, two `id-from-fetched-row` where the
      items and the version hang off a proposal already fetched, and one
      `derives-tenant-from-row` — the proposal itself, found by a public token
      with no actor anywhere, which is the guard a client-facing page
      necessarily stands on.
    */
    /*
      934 since Phase 189 and the client's version history. Five reads, and
      the spread says what the feature is: one `derives-tenant-from-row` for
      the proposal found by a public token with no actor anywhere, two
      `id-from-fetched-row` for the versions and the views that hang off it,
      and two `established-above` in `versionForClient`, which re-reads under
      a tenant the history above it has already settled.
    */
    /*
      935 since Phase 195 and the expiry sweep, which reads the proposals it
      is about to lapse so the audit trail can say which status each came
      from. One read, `scoped-read`, and the write beside it is the hundred
      and nineteenth.
    */
    /*
      950 since Phase 197, and all fifteen are the same thing: a read whose
      table is held in a variable. `.from(invoices)` counted and `.from(table)`
      did not, because `table` is not in the schema — so fifteen reads through
      generic helpers were not reported as unguarded, they were not reads. The
      key-pattern defect Phase 196 fixed, one argument to the left.

      Every one is guarded, and the spread says what the helpers are: nine
      `explicit-company` where the where writes the filter out, and six
      `scoped-read` where it goes through `scoped(ctx, table, …)`.
    */
    expect(READS.length).toBe(950)
    expect(by).toEqual({
      'scoped-read': 577,
      'explicit-company': 273,
      'established-above': 33,
      'id-from-fetched-row': 21,
      'join-inherited': 13,
      'derives-tenant-from-row': 14,
      'caller-established': 7,
      'conditions-array': 4,
      'actor-scoped': 3,
      'validated-above': 3,
      'system-actor': 2,
    })
  })

  it('is guarded differently from the writes, which nobody had noticed', () => {
    // The finding worth keeping beside the counts. `scoped()` covers 61% of
    // reads and 25% of writes. Both are sound; they are not the same system,
    // and nothing had counted either half until Phases 149 and 150.
    const scoped = READS.filter((r) => r.kind === 'scoped-read').length
    expect(scoped / READS.length).toBeGreaterThan(0.55)
  })
})

describe('the statement this scan reads', () => {
  it('does not stop at a `where` whose argument is on the next line', () => {
    // The bug that produced 113 false positives, kept as a case. A line-based
    // walker ends the statement here; counting brackets does not.
    const src = [
      '  return db',
      '    .select()',
      '    .from(auditEvents)',
      '    .where(',
      '      scoped(ctx, auditEvents),',
      '    )',
      '    .limit(limit)',
      '',
      'const after = 1',
    ].join('\n')

    const statement = statementAt(src, src.indexOf('.from('))
    expect(statement).toMatch(/scoped\(ctx, auditEvents\)/)
    expect(statement).not.toMatch(/const after/)
  })

  it('agrees with the suite that has proved this one isolates since Phase 122', () => {
    // `recentActivity` is asserted tenant-isolated by behaviour in
    // `tests/tenant-isolation.test.ts`. A scan that called it unguarded would
    // be disagreeing with a test that actually creates two companies — and the
    // first version of this one did.
    const activity = READS.filter((r) => r.symbol === 'recentActivity')
    expect(activity.length).toBeGreaterThan(0)
    for (const read of activity) expect(read.kind).toBe('scoped-read')
  })
})

describe('the guards reads have and writes do not', () => {
  it('declares which side each guard belongs to', () => {
    for (const guard of ALL_ISOLATION_GUARDS) {
      expect(['read', 'write', 'both']).toContain(guard.appliesTo)
      expect(guard.because.length, guard.kind).toBeGreaterThan(140)
    }
  })

  it('uses every read guard it declares', () => {
    // The direction that catches a rule written for a case nobody has.
    const used = new Set(READS.map((r) => r.kind))
    const unused = ALL_ISOLATION_GUARDS.filter(
      (g) => g.appliesTo === 'read' && !used.has(g.kind),
    ).map((g) => g.kind)

    expect(unused).toEqual([])
  })

  it('keeps the one that establishes the tenant rather than confirming it', () => {
    // `settleCheckout` is the whole argument for `derives-tenant-from-row`: a
    // webhook from a payment processor, keyed by the processor's own id, with
    // no actor to filter against. Its comment says so, and this is what keeps
    // the comment true.
    const service = readableSource('src/modules/payments/service.ts')
    expect(service).toMatch(/export async function settleCheckout\(\s*providerCheckoutId/)
    expect(service).not.toMatch(/export async function settleCheckout\([^)]*ctx/)
  })

  it('does not call a webhook path company-tight', () => {
    const guard = ALL_ISOLATION_GUARDS.find((g) => g.kind === 'derives-tenant-from-row')
    expect(guard?.atLeastCompanyTight).toBe(false)
  })
})

describe('the verdict on its own', () => {
  const bare = {
    scopedInStatement: false,
    companyInStatement: false,
    conditionsArray: false,
    actorFiltered: false,
    joined: false,
    establishedAbove: false,
    validatedAbove: false,
    keyIsRowProperty: false,
    takesActorContext: true,
    exported: true,
    systemPath: false,
  }

  it('refuses a read with nothing behind it', () => {
    const verdict = readGuardFor(bare)
    expect(verdict.guarded).toBe(false)
    if (!verdict.guarded) expect(verdict.why).toMatch(/breach whether or not anything was written/)
  })

  it('does not let a worker path excuse a function that has an actor', () => {
    expect(readGuardFor({ ...bare, systemPath: true }).guarded).toBe(false)
  })

  it('prefers the scope in the statement when there is more than one', () => {
    expect(
      readGuardFor({ ...bare, scopedInStatement: true, joined: true, establishedAbove: true }),
    ).toEqual({ guarded: true, kind: 'scoped-read' })
  })
})
