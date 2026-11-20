import { describe, expect, it } from 'vitest'
import {
  declarationOf,
  withoutComments,
  withoutStrings,
} from '@/modules/source/enclosing'
import {
  OPAQUE_GATES,
  computedGateSites,
  gatesOnUncheckedClaims,
  opaqueGate,
  reportsOn,
  sitesInSource,
  staleOpaqueGates,
  type ComputedGateSite,
} from '@/modules/source/computed-gates'
import { RegistryError } from '@/modules/errors/registry'

/**
 * Phase 220 — the gate computed from a claim.
 *
 * ADR 0219 nominated the measurement of acts whose permission depends on an
 * argument, and asked whether a screen ever offers an option the gate refuses.
 * Measured, the risk is at the other end: not an argument the screen chooses
 * badly, but an argument the gate **believes**. The property that makes the
 * difference is that the value computing the permission must also select the
 * record, so a lie about it removes the record rather than changing the gate.
 */

const sites = computedGateSites()
const find = (file: string, symbol: string): ComputedGateSite => {
  const site = sites.find((one) => one.file.endsWith(file) && one.symbol === symbol)
  if (!site) throw new Error(`no computed gate site for ${symbol} in ${file}`)
  return site
}

describe('what the tree actually computes its gates from', () => {
  it('finds twenty-nine sites across seventeen distinct expressions', () => {
    expect(sites).toHaveLength(29)
    expect(new Set(sites.map((site) => site.expression)).size).toBe(17)
  })

  it('counts every read by where its value came from', () => {
    const counts = new Map<string, number>()
    for (const site of sites) {
      for (const read of site.reads) {
        counts.set(read.origin, (counts.get(read.origin) ?? 0) + 1)
      }
    }

    // Seventeen gates read whatever the caller said, which is the result that
    // inverts the nomination: ADR 0219 took a gate computed from the record to
    // be the ordinary case and the argument the exception.
    expect(counts.get('claim')).toBe(17)
    expect(counts.get('record')).toBe(9)
    expect(counts.get('laundered')).toBe(2)
    expect(counts.get('register')).toBe(1)
    expect(counts.get('unresolved')).toBeUndefined()
  })

  it('reads the side of a merge as a claim, and sees it pick the table too', () => {
    const merge = find('parties/service.ts', 'mergeParties')
    const side = merge.reads.find((read) => read.path === 'input.side')

    expect(side?.origin).toBe('claim')
    // `const table = input.side === 'customer' ? customers : vendors`, and six
    // more. A caller who names the wrong side gets no record, not another gate.
    expect(side?.elsewhere).toBeGreaterThan(0)
  })

  it('reads a note’s subject type as a claim that requireSubject then proves', () => {
    const write = find('evidence/notes.ts', 'writeNote')
    const subject = write.reads.find((read) => read.path === 'input.subjectType')

    expect(subject?.origin).toBe('claim')
    expect(subject?.elsewhere).toBeGreaterThan(0)
  })
})

describe('the property', () => {
  it('holds everywhere: no gate is computed from a claim nobody checks', () => {
    expect(gatesOnUncheckedClaims(sites)).toEqual([])
  })

  it('leaves no entry in the register that excuses nothing', () => {
    expect(staleOpaqueGates(sites)).toEqual([])
  })

  it('declares exactly the two sites the property cannot judge', () => {
    expect(OPAQUE_GATES.map((entry) => entry.symbol).sort()).toEqual(['assemble', 'linkAsset'])
    for (const entry of OPAQUE_GATES) {
      expect(entry.why.length).toBeGreaterThan(120)
    }
  })

  it('refuses to answer for a site nobody declared', () => {
    expect(() => opaqueGate('src/modules/nowhere.ts', 'somethingNew')).toThrow(RegistryError)
    expect(opaqueGate('src/modules/studio/asset-links.ts', 'linkAsset').symbol).toBe('linkAsset')
  })
})

/**
 * The falsifier, on source written to be wrong.
 *
 * Phase 218 reported nine defects and eight were the scan's own, every one found
 * by reading a finding against the code rather than by a property passing. A
 * scan whose only input is a tree it agrees with has never been watched fail.
 */
describe('the scan, seen to disagree', () => {
  const siteFor = (source: string) => sitesInSource('src/modules/made-up.ts', source)[0]

  it('reports a gate whose argument chooses the permission and nothing else', () => {
    const site = siteFor(`
export async function archiveThing(ctx: ActorContext, kind: string, id: string) {
  requirePermission(ctx, permissionFor(kind, 'manage'))
  await db.delete(things).where(eq(things.id, id))
}
`)

    expect(site.reads.find((read) => read.path === 'kind')?.origin).toBe('claim')
    expect(reportsOn(site, [])).toHaveLength(1)
    expect(reportsOn(site, [])[0]).toContain('without choosing the record')
  })

  it('passes the same act once the argument also selects the row', () => {
    const site = siteFor(`
export async function archiveThing(ctx: ActorContext, kind: string, id: string) {
  requirePermission(ctx, permissionFor(kind, 'manage'))
  await db.delete(things).where(and(eq(things.id, id), eq(things.kind, kind)))
}
`)

    expect(reportsOn(site, [])).toEqual([])
  })

  it('passes a ternary that picks the table it gates on, as a merge does', () => {
    const site = siteFor(`
export async function joinParties(ctx: ActorContext, input: { side: PartySide; id: string }) {
  requirePermission(ctx, input.side === 'customer' ? 'crm:manage' : 'accounting:journal')
  const table = input.side === 'customer' ? customers : vendors
  await db.select().from(table).where(eq(table.id, input.id))
}
`)

    expect(reportsOn(site, [])).toEqual([])
  })

  it('reports a claim laundered through a local, however often the local is named', () => {
    const site = siteFor(`
export async function tagThing(ctx: ActorContext, input: { kind: string; id: string }) {
  const subject = subjectFor(input.kind)
  requirePermission(ctx, subject.manage)
  if (!subject.label) throw new Error(subject.name)
  await db.insert(tags).values({ id: input.id })
}
`)

    expect(site.reads.find((read) => read.path === 'subject.manage')?.origin).toBe('laundered')
    // `subject` is named three more times, and none of them is a record
    // selection. The count cannot tell the difference, so it does not try.
    expect(reportsOn(site, [])).toHaveLength(1)
    expect(reportsOn(site, [])[0]).toContain('cannot judge')
  })

  it('accepts a laundered claim once the register argues for it', () => {
    const source = `
export async function tagThing(ctx: ActorContext, input: { kind: string; id: string }) {
  const subject = subjectFor(input.kind)
  requirePermission(ctx, subject.manage)
}
`
    const site = sitesInSource('src/modules/made-up.ts', source)[0]

    expect(
      reportsOn(site, [
        { file: 'src/modules/made-up.ts', symbol: 'tagThing', why: 'declared for the test' },
      ]),
    ).toEqual([])
  })

  it('reports a value nothing in the source declares rather than assuming it', () => {
    const site = siteFor(`
export async function showThing(ctx: ActorContext, id: string) {
  requirePermission(ctx, permissionFor(mystery.kind, 'view'))
  await db.select().from(things).where(eq(things.id, id))
}
`)

    expect(site.reads.find((read) => read.path === 'mystery.kind')?.origin).toBe('unresolved')
    expect(reportsOn(site, [])[0]).toContain('unmeasured rather than safe')
  })

  it('reads a gate inside a closure against that closure’s own parameter', () => {
    // `enclosingSymbol` answers `assemble` here, whose parameters are `ctx` and
    // `opts`. Counting only those made `key` invisible and `section` a constant.
    const site = siteFor(`
export async function assembleThing(ctx: ActorContext, opts: Options) {
  const mayRead = (key: string): boolean => {
    const section = sectionFor(key)
    return can(ctx, section.source.permission)
  }
  return SECTIONS.filter((one) => mayRead(one))
}
`)

    expect(site.reads.find((read) => read.path === 'section.source.permission')?.origin).toBe(
      'laundered',
    )
  })

  it('does not mistake a literal permission or a forwarded one for a computed gate', () => {
    expect(
      sitesInSource(
        'src/modules/made-up.ts',
        `
export function one(ctx: ActorContext) {
  requirePermission(ctx, 'crm:manage')
}
export function two(ctx: ActorContext, permission: Permission) {
  requirePermission(ctx, permission)
}
`,
      ),
    ).toEqual([])
  })

  it('does not read a check out of prose inside a string', () => {
    expect(
      sitesInSource(
        'src/modules/made-up.ts',
        `
export const REGISTER = [
  { why: 'guarded by can(ctx, subjectFor(input.kind).manage) rather than a literal' },
]
`,
      ),
    ).toEqual([])
  })
})

/**
 * The reader this phase fixed, and the one it added.
 *
 * Four computed gates read a tenant-scoped row through `const [row] = await …`
 * and came back indistinguishable from four that read a value out of nowhere.
 * The gates were right; `declarationOf` was blind to the destructuring, which is
 * ADR 0134's leak a third time and in the same helper as the second.
 */
describe('declarationOf, and the destructuring it could not read', () => {
  const at = (source: string, needle: string) => source.indexOf(needle)

  it('reads a single row destructured out of an await', () => {
    const source = withoutComments(`
export async function suggest(ctx: ActorContext, documentId: string) {
  const [document] = await db.select({ kind: designDocuments.kind }).from(designDocuments)
  requirePermission(ctx, permissionFor(document.kind, 'manage'))
}
`)

    const declaration = declarationOf(source, at(source, 'permissionFor'), 'document')
    expect(declaration).toContain('const [document]')
    expect(declaration).toContain('await')
  })

  it('reads a field destructured out of an await', () => {
    const source = withoutComments(`
export async function suggest(ctx: ActorContext, id: string) {
  const { kind } = await loadDocument(ctx, id)
  requirePermission(ctx, permissionFor(kind, 'manage'))
}
`)

    expect(declarationOf(source, at(source, 'permissionFor'), 'kind')).toContain('await')
  })

  it('still answers for a plain declaration, which is what it always did', () => {
    const source = withoutComments(`
export async function save(ctx: ActorContext, id: string) {
  const document = await loadDocument(ctx, id)
  requirePermission(ctx, permissionFor(document.kind, 'manage'))
}
`)

    expect(declarationOf(source, at(source, 'permissionFor'), 'document')).toBe(
      'const document = await loadDocument(ctx, id)',
    )
  })

  it('still says nothing when nothing declares it', () => {
    const source = withoutComments(`
export async function save(ctx: ActorContext) {
  requirePermission(ctx, permissionFor(mystery.kind, 'manage'))
}
`)

    expect(declarationOf(source, at(source, 'permissionFor'), 'mystery')).toBe('')
  })

  it('does not take a for-of destructuring for a declaration with an initialiser', () => {
    const source = withoutComments(`
export async function sweep(ctx: ActorContext) {
  for (const [table, label] of [[invoices, 'invoice'], [bills, 'bill']] as const) {
    requirePermission(ctx, permissionFor(table.kind, 'manage'))
  }
}
`)

    const declaration = declarationOf(source, at(source, 'permissionFor'), 'table')
    expect(declaration).toContain('for (const [table, label] of')
    expect(declaration).toContain('invoices')
  })

  it('finds the four sites in the tree that the fix resolved', () => {
    for (const [file, symbol] of [
      ['ai/design.ts', 'suggestLayout'],
      ['ai/design.ts', 'applyLayoutSuggestion'],
      ['evidence/notes.ts', 'resolveNote'],
      ['importing/reversal.ts', 'revertImport'],
    ] as const) {
      const site = find(file, symbol)
      const reads = site.reads.filter((read) => read.origin !== 'register')
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((read) => read.origin === 'record')).toBe(true)
    }
  })
})

/**
 * `withoutStrings`, and why its length is the whole point.
 *
 * The obvious spelling shortens the text, so every offset after the first string
 * points somewhere else. This scan matched calls in the blanked copy and sliced
 * them out of the original, and reported whole function bodies as gate
 * expressions: 162 sites where there are 29.
 */
describe('withoutStrings', () => {
  it('keeps every byte offset, which is the only reason it is usable', () => {
    const source = `const why = 'a long sentence about permissions'\nconst after = 1\n`

    expect(withoutStrings(source)).toHaveLength(source.length)
    expect(withoutStrings(source).indexOf('const after')).toBe(source.indexOf('const after'))
  })

  it('blanks prose that looks like code, and keeps the quotes', () => {
    const blanked = withoutStrings(`const why = 'can(ctx, subjectFor(x).manage)'`)

    expect(blanked).not.toContain('can(')
    expect(blanked).toContain("''".slice(0, 1))
    expect(blanked.trimEnd().endsWith("'")).toBe(true)
  })

  it('keeps the newlines inside a template literal so line numbers survive', () => {
    const source = 'const sql = `select 1\nfrom things`\nconst after = 2\n'
    const blanked = withoutStrings(source)

    expect(blanked).toHaveLength(source.length)
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length)
    expect(blanked.indexOf('const after')).toBe(source.indexOf('const after'))
  })

  it('leaves source with no strings in it exactly as it was', () => {
    const source = 'const x = compute(a, b)\n'
    expect(withoutStrings(source)).toBe(source)
  })
})
