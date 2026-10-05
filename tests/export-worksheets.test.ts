import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  WORKSHEETS,
  requireWorksheet,
  verifiedWorksheets,
  worksheetFor,
  worksheetStands,
  type Worksheet,
} from '@/modules/exporter/worksheets'
import {
  EXPORT_DESTINATIONS,
  adapterMayBeBuilt,
  destinationFor,
  integrationFor,
  mayExportTo,
  offerableDestinations,
} from '@/modules/exporter/destinations'
import { RegistryError } from '@/modules/errors/registry'

/**
 * The §13 integration worksheets (Phase 159).
 *
 * Exporter spec §13 requires, before any adapter code, *"a one-page integration
 * worksheet"* answering twelve questions and citing *"what official vendor
 * documentation supports the decision."* Phase 159 researched all fourteen
 * Priority 1 targets and wrote them.
 *
 * None is verified, and these tests are mostly about holding that line: a
 * worksheet promoted without somebody opening the pages it cites would be worse
 * than no worksheet, because the registry's whole purpose is to be the thing a
 * reader trusts.
 */

/** The Priority 1 destinations, from the destination registry rather than a list. */
function priorityOne(): string[] {
  return EXPORT_DESTINATIONS.filter((row) => row.priority === 1).map((row) => row.key)
}

describe('every Priority 1 target has a worksheet', () => {
  it('covers exactly the Priority 1 destinations, and no others', () => {
    // Derived from the destination registry's own `priority` column rather than
    // written out, so adding a Priority 1 target fails here until it has a
    // worksheet. That is §13 as a tripwire.
    expect(WORKSHEETS.map((row) => row.destinationKey).sort()).toEqual(priorityOne().sort())
    expect(WORKSHEETS).toHaveLength(14)
  })

  it('names a destination that exists', () => {
    for (const worksheet of WORKSHEETS) {
      expect(() => destinationFor(worksheet.destinationKey), worksheet.destinationKey).not.toThrow()
    }
  })

  it('points at a page that is really on disk', () => {
    /**
     * Phase 141's rule — declare the knowledge, measure the fact — against the
     * registry's own claim. A `path` naming a worksheet nobody wrote is the
     * same defect as a `produces` naming a function nobody wrote, which
     * `export-engine.test.ts` already catches one module over.
     */
    const missing = WORKSHEETS.filter((worksheet) => !existsSync(worksheet.path)).map(
      (worksheet) => worksheet.path,
    )

    expect(missing).toEqual([])
  })

  it('answers all twelve of §13’s questions on every page', () => {
    // The clause is a list and the worksheets are one page each, so the check is
    // that each page actually addresses each question rather than that it is
    // long. Matched on the question's distinguishing words.
    const questions: Array<[string, RegExp]> = [
      ['public API', /public API\?/i],
      ['private/partner API', /private\/partner API\?/i],
      ['desktop SDK or local bridge', /[Dd]esktop SDK or local bridge\?/],
      ['trial balance import', /[Ii]mports a trial balance directly\?/],
      ['GL detail import', /[Ii]mports GL detail\?/],
      ['adjusting entries', /[Ii]mports adjusting journal entries\?/],
      ['file formats', /File formats/],
      ['tax/account codes', /[Tt]ax\/account codes required\?/],
      ['approval or certification', /[Aa]pproval, licence, NDA, certification\?/],
      ['recommended path', /Recommended Accountrix path/],
      ['fallback manual path', /Fallback manual path/],
      ['supporting documentation', /[Ss]upporting documentation/],
    ]

    const faults: string[] = []

    for (const worksheet of WORKSHEETS) {
      const page = readFileSync(worksheet.path, 'utf8')
      for (const [name, pattern] of questions) {
        if (!pattern.test(page)) faults.push(`${worksheet.destinationKey}: no answer for ${name}`)
      }
    }

    expect(faults).toEqual([])
  })

  it('cites something, and marks how far each answer can be trusted', () => {
    /**
     * §13's last requirement is *"what official vendor documentation supports
     * the decision"*, and the honest version of that here carries a provenance
     * mark, because the research environment's egress policy blocked every
     * vendor documentation host. An answer from a page nobody opened is
     * different in kind from one somebody read.
     */
    const faults: string[] = []

    for (const worksheet of WORKSHEETS) {
      const page = readFileSync(worksheet.path, 'utf8')

      if (!/^## Sources$/m.test(page)) {
        faults.push(`${worksheet.destinationKey}: no Sources section`)
      }
      // At least three citations, which is the point at which a worksheet is
      // reporting rather than repeating one page.
      const links = page.match(/\]\(https?:\/\//g) ?? []
      if (links.length < 3) {
        faults.push(`${worksheet.destinationKey}: only ${links.length} citations`)
      }
      if (!/\bnot verified against a page anybody opened\b/.test(page)) {
        faults.push(`${worksheet.destinationKey}: does not say its status in the header`)
      }
    }

    expect(faults).toEqual([])
  })
})

describe('the line between researched and verified', () => {
  it('holds: nothing is verified, so nothing authorises an adapter', () => {
    /**
     * The assertion this whole phase turns on. Every answer in every worksheet
     * rests on a summary of a vendor page that the research environment would
     * not let anybody fetch — `accountants.intuit.com`,
     * `tax.thomsonreuters.com`, `support.cch.com`, `drakesoftware.com`,
     * `documentation.caseware.com` and the rest were all blocked.
     *
     * §13 is a clause about having read the documentation. Promoting a
     * worksheet without reading it would be a declaration argued from a fact
     * that is not a fact (Phases 110, 125), in the register whose job is to be
     * trusted.
     *
     * When somebody does verify one, this assertion is what they have to come
     * and change — deliberately, so it cannot happen by accident.
     */
    expect(verifiedWorksheets()).toEqual([])
    expect(WORKSHEETS.every((worksheet) => worksheet.status === 'draft')).toBe(true)
  })

  it('still refuses every adapter, with a different sentence than before', () => {
    for (const key of priorityOne()) {
      const verdict = adapterMayBeBuilt(key)
      expect(verdict.ok, key).toBe(false)
      if (verdict.ok) continue

      // Not "no worksheet exists" any more. The refusal names what verifying
      // would involve and the one question most likely to change the design,
      // because "nobody has looked" and "somebody looked and could not open the
      // page" need different next steps.
      expect(verdict.why).toContain('worksheet is a draft')
      expect(verdict.why).toContain('nobody opened')
      expect(verdict.why).toContain(worksheetFor(key)!.blocker)
    }
  })

  it('refuses a Priority 2 target the old way, because nobody has looked', () => {
    // The contrast, and the reason both sentences exist. Phase 159 researched
    // Priority 1 only.
    const verdict = adapterMayBeBuilt('sage-intacct')

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('No integration worksheet exists')
    expect(verdict.why).toContain('§13')
  })

  it('offers nothing but the universal package, still', () => {
    expect(offerableDestinations().map((row) => row.key)).toEqual(['universal'])
  })
})

describe('what the refusals tell an accountant', () => {
  it('tells a researched destination apart from an unresearched one', () => {
    const researched = mayExportTo('caseware-working-papers')
    expect(researched.ok).toBe(false)
    if (researched.ok) return
    expect(researched.why).toContain('has been researched and the research has not been checked')
    // The useful part: what was found, and what is outstanding.
    expect(researched.why).toContain('Two CSV files Accountrix already produces')
    expect(researched.why).toContain('docs/exporter/worksheets/caseware-working-papers.md')

    const unresearched = mayExportTo('netsuite')
    expect(unresearched.ok).toBe(false)
    if (unresearched.ok) return
    expect(unresearched.why).toContain('nobody has established how it actually accepts')
  })

  it('tells a destination with no third-party route apart from both', () => {
    /**
     * The finding that earned its own value. UltraTax CS imports from a closed
     * menu of named vendors and ProConnect Tax's only documented route is from
     * QuickBooks Online Accountant inside Intuit's own stack. Neither is waiting
     * on more searching.
     */
    for (const key of ['ultratax-cs', 'proconnect']) {
      const verdict = mayExportTo(key)
      expect(verdict.ok, key).toBe(false)
      if (verdict.ok) continue
      expect(verdict.why).toContain('no route a third party can take')
      expect(verdict.why).toContain('for the vendor rather than for more searching')
    }

    // And it is not the sentence a merely-unverified destination gets.
    const verdict = mayExportTo('ultratax-cs')
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).not.toContain('Export the universal accountant package in the meantime')
  })

  it('still refuses a competitor with the decision rather than a research state', () => {
    // §15's first acceptance criterion does not become a research question.
    const verdict = mayExportTo('xero')

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.why).toContain('is not an export destination')
    expect(verdict.why).not.toContain('worksheet')
  })
})

describe('the integration state, which is now derived', () => {
  it('is read from the worksheet rather than stored on the destination', () => {
    /**
     * Phase 158 stored `integration` on each `ExportDestination`. Once
     * worksheets existed that was two answers to one question — the worksheet
     * establishes the path, so a copy on the destination can only drift, and it
     * would drift into a product decision about what to offer a firm.
     *
     * The type no longer has the field. This asserts the reader agrees with the
     * registry it reads from.
     */
    expect('integration' in destinationFor('lacerte')).toBe(false)

    expect(integrationFor('lacerte')).toBe('researched-unverified')
    expect(integrationFor('netsuite')).toBe('unresearched')
    expect(integrationFor('universal')).toBe('file-import')
  })

  it('counts fourteen researched and six not', () => {
    // Measured, not bounded (Phase 126). Twenty §3 targets: fourteen Priority 1,
    // six Priority 2.
    const states = EXPORT_DESTINATIONS.map((row) => integrationFor(row.key))

    expect(states.filter((state) => state === 'researched-unverified')).toHaveLength(14)
    expect(states.filter((state) => state === 'unresearched')).toHaveLength(6)
    expect(states.filter((state) => state === 'file-import')).toHaveLength(1)
  })

  it('gives the universal package a path without a worksheet, and only it', () => {
    // §4's package is Accountrix's own file rather than somebody else's import,
    // so there is no vendor to research. Every other key without a worksheet is
    // unresearched, which this asserts rather than assumes.
    expect(worksheetFor('universal')).toBeNull()

    const pathless = EXPORT_DESTINATIONS.filter(
      (row) => worksheetFor(row.key) === null && integrationFor(row.key) !== 'unresearched',
    ).map((row) => row.key)

    expect(pathless).toEqual(['universal'])
  })
})

describe('the worksheets’ own coherence', () => {
  it('stands up to its rules', () => {
    for (const worksheet of WORKSHEETS) {
      expect(worksheetStands(worksheet), worksheet.destinationKey).toEqual([])
    }
  })

  it('catches a worksheet whose fields disagree', () => {
    /**
     * Not type-checkable: TypeScript can make `verifiedOn` optional and cannot
     * require it *when the status is verified*. The dangerous shape is the
     * second one below — a draft carrying verification details, which reads as
     * "somebody verified this and forgot to promote it".
     */
    const base: Worksheet = { ...WORKSHEETS[0], destinationKey: 'fixture' }

    expect(worksheetStands({ ...base, status: 'verified' })[0]).toContain(
      'does not say when or by whom',
    )
    expect(worksheetStands({ ...base, verifiedBy: 'somebody' })[0]).toContain(
      'draft carrying verification details',
    )
    expect(worksheetStands({ ...base, path: 'README.md' })[0]).toContain(
      'does not point at a worksheet page',
    )
    expect(worksheetStands({ ...base, blocker: '  ' }).join(' ')).toContain(
      'names nothing outstanding',
    )
    expect(
      worksheetStands({ ...base, finding: 'no-third-party-path', needsVendorApproval: false })[0],
    ).toContain('runs through the vendor by definition')
  })

  it('refuses a destination nobody wrote a worksheet for', () => {
    expect(() => requireWorksheet('netsuite')).toThrow(RegistryError)
    expect(() => requireWorksheet('netsuite')).toThrow(/§13 requires/)
    expect(worksheetFor('netsuite')).toBeNull()
  })

  it('records which paths a vendor has to agree to', () => {
    /**
     * §13 asks *"what vendor approval, license, NDA, or certification is
     * required"*, and the answer across the fourteen is the research's main
     * strategic finding: most paths need nobody's permission, and the ones that
     * do are the ones that look most modern.
     */
    const gated = WORKSHEETS.filter((row) => row.needsVendorApproval).map((row) => row.destinationKey)

    expect(gated.sort()).toEqual(['gosystem-tax-rs', 'proconnect', 'ultratax-cs'])

    // Caseware Cloud is the counter-example worth asserting: a REST API with no
    // gate, because the *firm* issues the credentials and Caseware's usage
    // policy permits a third party to build against them.
    const caseware = requireWorksheet('caseware-cloud')
    expect(caseware.finding).toBe('programmatic')
    expect(caseware.needsVendorApproval).toBe(false)
  })

  it('found twelve file imports and two programmatic paths', () => {
    /**
     * §7's warning, measured. *"Do not assume an API exists."* An exporter built
     * on the assumption that professional software is reached through APIs would
     * have been wrong about twelve of fourteen Priority 1 targets — and of the
     * two it was right about, one needs a form processed by a human at the
     * vendor.
     */
    const byFinding: Record<string, number> = {}
    for (const worksheet of WORKSHEETS) {
      byFinding[worksheet.finding] = (byFinding[worksheet.finding] ?? 0) + 1
    }

    expect(byFinding).toEqual({
      'file-import': 10,
      programmatic: 2,
      'no-third-party-path': 2,
    })
  })
})
