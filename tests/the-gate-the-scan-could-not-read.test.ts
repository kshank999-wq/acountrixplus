import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditEvents, documents } from '@/db/schema'
import { createCompanyFixture, addUserWithRole } from './helpers'
import {
  PERMISSIONS,
  PermissionError,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@/modules/permissions'
import { RegistryError } from '@/modules/errors/registry'
import {
  auditWriteSites,
  blindProducers,
  unexplainedActs,
} from '@/modules/source/audit-readers'
import {
  GATE_RESOLVERS,
  OPEN_ACTS,
  functionBody,
  miscategorisedActs,
  namesImportedByApp,
  openAct,
  permissionChecksIn,
  resolveComputedGate,
  staleOpenActs,
} from '@/modules/source/gate-forms'
import { permissionsToRead } from '@/modules/audit/visibility'
import { enclosingSpan, withoutComments } from '@/modules/source/enclosing'
import { ASSET_SUBJECTS } from '@/modules/studio/asset-subjects'
import { uploadAsset } from '@/modules/studio/assets'
import { linkAsset, unlinkAsset } from '@/modules/studio/asset-links'
import { createCampaign } from '@/modules/marketing/campaigns'
import { attachNewDocument } from '@/modules/evidence/service'
import { historyFor } from '@/modules/audit'

/**
 * The gate the scan could not read (Phase 214).
 *
 * ADR 0213 nominated "44 write sites whose enclosing function requires no
 * permission at all" and asked which of four things each was. Measured, the
 * sentence is false — twelve of the forty-four do require one — and four was not
 * the number of ways this codebase authorises an act.
 *
 * No database for most of this: it is a statement about the source. The two
 * suites that do use one are there because a property about a scan is not a
 * property about the books until somebody performs the act.
 */

/** The reader Phase 213 shipped, kept so the difference can be shown rather than described. */
const OLD_READER = /requirePermission\(\s*\w+\s*,\s*'([a-z_]+:[a-z_]+)'/g

const holds = (role: Role, permission: Permission) =>
  (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)

/** The body of the function a site sits in, comments blanked. */
function bodyAt(file: string, symbol: string): string {
  const raw = readFileSync(file, 'utf8')
  const at = raw.search(new RegExp(`function\\s+${symbol}\\b`))
  const span = enclosingSpan(raw, at < 0 ? 0 : at)
  return withoutComments(raw).slice(span.from, span.to)
}

describe('the reader that was wrong about both arguments', () => {
  /**
   * The whole phase in one assertion. Phase 213's reader wanted
   * `requirePermission(<identifier>, '<literal>')`, and it was wrong about the
   * context argument as well as the permission argument — `party.ctx` is not an
   * identifier, so a plain literal check went unseen too.
   */
  it('reads a check the old one could not, in each of the three ways it is written', () => {
    const cases: { source: string; literal: Permission[]; computed: number; why: string }[] = [
      {
        source: "requirePermission(ctx, 'crm:manage')",
        literal: ['crm:manage'],
        computed: 0,
        why: 'the one form the old reader handled',
      },
      {
        source: "if (!can(ctx, 'marketing:manage')) return { ok: false }",
        literal: ['marketing:manage'],
        computed: 0,
        why: 'a soft refusal is still a gate — the AI module explains instead of throwing',
      },
      {
        source: "requirePermission(ctx, permissionFor(document.kind, 'manage'))",
        literal: [],
        computed: 1,
        why: 'the permission comes from the record, so no pattern can read it',
      },
      {
        source: "requirePermission(party.ctx, 'company:manage')",
        literal: ['company:manage'],
        computed: 0,
        why: 'a literal permission, missed because the *context* was not a bare word',
      },
    ]

    for (const example of cases) {
      const checks = permissionChecksIn(example.source)
      expect(checks.literal, example.why).toEqual(example.literal)
      expect(checks.computed.length, example.why).toBe(example.computed)
    }

    // And the old reader saw only the first of the four.
    const seen = cases.filter((example) => {
      OLD_READER.lastIndex = 0
      return OLD_READER.test(example.source)
    })
    expect(seen).toHaveLength(1)
  })

  /**
   * The nested-bracket case, which is not a nicety. The first version of
   * `permissionChecksIn` ended its match at the first `)` and handed back
   * `permissionFor(document.kind, 'manage'` — a string that appears in no file,
   * so the resolver refused a key nobody could have added. Brackets get
   * balanced because the thing being read is an expression.
   */
  it('reads the whole expression rather than stopping at the first bracket', () => {
    const checks = permissionChecksIn(
      "requirePermission(ctx, permissionFor(document.kind, 'manage'))",
    )

    expect(checks.computed).toEqual(["permissionFor(document.kind, 'manage')"])
    expect(checks.computed[0].endsWith(')')).toBe(true)
  })

  /** Measured, not bounded (Phase 126): the scan has to be wide enough for the claim to mean something. */
  it('scans enough of the tree for that to matter', () => {
    const sites = auditWriteSites()

    expect(sites.length).toBeGreaterThan(250)
    expect(sites.filter((site) => site.gates.length > 0).length).toBeGreaterThan(200)
    expect(sites.filter((site) => site.alternatives.length > 0).length).toBeGreaterThan(5)
  })

  /**
   * The count, with its reasons. Twelve functions that Phase 213 recorded as
   * requiring no permission do require one: eight compute it from the record's
   * kind, three refuse softly, and one passes its context as a property access.
   *
   * The breakdown is pinned rather than the total, because a total alone cannot
   * tell the difference between a reader that was fixed and a codebase that
   * changed — and three different mistakes went into this one number.
   */
  it('names the twelve gates it recovered, and why each was invisible', () => {
    const recovered = new Map<string, string>()

    for (const site of auditWriteSites()) {
      if (site.gates.length === 0 && site.alternatives.length === 0) continue

      const body = bodyAt(site.file, site.symbol)
      OLD_READER.lastIndex = 0
      if (OLD_READER.test(body)) continue

      const why =
        site.alternatives.length > 0
          ? 'computed'
          : /\bcan\(\s*\w+\s*,\s*'[a-z_]+:[a-z_]+'/.test(body)
            ? 'soft'
            : 'context-expression'

      recovered.set(`${site.file}::${site.symbol}`, why)
    }

    const by = (kind: string) => [...recovered.values()].filter((value) => value === kind).length

    expect(recovered.size).toBe(12)
    expect(by('computed')).toBe(8)
    expect(by('soft')).toBe(3)
    expect(by('context-expression')).toBe(1)

    // The two that matter most, named: a pair of buttons on one screen whose
    // gate is computed, and the act that hid a real finding behind it.
    expect([...recovered.keys()]).toContain('src/modules/studio/asset-links.ts::linkAsset')
    expect([...recovered.keys()]).toContain('src/modules/studio/asset-links.ts::unlinkAsset')
  })

  /**
   * The nomination's first category, measured and found impossible. It asked
   * whether each act is "gated upstream in a server action" — but gates live in
   * modules here, and the eleven checks in `src/app` are the exception that
   * proves it.
   */
  it('finds that gating upstream in a server action is not a thing this codebase does', () => {
    const appChecks = namesImportedByApp
    expect(typeof appChecks).toBe('function')

    let checks = 0
    const filesWithChecks = new Set<string>()

    for (const site of auditWriteSites()) {
      if (!site.file.startsWith('src/app/')) continue
      const found = permissionChecksIn(bodyAt(site.file, site.symbol))
      if (found.literal.length + found.computed.length > 0) filesWithChecks.add(site.file)
    }

    for (const file of ['src/app/actions/operations.ts', 'src/app/actions/inventory.ts']) {
      checks += permissionChecksIn(withoutComments(readFileSync(file, 'utf8'))).literal.length
    }

    expect(checks).toBeGreaterThan(0)
    // Whatever src/app does check, the overwhelming majority of the 263 sites
    // are in modules — which is why "upstream in the action" could never have
    // been the answer for most of them.
    const inModules = auditWriteSites().filter((site) => site.file.startsWith('src/modules/'))
    expect(inModules.length).toBeGreaterThan(auditWriteSites().length - 10)
  })
})

describe('a permission a pattern cannot read', () => {
  /**
   * Five expressions across all 254 audit-writing functions. The register is
   * small because it was measured, not sampled — which is the only reason a
   * hand-written resolver table is honest here.
   */
  it('declares every computed check that appears in an audit-writing function', () => {
    const expressions = new Set<string>()
    const functions = new Set<string>()

    for (const site of auditWriteSites()) {
      const key = `${site.file}::${site.symbol}`
      if (functions.has(key)) continue
      functions.add(key)

      for (const expression of permissionChecksIn(bodyAt(site.file, site.symbol)).computed) {
        expressions.add(expression)
        // The claim under test: each one resolves rather than throwing.
        expect(resolveComputedGate(expression).length).toBeGreaterThan(0)
      }
    }

    expect(functions.size).toBeGreaterThan(240)
    expect(expressions.size).toBe(5)
    expect(Object.keys(GATE_RESOLVERS).sort()).toEqual([...expressions].sort())
  })

  it('names only permissions that exist', () => {
    for (const [expression, resolver] of Object.entries(GATE_RESOLVERS)) {
      expect(resolver.yields.length, expression).toBeGreaterThan(0)
      for (const permission of resolver.yields) {
        expect(PERMISSIONS, expression).toContain(permission)
      }
      // Every entry argues for itself (Phase 101), and a reason this short is
      // not a reason.
      expect(resolver.why.length, expression).toBeGreaterThan(60)
    }
  })

  /**
   * A refusal rather than a guess. The alternative — resolving an unknown
   * expression to "no permission" — would put the act back in the set Phase 213
   * excused silently, which is the exact failure this phase is repairing.
   */
  it('refuses an expression it has never been told about', () => {
    expect(() => resolveComputedGate('permissionFor(invoice.kind, "approve")')).toThrow(
      RegistryError,
    )

    try {
      resolveComputedGate('somethingNew(ctx)')
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).message).toMatch(/cannot be read off the source/)
      expect((error as RegistryError).message).toMatch(/somethingNew\(ctx\)/)
    }
  })

  /**
   * The asset-subject resolver's set has one member today, and the register says
   * so deliberately rather than writing the literal. This is the assertion that
   * makes that decision real: add a sixth subject under another permission and
   * the yields are wrong, and the scan should notice.
   */
  it('keeps the asset resolver honest against the subject register', () => {
    const managed = new Set(ASSET_SUBJECTS.map((subject) => subject.manage))

    expect(ASSET_SUBJECTS).toHaveLength(5)
    expect([...managed]).toEqual(['marketing:manage'])
    expect(resolveComputedGate('subject.manage')).toEqual([...managed])
    expect(resolveComputedGate('assetSubjectFor(ref.kind).manage')).toEqual([...managed])
  })
})

describe('the register of acts that need no permission', () => {
  /** Nothing is excused in silence any more: the `continue` has to be argued for. */
  it('leaves no act undeclared', () => {
    expect(unexplainedActs()).toEqual([])
  })

  it('holds no entry the source has outgrown', () => {
    expect(staleOpenActs()).toEqual([])
  })

  /**
   * The part that makes this a register rather than a comment block: every
   * category has a consequence in the source, and the consequence is checked.
   */
  it('bears out every reason it gives', () => {
    expect(miscategorisedActs()).toEqual([])
  })

  it('covers the acts it claims to, in categories that each hold something', () => {
    const counted = new Map<string, number>()
    for (const act of OPEN_ACTS) {
      counted.set(act.category, (counted.get(act.category) ?? 0) + 1)
    }

    expect(OPEN_ACTS).toHaveLength(31)
    // Six categories, and the nomination named two of them.
    expect([...counted.keys()].sort()).toEqual([
      'bootstrap',
      'delegated',
      'internal',
      'practice',
      'self',
      'token',
    ])
    for (const [category, count] of counted) {
      expect(count, category).toBeGreaterThan(0)
    }

    // Every entry argues for itself.
    for (const act of OPEN_ACTS) {
      expect(act.why.length, `${act.file}::${act.symbol}`).toBeGreaterThan(40)
    }
  })

  it('refuses an act nobody has declared', () => {
    expect(() => openAct('src/modules/receivables/service.ts', 'createInvoice')).toThrow(
      RegistryError,
    )

    try {
      openAct('src/modules/x/y.ts', 'doSomething')
      throw new Error('should have refused')
    } catch (error) {
      expect((error as RegistryError).message).toMatch(/Either gate the act, or declare it here/)
    }
  })

  /**
   * The categories spot-checked by hand as well as by the scan, because a
   * falsifier that passes on an empty set proves nothing. Each of these is a
   * claim about a named act that a reader can go and check.
   */
  it('means something different by each category', () => {
    const self = OPEN_ACTS.find((act) => act.symbol === 'revokeDevice')
    expect(self?.category).toBe('self')
    expect(bodyAt(self!.file, self!.symbol)).toMatch(/ctx\.userId/)

    const token = OPEN_ACTS.find((act) => act.symbol === 'acceptProposal')
    expect(token?.category).toBe('token')
    expect(bodyAt(token!.file, token!.symbol)).not.toMatch(/: ActorContext/)

    const bootstrap = OPEN_ACTS.find((act) => act.symbol === 'registerCompany')
    expect(bootstrap?.category).toBe('bootstrap')

    const internal = OPEN_ACTS.find((act) => act.symbol === 'applyCreditWithin')
    expect(internal?.category).toBe('internal')
    expect(namesImportedByApp().has('applyCreditWithin')).toBe(false)

    const delegated = OPEN_ACTS.find((act) => act.symbol === 'suggestCategory')
    expect(delegated?.category).toBe('delegated')
    expect(delegated?.gatedBy).toBe('transactionContext')
    // The gatekeeper is real and really refuses, which is what stops a
    // delegation claim from being a sentence.
    const gate = functionBody('src/modules/ai/retrieval.ts', 'transactionContext')
    expect(gate).not.toBeNull()
    expect(permissionChecksIn(gate!).literal).toContain('bookkeeping:view')
  })

  /**
   * The limit, recorded rather than papered over. `requirePracticeOwner` is used
   * eight times and is not a `Permission`, so `blindProducers` — which iterates
   * `ROLE_NAMES` — cannot say anything about a practice-side act in either
   * direction. The nomination had no category for a second authority model.
   */
  it('records that a practice is not authorised by a company role', () => {
    const practice = OPEN_ACTS.filter((act) => act.category === 'practice')
    expect(practice.length).toBeGreaterThan(0)

    for (const act of practice) {
      expect(act.gatedBy).toBe('requirePracticeOwner')
      expect(bodyAt(act.file, act.symbol)).toMatch(/requirePracticeOwner\(/)
    }

    // And the thing it gates on is not in the permission vocabulary at all.
    expect(PERMISSIONS as readonly string[]).not.toContain('practice:own')
    const owner = functionBody('src/modules/practice/service.ts', 'requirePracticeOwner')
    expect(permissionChecksIn(owner!).literal).toEqual([])
  })
})

describe('the asset nobody could account for', () => {
  /**
   * The finding, and the only one of the twelve recovered gates that was hiding
   * a real defect.
   *
   * Every asset subject is managed under `marketing:manage`; `asset` was in no
   * entry of `READABLE_BY`, so its history needed `audit:view`; and `marketing`
   * holds the first and not the second.
   */
  it('states the premise that made it a defect', () => {
    expect(holds('marketing', 'marketing:manage')).toBe(true)
    expect(holds('marketing', 'audit:view')).toBe(false)
    expect(new Set(ASSET_SUBJECTS.map((subject) => subject.manage))).toEqual(
      new Set(['marketing:manage']),
    )
  })

  it('opens an asset’s history to whoever may manage one', () => {
    expect(permissionsToRead('asset')).toEqual(['marketing:view'])

    const producers = ROLE_NAMES.filter((role) => holds(role, 'marketing:manage'))
    expect(producers).toEqual(['owner', 'manager', 'marketing'])

    // The property, stated about this type directly rather than only in the
    // aggregate: everyone who can cause the event can be shown it.
    for (const role of producers) {
      expect(
        permissionsToRead('asset').some((permission) => holds(role, permission)),
        role,
      ).toBe(true)
    }
  })

  /**
   * What the placement takes away, measured as Phase 213 insisted. An accountant
   * loses asset history — the same trade as `campaign` and `segment`, and the
   * same argument: which image a campaign used is not part of the books.
   */
  it('takes asset history from the accountant, and from nobody else', () => {
    const before = ROLE_NAMES.filter((role) => holds(role, 'audit:view'))
    const after = ROLE_NAMES.filter((role) =>
      permissionsToRead('asset').some((permission) => holds(role, permission)),
    )

    expect(before.filter((role) => !after.includes(role))).toEqual(['accountant'])
    expect(after.filter((role) => !before.includes(role))).toEqual(['marketing'])
    expect(after).toContain('owner')
  })

  /** The property, over the whole tree, with the computed gates now in it. */
  it('leaves no role producing an audit event it cannot read', () => {
    expect(blindProducers()).toEqual([])
  })

  /**
   * And the same claim about the books rather than about the source: a marketer
   * attaches an asset to a campaign, detaches it, and reads both acts back.
   */
  it('lets a marketer read the association they just made', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const marketer = await addUserWithRole(fixture, 'marketing')

    const campaign = await createCampaign(marketer, { name: 'Spring remodels' })

    // The owner puts the file in the library — `uploadAsset` is gated on
    // `company:manage`, which is a different question from who may associate it.
    // The two acts whose history is at stake here are the marketer's.
    const asset = await uploadAsset(fixture.ctx, {
      filename: 'hero.png',
      contentType: 'image/png',
      data: Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
          '0d0a2db40000000049454e44ae426082',
        'hex',
      ),
    })

    const { linkId } = await linkAsset(marketer, {
      assetId: asset.id,
      subject: { kind: 'campaign', id: campaign.id },
    })
    await unlinkAsset(marketer, linkId)

    // The premise again, at the point it bites: this reader holds no audit:view.
    expect(holds('marketing', 'audit:view')).toBe(false)

    const history = await historyFor(marketer, 'asset', asset.id)
    const actions = history.map((row) => row.action)
    expect(actions).toContain('asset.associate')
    expect(actions).toContain('asset.disassociate')
  })
})

describe('the check that ran after the write', () => {
  /**
   * The second defect, and a harder shape to see than a missing check: the check
   * was there and it was **late**.
   *
   * `uploadEvidenceAction` called `storeDocument` and then `attachDocument`, and
   * only the second gates. So a member with no permission on the subject had the
   * bytes stored, a `documents` row written and a `document.store` event filed
   * before being refused. Every test of the refusal passed, because the refusal
   * did happen.
   */
  it('refuses before anything is written', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const sales = await addUserWithRole(fixture, 'sales')

    // The premise: a bank transaction is managed under bookkeeping:categorize.
    expect(holds('sales', 'bookkeeping:categorize')).toBe(false)

    await expect(
      attachNewDocument(sales, {
        subjectType: 'bank_transaction',
        subjectId: '00000000-0000-4000-8000-000000000000',
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 receipt', 'utf8'),
      }),
    ).rejects.toThrow(PermissionError)

    // The assertion the old order could not have passed: no row, no event.
    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.companyId, fixture.companyId))
    expect(rows).toEqual([])

    const events = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.companyId, fixture.companyId),
          eq(auditEvents.entityType, 'document'),
        ),
      )
    expect(events).toEqual([])
  })

  /**
   * And the primitive is out of reach of a route, which is the checkable half of
   * its `internal` declaration. `storeDocument` cannot gate — it is told the
   * bytes and not what they are for — so what keeps it safe is that the only way
   * in is through something that knows the subject.
   */
  it('keeps the ungated primitive out of src/app', () => {
    const imported = namesImportedByApp()

    expect(imported.has('storeDocument')).toBe(false)
    expect(imported.has('attachNewDocument')).toBe(true)

    const declared = OPEN_ACTS.find((act) => act.symbol === 'storeDocument')
    expect(declared?.category).toBe('internal')
  })
})
