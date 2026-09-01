/**
 * What a brand value is allowed to be (Phase 80).
 *
 * ## The comment that was doing the escaping
 *
 * `studio/service` refused any colour that was not plain hex, and said why:
 *
 * > Colours land in a `style` attribute on client-facing pages, so anything
 * > that is not a plain hex value is refused rather than sanitized.
 *
 * That is the right rule and it was load-bearing — the email renderer
 * interpolates brand values straight into `style="…"` with no escaping, in a
 * file whose own comment says *every author string passes through*
 * `escapeHtml`. The colours were the exception that was safe, because of a
 * guard three modules away, asserted by nothing.
 *
 * **And it did not cover the two fields sitting beside them.** `headingFont`
 * and `bodyFont` are `z.string().trim().max(200)` in the action and had no
 * rule at all, while landing in the same attribute:
 *
 *     <body style="margin:0;padding:0;background:#f8fafc;font-family:${brand.bodyFont};">
 *
 * A body font of `serif" onload="…` closes the attribute. Phase 79 widened
 * `isHexColor`'s sibling `parseColor` and this is the check that widening
 * called for: who else trusted this validator, and what did it never promise?
 *
 * ## Why the rule lives here rather than in the service
 *
 * `studio/service` reads the database. The email renderer, the PDF writer and
 * the document page all need to know what a valid brand value is and none of
 * them should have to import a service to find out. So the rule is data and
 * pure functions, and the service enforces it.
 *
 * Nothing here touches the database or the clock.
 */

/**
 * A three- or six-digit hex colour.
 *
 * Moved out of `studio/service` rather than copied. Three digits count because
 * CSS understands `#fff`, which is also why Phase 79 had to teach the PDF
 * writer the same spelling — the two disagreed and the disagreement landed on
 * paper.
 */
export function isHexColor(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
}

/** The longest a brand value may be, matching the action's own limit. */
const MAX_LENGTH = 200

/**
 * One family in a CSS font list: `Georgia`, `'Times New Roman'`, `sans-serif`.
 *
 * A leading hyphen is allowed because `-apple-system` is a real family and the
 * email default names it. Everything a font list needs is letters, digits,
 * spaces and hyphens; nothing it needs can close an attribute or open a
 * declaration, so the class is the guard.
 */
const QUOTED_FAMILY = /^(['"])[A-Za-z0-9 \-]+\1$/
const BARE_FAMILY = /^-?[A-Za-z][A-Za-z0-9 \-]*$/

/**
 * A CSS font-family list.
 *
 * Deliberately far narrower than CSS allows. This is not a parser trying to
 * accept everything valid — it is a gate deciding what may be interpolated
 * into an attribute, and the four stacks the Design Center offers plus the
 * email default are the whole population it has to admit.
 */
export function isFontStack(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_LENGTH) return false

  const families = trimmed.split(',').map((part) => part.trim())
  if (families.length === 0) return false

  return families.every((family) => QUOTED_FAMILY.test(family) || BARE_FAMILY.test(family))
}

export type BrandStyleKind = 'color' | 'font'

export type BrandStyleField = {
  key: 'primaryColor' | 'accentColor' | 'textColor' | 'mutedColor' | 'surfaceColor' | 'headingFont' | 'bodyFont'
  kind: BrandStyleKind
  /** What the Design Center calls it, since that is what the person is reading. */
  label: string
}

/**
 * Every brand-kit field whose value is interpolated into a style attribute.
 *
 * A registry rather than a list inside the assertion, because the defect this
 * phase fixes is precisely that the list and the set of fields that need it had
 * drifted apart — `assertColors` named five and the renderer used seven.
 *
 * The labels match the picker's own captions. `assertColors` refused with
 * `primaryColor must be a hex colour…`, which is a column name; the person
 * looking at the screen sees a field called "Primary".
 */
export const BRAND_STYLE_FIELDS: readonly BrandStyleField[] = [
  { key: 'primaryColor', kind: 'color', label: 'Primary' },
  { key: 'accentColor', kind: 'color', label: 'Accent' },
  { key: 'textColor', kind: 'color', label: 'Text' },
  { key: 'mutedColor', kind: 'color', label: 'Muted' },
  { key: 'surfaceColor', kind: 'color', label: 'Background' },
  { key: 'headingFont', kind: 'font', label: 'Heading font' },
  { key: 'bodyFont', kind: 'font', label: 'Body font' },
] as const

/** Whether one value is acceptable for one kind of field. */
export function isBrandStyleValue(kind: BrandStyleKind, value: string): boolean {
  return kind === 'color' ? isHexColor(value) : isFontStack(value)
}

/**
 * Why a value was refused, in the sentence a person reads.
 *
 * Returns `null` when there is nothing wrong, so a caller loops rather than
 * branching on the kind a second time.
 */
export function brandStyleProblem(field: BrandStyleField, value: string): string | null {
  if (isBrandStyleValue(field.kind, value)) return null

  return field.kind === 'color'
    ? `${field.label} must be a hex colour such as #0d6e60.`
    : `${field.label} must be a font list such as Georgia, serif.`
}
