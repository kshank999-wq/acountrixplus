import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { BUILT_IN_PROMPTS, resolvePrompt } from '@/modules/ai/prompts'
import { mockAiProvider } from '@/modules/ai/registry'
import { updateSettings } from '@/modules/ai/settings'
import { companyContext, renderVoice } from '@/modules/ai/retrieval'
import { draftCampaignCopy, draftProposalSections } from '@/modules/ai/assistants'
import { createOpportunity, createOrganization } from '@/modules/crm/opportunities'
import { saveProfile } from '@/modules/studio/service'
import { createCompanyFixture, type Fixture } from './helpers'

/**
 * A voice to adapt to (Phase 200, spec §11).
 *
 * ADR 0199 nominated §11's *"adapt content to company voice"* as the cheapest
 * of the eight functions Phase 195 found unbuilt, on the grounds that it was a
 * gap between two prompts in one module where one does the right thing and the
 * other does not.
 *
 * Measured, it was **three gaps in a line**, each invisible from the others:
 *
 * | | |
 * | --- | --- |
 * | no editor | `companyProfiles.description` had a column, a service that accepted it, and no field on the Design Center form. Nobody could fill it in. |
 * | not loaded | `companyContext` selected the whole profile row and exposed `tagline` — which **no caller had ever read** — and never `description`. |
 * | not asked | `draftCampaignCopy` loaded all four context fields and passed only the name. `marketing.draft` said nothing about voice. |
 *
 * So building from the nomination would have fed the prompt an empty string:
 * the Phase 160 shape, and the same near-miss as Phase 194's prompt-caching
 * no-op. The order the links had to be closed in is the finding.
 *
 * Two things the nomination itself got wrong, which measuring caught:
 * `brand/voice.ts` is about **whose name goes on a letter**, not tone, and
 * `proposal.draft` v1 *already* said *"write in the company's voice"* — while
 * being given the name, the industry and a price list. It was inferring voice
 * from a catalogue, which is why this phase gives both prompts the material
 * rather than only instructing the marketing one.
 *
 * ## What is asserted
 *
 * What the provider was **sent**, not what the mock said about it — Phase
 * 195's rule: a test reading the answer would pass against a model that
 * invented the voice, which is the one thing these prompts forbid.
 */

let fixture: Fixture

beforeEach(async () => {
  fixture = await createCompanyFixture({ name: 'Harbour & Sons' })
  await updateSettings(fixture.ctx, { enabled: true, provider: 'mock' })
  mockAiProvider().reset()
})

/** The company's own words, as a business would type them in. */
async function describedItself() {
  await saveProfile(fixture.ctx, {
    tagline: 'Boatyard joinery since 1961',
    description:
      'We are a four-person yard on the Blackwater. We rebuild wooden hulls and we do not ' +
      'take on plastic boats.',
  })
}

describe('the field nobody could fill in', () => {
  it('is on the Design Center form, so the column has a writer', () => {
    /**
     * **The tripwire that would have caught this.** `PROFILE_FIELDS` drives
     * the profile form, so a column missing from it is a column a company
     * cannot fill — and `description` was missing from Phase 4 to Phase 200
     * while the paragraph at the top of that file listed *"company
     * description"* among what the Studio covers.
     *
     * Asserted against the schema rather than against a list of names, so a
     * column added later with no field fails here. The exclusions are declared
     * because each is edited somewhere else, and naming them is the difference
     * between a check and an excuse (ADR 0134).
     */
    const workspace = readFileSync('src/app/studio/studio-workspace.tsx', 'utf8')
    const schema = readFileSync('src/db/schema/studio.ts', 'utf8')

    const profileBlock = schema.slice(
      schema.indexOf('export const companyProfiles'),
      schema.indexOf('export const', schema.indexOf('export const companyProfiles') + 10),
    )

    const columns = [...profileBlock.matchAll(/^\s{4}(\w+): (?:text|jsonb)\(/gm)].map(
      (m) => m[1],
    )

    /*
      Not on this form, each for a stated reason.

      `credentials` said *"a structured list with its own editor and its own
      add/remove controls"* until Phase 210, and there is no such editor
      anywhere — nothing writes the column and nothing reads it. That is an
      exclusion **excusing** a site, which is the failure ADR 0134 names, in
      the test that cites ADR 0134. It is still excluded from *this* check,
      because a jsonb list of licences is not a text box; what changed is that
      the reason is now a pointer to the register that holds it as a finding,
      so the claim is tested somewhere rather than asserted here.
    */
    const elsewhere = new Set([
      // `COLUMN_WRITERS` holds this one with the verdict `unwritable`.
      'credentials',
      // Chosen in the brand kit, not typed on the profile form.
      'logoAssetId',
    ])

    const missing = columns.filter(
      (column) => !elsewhere.has(column) && !workspace.includes(`key: '${column}'`),
    )

    expect(missing).toEqual([])
    // And the one this phase added, named so the assertion above cannot pass
    // by the block failing to parse.
    expect(columns).toContain('description')
    expect(workspace).toContain("key: 'description'")
  })

  it('reaches the AI context once a company has written it', async () => {
    // The second link. `companyContext` exposed `tagline` and read it to
    // nobody; `description` it did not load at all.
    await describedItself()

    const context = await companyContext(fixture.ctx)

    expect(context?.tagline).toBe('Boatyard joinery since 1961')
    expect(context?.description).toContain('four-person yard on the Blackwater')
  })
})

describe('the voice block', () => {
  it('renders the company’s own words and not its price list', () => {
    /*
      Voice is what a business says about itself, not what it sells. The
      catalogue has its own placeholder in the proposal prompt, and conflating
      the two is how v1 could instruct "write in the company's voice" while
      being handed nothing but prices.
    */
    const block = renderVoice({
      name: 'Harbour & Sons',
      industry: 'construction',
      tagline: 'Boatyard joinery since 1961',
      description: 'We rebuild wooden hulls.',
      services: [{ name: 'Hull rebuild', description: 'Per metre', unitPriceCents: 500_000 }],
    })

    expect(block).toContain('Boatyard joinery since 1961')
    expect(block).toContain('We rebuild wooden hulls.')
    expect(block).not.toContain('Hull rebuild')
    expect(block).not.toContain('5000')
    /*
      And not the industry, which is picked from a list at registration to
      choose a chart of accounts — a classification rather than something the
      business said. Including it made the block never empty, since every
      company has one.
    */
    expect(block).not.toContain('construction')
  })

  it('is absent rather than blank when a company has written nothing', () => {
    /**
     * The common case: a company that has not opened the Design Center has
     * none of this. Three placeholders would render as three empty labelled
     * lines, which the model then has to explain — the same choice Phase 195
     * made for the comparison figures, and for the same reason.
     */
    expect(
      renderVoice({
        name: 'Nobody Ltd',
        // With an industry, as every registered company has: the block is
        // still empty, because an industry is not a voice.
        industry: 'general',
        tagline: null,
        description: null,
        services: [],
      }),
    ).toBe('')

    expect(renderVoice(null)).toBe('')
  })

  it('says only what the company said, however little that is', () => {
    // A tagline and nothing else is a voice. The block is built from whatever
    // is there rather than requiring the set.
    const block = renderVoice({
      name: 'Nobody Ltd',
      // An industry present and still no voice, which is the distinction this
      // block draws: a classification is not something the business said.
      industry: 'construction',
      tagline: 'Quietly competent',
      description: null,
      services: [],
    })

    expect(block).toContain('Quietly competent')
    expect(block).not.toContain('In their own words:')
  })
})

describe('what the prompts are actually sent', () => {
  it('gives the marketing draft the company’s voice', async () => {
    await describedItself()

    const result = await draftCampaignCopy(fixture.ctx, { goal: 'Fill the winter slots' })
    if (!result.ok) throw new Error(result.message)

    const [call] = mockAiProvider().calls

    expect(call.prompt).toContain('Boatyard joinery since 1961')
    expect(call.prompt).toContain('four-person yard on the Blackwater')
    // And the instruction that makes the material do something.
    expect(call.system).toContain('write as that business')
  })

  it('gives the proposal draft the material its v1 instruction assumed', async () => {
    /*
      `proposal.draft` v1 said "write in the company's voice" and was given the
      name, the industry and the service catalogue. The tagline sat on
      `CompanyContext` one field away, unread since Phase 6.
    */
    await describedItself()

    const organization = await createOrganization(fixture.ctx, { name: 'Maldon Sailing Club' })
    const opportunity = await createOpportunity(fixture.ctx, {
      organizationId: organization.id,
      title: 'Clubhouse windows',
      expectedValueCents: 800_000,
    })

    const result = await draftProposalSections(fixture.ctx, opportunity.id)
    if (!result.ok) throw new Error(result.message)

    const [call] = mockAiProvider().calls
    expect(call.prompt).toContain('Boatyard joinery since 1961')
    expect(call.prompt).toContain('four-person yard on the Blackwater')
  })

  it('sends no voice section at all for a company that has written none', async () => {
    /*
      Asserted on the heading rather than on a figure, because the failure this
      guards against is a prompt carrying an empty labelled block — which reads
      to a model as "this business says nothing about itself" rather than as
      "nobody has asked them yet".
    */
    const result = await draftCampaignCopy(fixture.ctx, { goal: 'Fill the winter slots' })
    if (!result.ok) throw new Error(result.message)

    const [call] = mockAiProvider().calls
    expect(call.prompt).not.toContain('How this business talks about itself')
    // The instruction still tells it what to do with the absence.
    expect(call.system).toContain('invent no character for them')
  })
})

describe('the registry kept its history', () => {
  it('resolves both prompts to version 2 and keeps version 1', async () => {
    /**
     * Phase 195's rule: `resolvePrompt` takes the highest built-in version and
     * the gateway writes `promptVersion` into every `ai_requests` row, so
     * editing a version in place would change history under rows that cite it.
     * §12 asks for a registry with *versioning, testing, and rollback*, and a
     * version that can be rewritten is not one.
     */
    for (const key of ['marketing.draft', 'proposal.draft']) {
      const resolved = await resolvePrompt(fixture.companyId, key)
      expect(resolved.version, key).toBe(2)
      expect(resolved.template, key).toContain('{{voice}}')

      const versions = BUILT_IN_PROMPTS.filter((prompt) => prompt.key === key).map(
        (prompt) => prompt.version,
      )
      expect(versions, key).toEqual([1, 2])

      const [v1] = BUILT_IN_PROMPTS.filter(
        (prompt) => prompt.key === key && prompt.version === 1,
      )
      expect(v1.template, key).not.toContain('{{voice}}')
    }
  })

  it('kept the instruction v1 already had, rather than inventing one', () => {
    // The correction worth keeping: `proposal.draft` was not missing the
    // instruction, it was missing the material. Both versions say it.
    const versions = BUILT_IN_PROMPTS.filter((prompt) => prompt.key === 'proposal.draft')

    for (const version of versions) {
      expect(version.systemPrompt, `v${version.version}`).toContain("company's voice")
    }
  })
})
