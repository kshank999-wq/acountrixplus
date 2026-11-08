import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RegistryError } from '@/modules/errors/registry'
import {
  NOT_DELIVERABLES,
  PHASE_DELIVERABLES,
  deliverablesOfPhase,
  phaseDeliverableFor,
} from '@/modules/source/phases'

/**
 * The last unmeasured sentence (Phase 199, spec §20).
 *
 * `docs/SPEC-AUDIT.md` has said since Phase 164 that §20's state is *"Phases
 * 0–8 all have shipped work"*. ADR 0194 named it as the file's last unmeasured
 * claim, and Phases 195, 196, 197 and 198 each put something ahead of it.
 *
 * It is also the **weakest reading of §20 available**. "Has shipped work" is
 * true of a phase if anything in it shipped, and §20 is a table of nine cells
 * each listing several deliverables — exactly the shape where Phase 195 found
 * §11 had seven of seven *rows* and twenty-five of thirty-three *functions*.
 *
 * So the measurement is per deliverable: **51 of them**, each naming where it
 * shipped. And the answer is that the sentence holds in its strong reading
 * too — all fifty-one are built.
 *
 * ## A confirming measurement is still a measurement
 *
 * Phase 194 had to say this when its own hypothesis came out wrong, and it
 * applies again: the alternative was to go on deferring §20 on the strength of
 * nobody having looked. What changes is not the audit's verdict but what the
 * verdict rests on — a register of fifty-one named places instead of a
 * sentence.
 *
 * ## What the test can and cannot check
 *
 * ADR 0194 argued this file could not be made self-measuring, because *"all 12
 * have a module" is a judgement about what counts as a module, and
 * `PINNED_CLAIMS` measures integers*. Right about integers, and the way round
 * it: the judgement is written down once in `because`, and what a test holds is
 * everything around it — that the register's keys are §20's own words, that no
 * word of §20 is unaccounted for, and that every file it names exists.
 *
 * Whether the named file **is** the deliverable stays a person's job. That
 * division is the same one Phase 179 drew for `PINNED_CLAIMS`, and stating it
 * is what keeps this register from being the thing it was built to replace.
 */

/** §20's table, cell by cell, read from the specification. */
function phaseCells(): Map<number, string> {
  const spec = readFileSync('docs/SPEC.md', 'utf8')
  const section = spec.slice(spec.indexOf('## 20. Development Phases'), spec.indexOf('## 21.'))
  const cells = new Map<number, string>()

  for (const m of section.matchAll(/^\|\s*Phase (\d+)[^|]*\|\s*([^|]+?)\s*\|$/gm)) {
    cells.set(Number(m[1]), m[2].replace(/\s+/g, ' ').trim())
  }

  return cells
}

describe('the register against the specification', () => {
  const cells = phaseCells()

  it('reads all nine phases out of §20', () => {
    // The parse first: a register checked against a table nobody managed to
    // read is a register checked against nothing.
    expect([...cells.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(cells.get(0)).toContain('Repository audit')
    expect(cells.get(8)).toContain('compliance-heavy features')
  })

  it('declares fifty-one deliverables across the nine phases', () => {
    /**
     * Measured, not bounded (Phase 126). The per-phase counts are the shape of
     * §20 rather than a judgement: eight, eight, six, six, seven, six, six,
     * two, two.
     *
     * Phase 7's two and Phase 8's two are smaller because those cells are
     * written differently — one offers a choice and states a constraint, the
     * other names two families and a sequencing condition.
     */
    expect(PHASE_DELIVERABLES).toHaveLength(51)

    const perPhase = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((phase) => deliverablesOfPhase(phase).length)
    expect(perPhase).toEqual([8, 8, 6, 6, 7, 6, 6, 2, 2])
  })

  it('uses §20’s own words for every key', () => {
    /*
      Phase 182's device for `PROPOSAL_COMPONENTS`, applied to §20: the keys are
      the specification's wording, so the mapping is checked against the
      document rather than against my reading of it. Reword a cell and this
      fails, naming the deliverable that no longer appears.
    */
    for (const row of PHASE_DELIVERABLES) {
      const cell = cells.get(row.phase)
      expect(cell, `phase ${row.phase}`).toBeDefined()
      expect(cell, `${row.phase}: ${row.deliverable}`).toContain(row.deliverable)
    }
  })

  it('leaves no word of §20 unaccounted for', () => {
    /**
     * **The assertion that makes this a measurement rather than a list.**
     *
     * Containment only proves the register says nothing §20 does not. This
     * proves the other direction: strip every deliverable and every declared
     * non-deliverable out of a cell, and what is left must be punctuation and
     * conjunctions. A deliverable somebody forgot to register leaves words
     * behind, and the failure prints them.
     *
     * Without this, the register could cover two items of an eight-item cell
     * and pass — which is the §11 defect Phase 195 found, in the register
     * built to prevent it.
     */
    const leftovers: string[] = []

    for (const [phase, cell] of cells) {
      let remaining = cell
      for (const row of deliverablesOfPhase(phase)) remaining = remaining.replace(row.deliverable, '')
      for (const filler of NOT_DELIVERABLES) remaining = remaining.replace(filler, '')

      // Separators and conjunctions are all that may survive.
      const words = remaining.replace(/[,;.]/g, ' ').replace(/\band\b/g, ' ').trim()
      if (words.length > 0) leftovers.push(`phase ${phase}: ${words}`)
    }

    expect(leftovers).toEqual([])
  })
})

describe('the register against the tree', () => {
  it('names a file that exists for every deliverable', () => {
    /*
      Sixty-nine paths. This is what stops the sentence going quietly untrue:
      a deliverable whose module is renamed or deleted fails here rather than
      in somebody's memory a year later.

      It found four of its own on the first run — `src/modules/tax`,
      `src/modules/ai/layout.ts`, `src/modules/brand/brand.ts` and
      `src/db/schema/bookkeeping.ts` — all four written from what I expected
      the tree to look like rather than from what it does. Sales tax lives
      under `payroll/`, which is now said out loud in that entry.
    */
    const missing: string[] = []

    for (const row of PHASE_DELIVERABLES) {
      expect(row.evidence.length, row.deliverable).toBeGreaterThan(0)
      for (const path of row.evidence) {
        if (!existsSync(path)) missing.push(`${row.deliverable} → ${path}`)
      }
    }

    expect(missing).toEqual([])
  })

  it('argues each one by what shipped, not by whether it shipped', () => {
    /**
     * Phase 101's device with the floor where it belongs for this register:
     * *"this is built"* is not an argument — the register would say that of
     * everything. The argument has to name what the evidence does and, where
     * it matters, what it does not: three Phase 0 entries ship no code at all
     * and say so, and the vector engine's entry names the three primitives
     * that are refused rather than missing.
     */
    const thin = PHASE_DELIVERABLES.filter((row) => row.because.length < 140).map(
      (row) => row.deliverable,
    )

    expect(thin).toEqual([])
  })

  it('says where a deliverable shipped no code rather than inventing a module', () => {
    /*
      Repository audit, architecture and database conventions are Phase 0 acts
      whose product is a decision. Their evidence is the document that records
      it, which is honest; an entry pointing at a module would be the register
      dressing up a judgement as a measurement.

      Asserted on the paths rather than on a flag, because a flag would be
      something somebody sets and this is something the entry shows.
    */
    const documentOnly = PHASE_DELIVERABLES.filter((row) =>
      row.evidence.every((path) => path.startsWith('docs/')),
    ).map((row) => row.deliverable)

    expect(documentOnly).toEqual(['Repository audit'])

    // The other two name a document *and* the tree it describes, which is the
    // stronger claim: the convention is written down and followed.
    for (const key of ['architecture', 'database conventions']) {
      const row = phaseDeliverableFor(key)
      expect(row.evidence.some((path) => path.startsWith('docs/')), key).toBe(true)
      expect(row.evidence.some((path) => path.startsWith('src/')), key).toBe(true)
    }
  })
})

describe('the register refuses what it does not know', () => {
  it('throws on a deliverable §20 never promised', () => {
    expect(() => phaseDeliverableFor('blockchain')).toThrow(RegistryError)
    try {
      phaseDeliverableFor('blockchain')
      expect.unreachable()
    } catch (error) {
      expect((error as RegistryError).registry).toBe('PHASE_DELIVERABLES')
      expect((error as RegistryError).message).toContain('§20 never promised')
    }
  })

  it('throws on a phase outside nought to eight', () => {
    expect(() => deliverablesOfPhase(9)).toThrow(RegistryError)
    expect(() => deliverablesOfPhase(-1)).toThrow(/runs 0 to 8/)
  })
})
