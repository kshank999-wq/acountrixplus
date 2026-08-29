import type { Config } from 'tailwindcss'

/**
 * Colors are defined as CSS custom properties in globals.css so light and dark
 * themes swap by redefining tokens rather than by duplicating every utility.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',
        brand: 'rgb(var(--brand) / <alpha-value>)',
        'brand-ink': 'rgb(var(--brand-ink) / <alpha-value>)',
        // The workspace's primary action (Phase 70). `brand` is the design's
        // lime, which only ever appears on the dark chrome; a button on white
        // uses this instead.
        action: 'rgb(var(--action) / <alpha-value>)',
        'action-ink': 'rgb(var(--action-ink) / <alpha-value>)',
        // The nav shell, which stays dark in both themes as the design has it.
        chrome: 'rgb(var(--chrome) / <alpha-value>)',
        'chrome-raised': 'rgb(var(--chrome-raised) / <alpha-value>)',
        'chrome-line': 'rgb(var(--chrome-line) / <alpha-value>)',
        'chrome-ink': 'rgb(var(--chrome-ink) / <alpha-value>)',
        'chrome-muted': 'rgb(var(--chrome-muted) / <alpha-value>)',
        positive: 'rgb(var(--positive) / <alpha-value>)',
        negative: 'rgb(var(--negative) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        // Aliases. `positive`/`negative` read as *a number went up or down*,
        // which is right on a variance column and wrong on "that link has
        // expired", so screens kept reaching for `success`/`danger` — and got
        // no CSS at all, because Tailwind only emits classes it can see. Nine
        // screens have been rendering their error messages in body ink since
        // Phase 12 as a result. Naming them is cheaper and more honest than
        // renaming every call site to a word that does not fit.
        success: 'rgb(var(--positive) / <alpha-value>)',
        danger: 'rgb(var(--negative) / <alpha-value>)',
        fg: 'rgb(var(--ink) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
