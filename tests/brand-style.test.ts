import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCompanyFixture } from './helpers'
import {
  BRAND_STYLE_FIELDS,
  brandStyleProblem,
  isFontStack,
  isHexColor,
} from '@/modules/design/style-values'
import { createBrandKit, updateBrandKit } from '@/modules/studio/service'
import { emailBrand, renderEmailHtml } from '@/modules/marketing/render-email'
import { DEFAULT_BRAND_KIT } from '@/modules/design/brand'
import { DomainError, messageFor } from '@/modules/errors'

/**
 * What may be interpolated into a style attribute (Phase 80).
 *
 * `studio/service` refused any colour that was not plain hex and said why:
 * they land in a `style` attribute on client-facing pages. That comment was
 * the entire defence — nothing asserted it, and it did not cover the two font
 * fields sitting beside the colours, which had no rule at all.
 */

const HOSTILE = [
  'serif" onload="alert(1)',
  "serif' onload='alert(1)",
  'serif;}</style><script>alert(1)</script>',
  'url(javascript:alert(1))',
  'Georgia, serif; background: url(http://evil.test/x)',
  'expression(alert(1))',
]

describe('what counts as a font list', () => {
  /** Every stack the Design Center offers, and the one the email default uses. */
  const OFFERED = [
    'Georgia, serif',
    "'Times New Roman', serif",
    'system-ui, sans-serif',
    "'Helvetica Neue', Arial, sans-serif",
    "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  ]

  it.each(OFFERED)('accepts %s', (stack) => {
    expect(isFontStack(stack)).toBe(true)
  })

  /**
   * The four in the picker are read out of the component rather than retyped,
   * so adding a fifth the validator refuses fails here rather than at a send.
   */
  it('accepts every option the Design Center actually renders', () => {
    const source = readFileSync('src/app/studio/studio-workspace.tsx', 'utf8')
    const offered = [...source.matchAll(/<option value="([^"]*(?:serif|sans-serif)[^"]*)">/g)].map(
      (match) => match[1].replace(/&#39;/g, "'"),
    )

    expect(offered.length).toBeGreaterThan(0)
    for (const stack of offered) expect(isFontStack(stack)).toBe(true)
  })

  it.each(HOSTILE)('refuses %s', (stack) => {
    expect(isFontStack(stack)).toBe(false)
  })

  it('refuses an empty list, a dangling comma, and anything oversized', () => {
    expect(isFontStack('')).toBe(false)
    expect(isFontStack('   ')).toBe(false)
    expect(isFontStack('Georgia,')).toBe(false)
    expect(isFontStack('Georgia, , serif')).toBe(false)
    expect(isFontStack(`${'A'.repeat(201)}`)).toBe(false)
  })

  it('still refuses a colour where a font belongs, and the other way round', () => {
    expect(isFontStack('#0d6e60')).toBe(false)
    expect(isHexColor('Georgia, serif')).toBe(false)
  })
})

describe('the registry of fields that reach a style attribute', () => {
  /**
   * `assertColors` named five fields; the renderer interpolated seven. The two
   * it missed were the ones with no rule.
   */
  it('names the fonts as well as the colours', () => {
    const keys = BRAND_STYLE_FIELDS.map((field) => field.key)

    expect(keys).toContain('headingFont')
    expect(keys).toContain('bodyFont')
    expect(keys).toHaveLength(7)
  })

  it('covers every brand value the email renderer interpolates', () => {
    const source = readFileSync('src/modules/marketing/render-email.ts', 'utf8')
    const used = new Set(
      [...source.matchAll(/styleValue\(brand\.(\w+)\)/g)].map((match) => match[1]),
    )
    const guarded = new Set(BRAND_STYLE_FIELDS.map((field) => field.key as string))

    expect(used.size).toBeGreaterThan(0)
    for (const key of used) expect(guarded).toContain(key)
  })

  it('says which field is wrong and what it should look like', () => {
    const font = BRAND_STYLE_FIELDS.find((field) => field.key === 'bodyFont')!
    const colour = BRAND_STYLE_FIELDS.find((field) => field.key === 'primaryColor')!

    // The picker's caption, not the column name — the person is looking at a
    // field labelled "Body font", not at `bodyFont`.
    expect(brandStyleProblem(font, 'serif" onload="x')).toBe(
      'Body font must be a font list such as Georgia, serif.',
    )
    expect(brandStyleProblem(colour, 'red')).toBe(
      'Primary must be a hex colour such as #0d6e60.',
    )
    expect(brandStyleProblem(font, 'Georgia, serif')).toBeNull()
  })

  it('is what the default kit itself satisfies', () => {
    for (const field of BRAND_STYLE_FIELDS) {
      expect(brandStyleProblem(field, DEFAULT_BRAND_KIT[field.key])).toBeNull()
    }
  })
})

describe('storing a brand kit', () => {
  it('refuses a font that is not a font', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })

    await expect(
      createBrandKit(fixture.ctx, { name: 'Hostile', bodyFont: 'serif" onload="alert(1)' }),
    ).rejects.toThrow(/Body font must be a font list/)
  })

  /**
   * The update path had the same gap and is the easier one to forget, since a
   * partial input means most fields arrive `undefined`.
   */
  it('refuses it on the way in on a correction too', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })
    const kit = await createBrandKit(fixture.ctx, { name: 'Fine' })

    await expect(
      updateBrandKit(fixture.ctx, kit.id, { headingFont: 'Georgia;}</style><script>x</script>' }),
    ).rejects.toThrow(/Heading font must be a font list/)

    await expect(
      updateBrandKit(fixture.ctx, kit.id, { headingFont: 'Georgia, serif' }),
    ).resolves.toMatchObject({ headingFont: 'Georgia, serif' })
  })

  it('still refuses a colour that is not hex, which is where this rule started', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })

    await expect(
      createBrandKit(fixture.ctx, { name: 'Hostile', primaryColor: 'rebeccapurple' }),
    ).rejects.toThrow(/Primary must be a hex colour/)
  })

  /**
   * Found by the browser check, not by a test: `messageFor` denies by default,
   * so the sentence `assertColors` had been throwing since Phase 4 never
   * reached anybody. The Design Center said "Something went wrong."
   */
  it('says what is wrong rather than that something is', async () => {
    const fixture = await createCompanyFixture({ name: 'Ridgeline Construction' })

    const refusal = await createBrandKit(fixture.ctx, {
      name: 'Hostile',
      bodyFont: 'serif" onload="alert(1)',
    }).catch((error) => error)

    expect(refusal).toBeInstanceOf(DomainError)
    expect(messageFor(refusal, 'Something went wrong.')).toBe(
      'Body font must be a font list such as Georgia, serif.',
    )
  })
})

/**
 * The second lock. The validator is three modules from the renderer, and the
 * renderer's own rule is that every author string is escaped — so this asserts
 * the outcome rather than the guard, against a kit the guard would never have
 * let through.
 */
describe('a hostile brand cannot reach the wire', () => {
  const blocks = [
    { id: 'h', type: 'heading' as const, level: 1 as const, text: 'Spring offer', align: 'left' as const },
  ]

  function render(brand: Parameters<typeof renderEmailHtml>[0]['brand']) {
    return renderEmailHtml({
      blocks,
      unsubscribeUrl: 'https://example.test/u/abc',
      brand,
    })
  }

  it('keeps the body tag intact when the body font tries to close it', () => {
    const html = render({
      ...emailBrand(null),
      bodyFont: 'serif" onload="alert(1)',
    })

    // The break-out attempt survives as text inside the attribute, which is the
    // point — so the assertion is about the *tag*, not about the string. A
    // `<body>` with one attribute has exactly two quote characters; a third
    // would mean the value closed early and something new began.
    const bodyTag = html.match(/<body[^>]*>/)![0]

    expect([...bodyTag].filter((c) => c === '"')).toHaveLength(2)
    expect(bodyTag).toContain('font-family:serif&quot; onload=&quot;alert(1)')
  })

  it('does not let a heading font open a script', () => {
    const html = render({ ...emailBrand(null), headingFont: '</style><script>alert(1)</script>' })

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('</style>')
  })

  it('leaves a legitimate stack usable after escaping', () => {
    const html = render(emailBrand(null))

    // The apostrophes become entities; an HTML parser decodes them before the
    // CSS is parsed, so the family still resolves.
    expect(html).toContain('font-family:-apple-system, &#39;Segoe UI&#39;, Roboto')
    expect(html).not.toContain('font-family:undefined')
  })
})

/**
 * `renderEmailHtml` has taken a `brand` since Phase 5 and nothing ever passed
 * one, so every campaign went out in the default while the company's chosen
 * colours styled its proposals.
 */
describe('a campaign goes out in the company’s own colours', () => {
  it('maps a stored kit onto what the renderer wants', () => {
    const brand = emailBrand({
      primaryColor: '#1e3a5f',
      textColor: '#1a1a1a',
      mutedColor: '#6b7280',
      headingFont: 'Georgia, serif',
    })

    expect(brand.primaryColor).toBe('#1e3a5f')
    expect(brand.headingFont).toBe('Georgia, serif')

    // The body font stays the email stack: an email renders in Outlook, which
    // has no `system-ui`.
    expect(brand.bodyFont).toContain('-apple-system')
  })

  it('falls back to the default kit’s colours when a company has none', () => {
    const brand = emailBrand(null)

    expect(brand.primaryColor).toBe(DEFAULT_BRAND_KIT.primaryColor)
    expect(brand.textColor).toBe(DEFAULT_BRAND_KIT.textColor)
    expect(brand.mutedColor).toBe(DEFAULT_BRAND_KIT.mutedColor)
  })

  it('paints the email in them rather than in the default', () => {
    const mine = emailBrand({
      primaryColor: '#1e3a5f',
      textColor: '#1a1a1a',
      mutedColor: '#6b7280',
      headingFont: 'Georgia, serif',
    })

    const html = renderEmailHtml({
      blocks: [
        { id: 'h', type: 'heading', level: 1, text: 'Spring offer', align: 'left' },
      ],
      unsubscribeUrl: 'https://example.test/u/abc',
      brand: mine,
    })

    expect(html).toContain('color:#1e3a5f')
    expect(html).not.toContain(DEFAULT_BRAND_KIT.primaryColor)
  })

  it('is what the send path actually hands the renderer', () => {
    const source = readFileSync('src/modules/marketing/campaigns.ts', 'utf8')

    expect(source).toContain('const kit = await defaultBrandKit(ctx.companyId)')
    expect(source).toContain('brand: emailBrand(kit)')
  })
})

/**
 * The labels are the picker's, not the schema's, so a caption renamed in the
 * component and not here would leave a refusal naming a field that is not on
 * screen — which is the version of this defect one level down.
 */
describe('the refusal names the field the person can see', () => {
  it('takes its captions from the same registry the picker renders', () => {
    const source = readFileSync('src/app/studio/studio-workspace.tsx', 'utf8')

    expect(source).toContain("from '@/modules/design/style-values'")
    expect(source).toContain('BRAND_STYLE_FIELDS.filter((field) => field.kind')

    // And keeps no second list of its own. `{ key: 'primaryColor', label: … }`
    // was written out here as well as in the registry until Phase 80.
    expect(source).not.toMatch(/\{ key: '(primary|accent|text|muted|surface)Color', label:/)
  })
})
