import { BRAND, MARK, MARK_PATHS } from '@/modules/brand/identity'

/**
 * The product's logo (Phase 73).
 *
 * The only place in the application that draws its own name. Five screens used
 * to do it independently — the rail, the login page, the reset page, and the
 * marketing header and footer — and no two agreed on the typography, the mark
 * or whether the "Plus" was part of the name or a badge beside it.
 *
 * ## Two tones, one drawing
 *
 * The mark never changes: a lime ground carries its own contrast, so it needs
 * no light and dark variant. What changes is the wordmark, which is ink on the
 * workspace and white on the rail, and the badge's hairline, which has to be
 * ink on white and a dark olive on the chrome — `--chrome-line` is that
 * colour, and Phase 70's stylesheet already called it "the badge hairline",
 * which is what it was waiting to be.
 */

export type LogoTone = 'light' | 'dark'

/** Just the square. For a favicon, an avatar slot, or a very small header. */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <rect width="100" height="100" rx={100 * MARK.radiusRatio} fill={MARK.ground} />
      <path d={MARK_PATHS.letter} fill={MARK.letter} fillRule="evenodd" />
      <path d={MARK_PATHS.plus} fill={MARK.plus} />
    </svg>
  )
}

/**
 * The mark, the wordmark and the badge.
 *
 * Labelled once, on the group, rather than leaving three fragments for a
 * screen reader to read out as "image, Accountrix, PLUS".
 */
export function Logo({
  tone = 'light',
  className = '',
  markClassName = 'h-7 w-7',
  wordClassName = 'text-[15px]',
}: {
  tone?: LogoTone
  className?: string
  markClassName?: string
  wordClassName?: string
}) {
  const dark = tone === 'dark'

  return (
    <span className={`inline-flex items-center gap-2 ${className}`} aria-label={BRAND.full}>
      <LogoMark className={`shrink-0 ${markClassName}`} />
      <span className="flex items-baseline gap-1.5">
        <span
          className={`font-bold tracking-tight ${wordClassName} ${
            dark ? 'text-chrome-ink' : 'text-ink'
          }`}
        >
          {BRAND.name}
        </span>
        {/* Lime type, which only reads inside its own outline — hence the
            badge. On white the outline is ink; on the rail it is the olive
            hairline the stylesheet named for exactly this. */}
        <span
          className={`rounded border px-1 py-0.5 text-[9px] font-bold leading-none tracking-widest text-brand ${
            dark ? 'border-chrome-line' : 'border-ink/70'
          }`}
        >
          {BRAND.suffix}
        </span>
      </span>
    </span>
  )
}
