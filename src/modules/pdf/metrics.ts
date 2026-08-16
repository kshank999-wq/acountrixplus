/**
 * Widths for the standard PDF fonts, in 1/1000 em.
 *
 * A PDF viewer already has Helvetica, Times and Courier — the "standard 14" —
 * so nothing here is embedded. That is the whole reason this module can be a
 * few hundred lines instead of a font toolchain: no glyf parsing, no subsetting,
 * no CMap. The cost is that a company's brand font does not reach the PDF, and
 * that is stated plainly in ADR 0021 rather than hidden.
 *
 * The numbers are the Adobe Core14 AFM widths. They are needed for one reason:
 * text wrapping has to know how wide a line is *before* it is drawn, and a PDF
 * has no layout engine to ask. Getting them wrong produces a document that
 * looks right until a line quietly runs off the page.
 */

export type StandardFont =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Courier'

/**
 * Widths for codes 32–126, which is what this application writes.
 *
 * Text is sanitised to WinAnsi before it reaches here, so anything outside the
 * range has already been folded or dropped — see `toWinAnsi`.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]

const TIMES_ROMAN = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
]

const TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
]

const TIMES_ITALIC = [
  250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500,
  920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722,
  611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500,
  333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500,
  500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541,
]

const WIDTHS: Record<StandardFont, number[]> = {
  Helvetica: HELVETICA,
  'Helvetica-Bold': HELVETICA_BOLD,
  // The oblique face has the same advance widths as the upright one.
  'Helvetica-Oblique': HELVETICA,
  'Times-Roman': TIMES_ROMAN,
  'Times-Bold': TIMES_BOLD,
  'Times-Italic': TIMES_ITALIC,
  Courier: [],
}

/**
 * The width of one string, in points.
 *
 * Courier is monospaced at 600/1000 em, which is why its table is empty rather
 * than 95 copies of the same number.
 */
export function widthOf(text: string, font: StandardFont, sizePt: number): number {
  if (font === 'Courier') return (text.length * 600 * sizePt) / 1000

  const table = WIDTHS[font]
  const extras = EXTRA_WIDTHS[font] ?? EXTRA_WIDTHS.Helvetica
  let total = 0

  for (const character of text) {
    const code = character.charCodeAt(0)

    if (code >= 32 && code <= 126) {
      total += table[code - 32]
      continue
    }
    // A mid-width guess for anything that slipped through: wrong by a few
    // points on one line, rather than wrong by a whole word.
    total += extras?.[code] ?? 500
  }

  return (total * sizePt) / 1000
}

/**
 * Folds text into what the standard fonts can actually draw.
 *
 * A proposal written by a person contains typographic quotes, em dashes and
 * ellipses — the editor produces them and so does anybody pasting from a word
 * processor. Left alone they would emit as the wrong glyph or as nothing.
 * Mapping them to their ASCII equivalents is visibly imperfect and silently
 * wrong is worse.
 *
 * A character with no mapping becomes `?`, which is ugly and honest: the
 * alternative is a blank that nobody notices until a client asks what happened
 * to their company name.
 */
const WIN_ANSI: Record<string, string> = {
  '\u2018': '\x91',
  '\u2019': '\x92',
  '\u201a': '\x82',
  '\u201c': '\x93',
  '\u201d': '\x94',
  '\u201e': '\x84',
  '\u2013': '\x96',
  '\u2014': '\x97',
  '\u2026': '\x85',
  '\u2022': '\x95',
  '\u2020': '\x86',
  '\u2030': '\x89',
  '\u20ac': '\x80',
  '\u2122': '\x99',
  '\u2039': '\x8b',
  '\u203a': '\x9b',
}

/**
 * Everything else with no glyph, folded to something readable.
 *
 * A character with no mapping at all becomes `?`, which is ugly and honest: a
 * blank is the version nobody notices until a client asks what happened to
 * their company name.
 */
const FOLD: Record<string, string> = {
  '\u00a0': ' ',
  '\u00b7': '-',
  '\u2212': '-',
  '\u2192': '->',
  '\u00d7': 'x',
  '\u2265': '>=',
  '\u2264': '<=',
}

/**
 * Widths for the Windows-1252 extras, in 1/1000 em, keyed by byte.
 *
 * Only the characters `WIN_ANSI` can produce. Wrapping needs them for the same
 * reason it needs the ASCII table: a line's width has to be known before it is
 * drawn, and these are the characters real prose is full of.
 */
const EXTRA_WIDTHS: Partial<Record<StandardFont, Record<number, number>>> = {
  Helvetica: {
    0x80: 556, 0x82: 222, 0x84: 333, 0x85: 1000, 0x86: 556, 0x89: 1000, 0x8b: 333,
    0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000,
    0x99: 1000, 0x9b: 333,
  },
  'Helvetica-Bold': {
    0x80: 556, 0x82: 278, 0x84: 500, 0x85: 1000, 0x86: 556, 0x89: 1000, 0x8b: 333,
    0x91: 278, 0x92: 278, 0x93: 500, 0x94: 500, 0x95: 350, 0x96: 556, 0x97: 1000,
    0x99: 1000, 0x9b: 333,
  },
  'Times-Roman': {
    0x80: 500, 0x82: 333, 0x84: 444, 0x85: 1000, 0x86: 500, 0x89: 1000, 0x8b: 333,
    0x91: 333, 0x92: 333, 0x93: 444, 0x94: 444, 0x95: 350, 0x96: 500, 0x97: 1000,
    0x99: 980, 0x9b: 333,
  },
  'Times-Bold': {
    0x80: 500, 0x82: 333, 0x84: 500, 0x85: 1000, 0x86: 500, 0x89: 1000, 0x8b: 333,
    0x91: 333, 0x92: 333, 0x93: 500, 0x94: 500, 0x95: 350, 0x96: 500, 0x97: 1000,
    0x99: 1000, 0x9b: 333,
  },
  'Times-Italic': {
    0x80: 500, 0x82: 333, 0x84: 556, 0x85: 889, 0x86: 500, 0x89: 1000, 0x8b: 333,
    0x91: 333, 0x92: 333, 0x93: 556, 0x94: 556, 0x95: 350, 0x96: 500, 0x97: 889,
    0x99: 980, 0x9b: 333,
  },
}

export function toWinAnsi(text: string): string {
  let out = ''

  for (const character of text) {
    const code = character.charCodeAt(0)

    if (code >= 32 && code <= 126) {
      out += character
      continue
    }
    if (WIN_ANSI[character] !== undefined) {
      out += WIN_ANSI[character]
      continue
    }
    if (FOLD[character] !== undefined) {
      out += FOLD[character]
      continue
    }
    // Tabs become spaces; every other control character is dropped, because a
    // raw newline inside a PDF string literal would corrupt the stream.
    if (character === '\t') {
      out += '    '
      continue
    }
    // True control codes are dropped — a raw newline inside a PDF string
    // literal would corrupt the stream. 0x80–0x9F are *not* controls here:
    // under WinAnsiEncoding they are the typographic characters above.
    if (code < 32) continue
    if (code >= 0x80 && code <= 0x9f) {
      out += character
      continue
    }

    out += '?'
  }

  return out
}
