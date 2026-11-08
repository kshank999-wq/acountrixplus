import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  byGuard,
  readableSource,
  scanWrites,
  sourceFiles,
} from '@/modules/source/isolation-scan'
import { RegistryError } from '@/modules/errors/registry'
import {
  guardFor,
  ISOLATION_GUARDS,
  isolationGuardFor,
} from '@/modules/tenancy/isolation'

/**
 * What a write stands on when it is not `scoped()` (Phase 149).
 *
 * No database, no clock — it reads the source.
 *
 * The guards are declared in the module and argued there. Which guard a given
 * write has is measured in `modules/source/isolation-scan`, so an entry cannot
 * go on being true after the line that made it true is deleted.
 *
 * **The scanner moved out of this file in Phase 187**, after thirty-eight
 * phases here. Moving it is what let `PINNED_CLAIMS` measure the sentence that
 * quotes these numbers — and it found that this file's `readable()` had
 * drifted from the reads scan's and was the wrong one of the two. See the
 * module.
 */

const WRITES = scanWrites()

describe('the guards a write can stand on', () => {
  it('argues each one, and says what the scan looks for', () => {
    for (const guard of ISOLATION_GUARDS) {
      expect(guard.because.length, guard.kind).toBeGreaterThan(140)
      expect(guard.detect.length, guard.kind).toBeGreaterThan(40)
    }
  })

  it('does not call a system path company-tight', () => {
    // ADR 0134: a declaration that excuses a site is worse than one that misses
    // it. These three are legitimate and they are not tenant guards, and
    // flattening them into "guarded" is what would make the register useless.
    const loose = ISOLATION_GUARDS.filter((g) => !g.atLeastCompanyTight).map((g) => g.kind)
    expect(loose).toEqual(['bearer-credential', 'caller-established', 'system-actor'])
  })

  it('refuses a guard nobody declared', () => {
    expect(() => isolationGuardFor('trust-me')).toThrow(RegistryError)
    try {
      isolationGuardFor('trust-me')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('ISOLATION_GUARDS')
    }
  })
})

describe('every write that can be aimed at a row', () => {
  it('counts them, and counts what each one stands on', () => {
    // Measured, not bounded (Phase 126). An empty scan agrees with everything,
    // and so does one that finds six sites and calls them representative.
    //
    // The distribution is the phase's finding in one object: `scoped()` guards
    // twenty-seven of the hundred and nine, and `explicit-company` guards more
    // than twice as many.
    //
    // It was a hundred and six until Phase 150 found the table detector here
    // reading past a closing brace — seven company-scoped tables were invisible
    // to this scan, and the conclusion survived while three of the numbers did
    // not. The tables come from the module now, so both scans count the same
    // thing.
    const by = byGuard(WRITES)

    // A hundred and ten since Phase 155, which added one: marking a stage
    // billed. `scoped-write` at 28 — the update is keyed by proposal and sort
    // order *and* scoped to the company, which is what makes the id a caller
    // hands in unable to reach another tenant's contract.
    //
    // **A hundred and eleven since Phase 166**, which added
    // `applyLayoutSuggestion` — an accepted layout suggestion moving a
    // document's blocks. It was guarded from the start, on the `companyId` in
    // the scoped select above it, so the distribution moved by one and the
    // conclusion did not. What was wrong for three phases was this number.
    //
    // Found in Phase 169, which is the point worth keeping: no full suite
    // completed between Phase 160 and Phase 169, and no targeted run named this
    // file. A scan that counts the whole tree cannot be checked by running the
    // tests near the code that changed — the second tripwire to go red for
    // exactly that reason, after `refusal-audience` in Phase 167.
    //
    // **A hundred and eighteen since Phase 183**, and six of those are not new
    // code. Four are the writes the fixed 600-character window never reached
    // (see the scanner above): `changeStage`, `billStage`, `issueToken` and
    // this phase's `updateTeamMember`. Two more are `retireTeamMember` and
    // `restoreTeamMember`, which are new.
    //
    // So the honest reading of this number moving by six is "one write added,
    // one write added, and four that have been there for up to a hundred and
    // seventy phases without this file looking at them". Every one of the four
    // is guarded — none of them is a disclosure — and a scan that cannot see a
    // write cannot say that, which is Phase 160's shape: a control that does
    // not fire.
    //
    // `explicit-company` at 68 and `scoped-write` at 29: the five writes the
    // team directory makes are keyed by an id a caller hands in *and* filtered
    // on the acting company, which is what stops one tenant retiring another's
    // principal by guessing a uuid.
    //
    // Counted in the phase that added it, as Phase 180 started doing. The three
    // counts Phase 177 moved went unnoticed for two phases and Phase 179's full
    // run found them, which is the argument for running this file in the phase
    // rather than after it.
    //
    // 119 since Phase 195 and the proposal expiry sweep — one `update` keyed
    // by the row's own id and filtered on the acting company. Worth saying
    // where it nearly was not counted: `scanWrites` recognised a keyed write
    // from `eq(x.y, input.z)` or `eq(x.y, zId)`, so the same write expressed
    // as `eq(proposals.id, proposal.id)` was invisible here. ADR 0195
    // nominated that blind spot; this number was a floor, not a total.
    //
    // **Two hundred and seventy-six since Phase 196**, and not one line of new
    // application code. 157 of them were already in the tree and outside this
    // census: the key pattern is the read side's `[\w.]+` now, so
    // `eq(proposals.id, proposal.id)`, `eq(x.id, id)` and
    // `eq(x.id, placeholder)` are all seen. The census had been reporting 119
    // of 276 — **43%** — under a sentence in `isolation.ts` that read as a
    // total, and §19's "strong tenant isolation" paragraph is argued from it.
    //
    // Measured before it was widened, because the whole question was whether
    // any of the invisible ones was a disclosure: all 157 classify, and the six
    // that the write vocabulary had no word for were read one at a time and are
    // each an id taken from a row the function already fetched under a tenant
    // or actor scope. `id-from-fetched-row` is that word; the read classifier
    // has had it since Phase 150 and the write classifier had no input that
    // could ever return it, although the guard's own prose claimed the
    // distinction "makes the whole narrowing of both scans possible".
    //
    // `explicit-company` carries most of the growth, at 187. The honest reading
    // is not that this codebase got safer in Phase 196 — it is that 157 writes
    // which were always guarded can now be *seen* to be, and the one that could
    // not be justified got a `scoped()` so that it can.
    //
    // **Two hundred and eighty-four since Phase 197**, and again no new
    // application code. Two more layers of the same defect: the census
    // recognised a table by its *name*, so 5 writes through a variable
    // (`kind === 'customer' ? customers : vendors`) were invisible; and it
    // recognised a key as an `eq`, so 3 keyed only by `inArray` were too. Both
    // are the shape Phase 196 fixed in the key *value*, one argument to the
    // left and one function to the right, and both were missed by Phase 196
    // for the reason it gave for the 157: the scan was asked what the scan
    // could see.
    //
    // Two of the variable-table writes are in `importing/reversal.ts`, which
    // deletes the rows an import created — so the census had never looked at
    // a destructive generic helper.
    //
    // **Two hundred and ninety-one since Phase 198**, and the last seven are a
    // different syntax rather than another missed name: the party merge's raw
    // `update` and `delete` statements, which go through
    // `tx.execute(sql`…`)` because the table comes from `PARTY_REFERENCES` at
    // runtime. Phase 196 asserted they carried a tenant predicate in a test
    // beside this census; they are *in* it now, so §19 quotes one denominator.
    //
    // **Two hundred and ninety-two since Phase 201**, and this one *is* new
    // application code: `setItemPostingAccounts`, the editor for a posting
    // account that had a reader in three places and no writer anywhere. One
    // `scoped-write`. The census moved by one and five documents had to
    // follow — `PINNED_CLAIMS` reported four of them and this assertion, which
    // nothing pins, was the sixth place the number lives.
    //
    // **Two hundred and ninety-three since Phase 202** and
    // `updateMembership`, which gave `memberships` its first update statement
    // in 202 phases: the role, the granular overrides and whether somebody
    // still has access, all of which were read and none of which could be
    // changed. One `scoped-write`.
    expect(WRITES.length).toBe(297)
    expect(by).toEqual({
      'explicit-company': 199,
      'scoped-write': 58,
      'read-then-refuse': 16,
      'id-from-fetched-row': 8,
      // Phase 204's own three writes land on two of these, and one existing
      // `owner-helper` write became `explicit-company` because
      // `removePracticeMember`'s delete now filters on the engagements it
      // selected rather than on a bare list of ids. The distribution is
      // measured, not predicted — guessing it is what made this assertion red.
      'system-actor': 4,
      'actor-scoped': 4,
      'owner-helper': 3,
      'caller-established': 3,
      'bearer-credential': 2,
    })
  })

  it('has a guard for every single one', () => {
    // **The assertion the phase exists for.** A write on a company-scoped table,
    // keyed by an id somebody handed in, with nothing establishing whose row it
    // is, is a cross-tenant write — the most serious defect this system can
    // have. Today there are none, and this is what keeps that true.
    const unguarded = WRITES.filter((w) => w.kind === null).map(
      (w) => `${w.file}:${w.line} ${w.symbol} — ${w.op} ${w.table}`,
    )

    expect(unguarded).toEqual([])
  })

  it('does not rest on `scoped()` at every query, whatever the README said', () => {
    // The sentence this phase was built to check:
    //
    //   > tenant isolation rests on `scoped()` at every query
    //
    // It rests on `scoped()` at about a sixth of the writes that can be aimed
    // at a row — a quarter of them when the census could see only 119. The
    // sentence is corrected rather than the code, because the code is right:
    // nine guards now, every one of them sound, and nothing that recorded
    // which was which.
    //
    // Nine since Phase 196, and the ninth is `id-from-fetched-row`. It is not
    // a guard this phase invented — the read classifier has stood eight reads
    // on it since Phase 150 — it is a guard the write classifier could not
    // name, so the eight writes that rely on it were outside the census
    // altogether rather than reported under something weaker.
    const scoped = WRITES.filter((w) => w.kind === 'scoped-write').length

    expect(scoped).toBeLessThan(WRITES.length / 2)
    expect(new Set(WRITES.map((w) => w.kind)).size).toBe(9)
  })

  it('uses every guard it declares, so none is kept for a case that never arises', () => {
    // The other direction. A guard nothing uses is a rule written for a
    // situation somebody imagined, and it would quietly start excusing a real
    // site the day the scan widened.
    const used = new Set(WRITES.map((w) => w.kind))
    // It has already earned its keep: `parent-scoped` was a tenth guard until
    // this line reported it as used by nothing. It was `read-then-refuse` with
    // the refusal one table up, and a distinction the measurement collapses is
    // not a distinction.
    //
    // `conditions-array` is exempt because it is a **read** guard — the trial
    // balance and the ledger detail assemble their scope into a list — and this
    // scan looks only at writes. Exempting it here rather than deleting it is
    // the honest option, and the exemption is named rather than silent.
    const unused = ISOLATION_GUARDS.map((g) => g.kind).filter(
      (kind) => !used.has(kind) && kind !== 'conditions-array',
    )

    expect(unused).toEqual([])
  })
})

describe('the two the first run of this scan called unguarded', () => {
  it('sees a filter on the acting user, which is stricter than the company', () => {
    // `revokeDevice` and `renameDevice` filter `devices.userId = ctx.userId`, so
    // a colleague in the same company cannot rename your phone. The first
    // version of this scan looked for `companyId` and reported both as
    // unguarded — the tightest rule in the codebase, invisible to a check
    // shaped like the loosest one. Eleventh instance of that family.
    const devices = WRITES.filter((w) => w.file.endsWith('mobile/devices.ts'))

    expect(devices.length).toBeGreaterThan(1)
    expect(devices.some((w) => w.kind === 'actor-scoped')).toBe(true)
  })

  it('would have reported them as company-scoped if it only looked for companyId', () => {
    // A check seen to disagree (Phase 121), against the version that was wrong.
    const src = readableSource('src/modules/mobile/devices.ts')
    const rename = src.slice(src.indexOf('function renameDevice'))

    expect(/companyId/.test(rename.slice(0, 500))).toBe(false)
    expect(/userId\s*,\s*ctx\.userId/.test(rename.slice(0, 500))).toBe(true)
  })
})

describe('the guards that depend on something further away', () => {
  it('keeps the caller-established helpers where their callers can be read', () => {
    // The weakest guard, and the test that keeps it honest. `recordPostedRate`
    // is module-private. `touchDevice` is exported and safe only because its
    // one caller passes an id an authenticated session established — a property
    // of the call site, so the call sites are named here.
    const posting = readFileSync('src/modules/ledger/posting.ts', 'utf8')
    expect(posting).toMatch(/^async function recordPostedRate/m)
    expect(posting).not.toMatch(/^export async function recordPostedRate/m)

    const callers = sourceFiles('src')
      .filter((file) => !file.endsWith('mobile/devices.ts'))
      .filter((file) => /\btouchDevice\(/.test(readableSource(file)))

    expect(callers).toEqual(['src/app/api/mobile/v1/sync/route.ts'])
    expect(readableSource(callers[0])).toMatch(/touchDevice\(\s*session\.deviceId/)
  })

  it('keeps the system paths out of reach of an actor', () => {
    // "It is a system path" is exactly what somebody would write to excuse a
    // real one, so it is measured: these take no ActorContext at all.
    const system = WRITES.filter((w) => w.kind === 'system-actor')
    expect(system.length).toBeGreaterThan(2)

    for (const write of system) {
      expect(write.file, write.symbol).toMatch(/\/worker\//)
    }
  })
})

describe('the verdict on its own', () => {
  it('refuses a write with nothing behind it', () => {
    const verdict = guardFor({
      scopedInStatement: false,
      companyInStatement: false,
      conditionsArray: false,
      actorFiltered: false,
      ownerHelper: null,
      readThenRefuse: false,
      bearerToken: false,
      keyIsRowProperty: false,
      takesActorContext: true,
      exported: true,
      systemPath: false,
    })

    expect(verdict.guarded).toBe(false)
    if (!verdict.guarded) expect(verdict.why).toMatch(/nothing in it establishes whose row/)
  })

  it('prefers the guard a reader would rely on when there are two', () => {
    // A site with both a scope in the statement and an owner helper above is
    // reported under the statement, because that is the one that cannot be
    // separated from the write.
    expect(
      guardFor({
        scopedInStatement: true,
        companyInStatement: true,
        conditionsArray: false,
        actorFiltered: false,
        ownerHelper: 'loadOwnEditable',
        readThenRefuse: true,
        bearerToken: false,
        keyIsRowProperty: false,
        takesActorContext: true,
        exported: true,
        systemPath: false,
      }),
    ).toEqual({ guarded: true, kind: 'scoped-write' })
  })

  it('does not let a system path excuse a function that has an actor', () => {
    // The excuse that had to be checkable. A worker file is not a licence.
    const verdict = guardFor({
      scopedInStatement: false,
      companyInStatement: false,
      conditionsArray: false,
      actorFiltered: false,
      ownerHelper: null,
      readThenRefuse: false,
      bearerToken: false,
      keyIsRowProperty: false,
      takesActorContext: true,
      exported: true,
      systemPath: true,
    })

    expect(verdict.guarded).toBe(false)
  })
})
