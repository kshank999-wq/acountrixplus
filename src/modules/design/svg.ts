/**
 * SVG that is safe to serve and possible to print (Phase 190, spec §7).
 *
 * ## The decision this module is
 *
 * §7 asks for *"SVG import/export **where practical**"*, and SVG has been
 * deliberately refused since Phase 4, in three places, with the same argument:
 *
 * > SVG is deliberately absent: it can carry script, and these files are
 * > served back to browsers on public proposal pages. Accepting it would turn
 * > the logo library into a stored-XSS vector.
 *
 * That argument is correct and this module does not overturn it. An SVG served
 * with `Content-Disposition: inline` and navigated to directly runs script in
 * the application's origin — against a colleague with a session, or a client
 * holding a proposal token. In an `<img>` tag it cannot, because browsers
 * disable scripting there, but the asset route serves the same bytes to both.
 *
 * What makes it practical is that **the subset worth importing is tiny**. A
 * logo is flat-filled paths and basic shapes. Everything that makes SVG
 * dangerous — script, event handlers, `foreignObject`, external references —
 * and everything that makes it hard to print — filters, gradients, patterns,
 * text needing fonts — is outside that subset and outside this allowlist.
 *
 * ## One list, two jobs
 *
 * The allowlist below is **both** the security boundary and the printable
 * subset. That is the design rather than a coincidence: two lists would be two
 * answers to one question, and the failure mode is an SVG that is safe to
 * serve and silently blank on paper — which is Phase 185's defect, repeated
 * with a new file format.
 *
 * So the test of whether a construct is allowed is not whether it looks
 * harmless; it is **whether this module can read it completely enough to
 * redraw it**. That is why `parsePath`, `parseTransform` and `resolvePaint`
 * live here rather than in the PDF writer that needs them: the sanitiser
 * refuses what the writer could not draw *because it is the same function
 * asking*. A path the PDF cannot render cannot be stored.
 *
 * Anything this module accepts therefore renders on the page *and* in the PDF,
 * and anything it rejects is **refused at upload**, where the person who chose
 * the file can choose another one (Phase 119). A grey box discovered by a
 * client is not a remedy.
 *
 * ## It rewrites rather than trusts
 *
 * `sanitizeSvg` does not inspect and approve the uploaded bytes; it parses
 * them and **emits its own document** from what it understood. Anything it did
 * not understand cannot survive, including the things nobody thought to deny —
 * which is the difference between an allowlist and a filter, and the reason a
 * denylist of `<script>` and `onload=` would be a worse module than this one.
 */

/**
 * The elements that may appear in an imported SVG.
 *
 * `title` and `desc` survive as text content because they are what a screen
 * reader announces, and dropping them would make every imported logo
 * anonymous.
 */
export const SVG_ELEMENTS = [
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'title',
  'desc',
] as const

export type SvgElement = (typeof SVG_ELEMENTS)[number]

/**
 * The attributes each element may carry.
 *
 * Presentation attributes only, and no `style`: a `style` attribute can carry
 * `url(...)` references, and allowing CSS would mean parsing CSS to be sure of
 * what it fetches. `class` is absent for the same reason in reverse — it is
 * meaningless without a stylesheet, and a stylesheet is what is not allowed.
 */
const SHARED_ATTRIBUTES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'transform',
] as const

/**
 * Attributes that are dropped rather than refused.
 *
 * The module's rule is to refuse rather than strip, and this is the one
 * principled exception: these carry **no geometry and no paint**, so dropping
 * one cannot change how the document looks, and refusing one would reject every
 * Inkscape and Illustrator export over bookkeeping. `xmlns:dc`, `id`,
 * `inkscape:version` and `class` are grammar and provenance, not drawing.
 *
 * Any prefixed attribute is dropped, because no allowed attribute is in a
 * namespace — which is also why `xlink:href` lands here. It is inert rather
 * than tolerated: the allowlist has no element that references anything, so
 * there is nothing for a reference to reach and nothing for `id` to be the
 * target of. **If a referencing element is ever allowed, dropping `id` stops
 * being safe**, and that is the sentence to read before adding one.
 *
 * The `*-rendering` hints joined them in Phase 193, for a measured reason
 * rather than a felt one: **this application's own QR generator emits
 * `shape-rendering="crispEdges"`**, and that one attribute was the only thing
 * standing between a QR code and the PDF — which had been printing an empty
 * box labelled "QR" since Phase 5.
 *
 * They qualify on the same test as the rest. A rendering hint asks for sharper
 * edges or smoother text; it changes no coordinate and no colour, so a drawing
 * without it is the same drawing. `vector-effect` is deliberately **not** here
 * and is refused: `non-scaling-stroke` changes a stroke's width under a
 * transform, which is geometry wearing a hint's name.
 */
const IGNORED_ATTRIBUTE =
  /^(?:id|class|role|aria-[\w-]+|data-[\w-]+|xmlns:[\w.-]+|[\w.-]+:[\w.-]+|(?:shape|text|image|color)-rendering)$/

const ELEMENT_ATTRIBUTES: Record<SvgElement, readonly string[]> = {
  /*
    `x` and `y` are listed on the root and nowhere read, because the SVG spec
    ignores them on the outermost element — Illustrator writes `x="0px"
    y="0px"` on every export, and refusing a pair of coordinates the standard
    itself discards would be refusing the file over nothing.
  */
  svg: ['viewBox', 'width', 'height', 'x', 'y', 'xmlns', 'version', 'fill', 'stroke'],
  g: SHARED_ATTRIBUTES,
  path: ['d', ...SHARED_ATTRIBUTES],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...SHARED_ATTRIBUTES],
  circle: ['cx', 'cy', 'r', ...SHARED_ATTRIBUTES],
  ellipse: ['cx', 'cy', 'rx', 'ry', ...SHARED_ATTRIBUTES],
  line: ['x1', 'y1', 'x2', 'y2', ...SHARED_ATTRIBUTES],
  polyline: ['points', ...SHARED_ATTRIBUTES],
  polygon: ['points', ...SHARED_ATTRIBUTES],
  title: [],
  desc: [],
}

const CSS_REASON = 'this SVG styles its shapes with CSS, which cannot be read safely'
const CSS_REMEDY =
  'Re-export it with styles written on the shapes themselves rather than as CSS — ' +
  'in Illustrator that is the "Presentation Attributes" CSS option.'

export type Rgb = { r: number; g: number; b: number }

/**
 * The CSS named colours, because a table is a table.
 *
 * Carried in full rather than abridged to the sixteen HTML names. The reason is
 * the rule above: an unresolvable colour has to be **refused**, so an abridged
 * table is not a smaller table — it is a list of logos this will not accept,
 * and `darkslategray` is not an exotic choice. `currentColor` is absent, which
 * is the opposite decision for the opposite reason: it has no value without a
 * cascade, and the cascade is what is not allowed.
 */
const NAMED_COLORS: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
  azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
  blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
  coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00',
  darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a',
  darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
  deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
  dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0',
  forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
  green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0',
  hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0',
  khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00',
  lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080',
  lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa',
  lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6',
  magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
  mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db',
  mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970',
  mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
  navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
  olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
  palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9',
  peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6',
  purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f',
  royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072',
  sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d',
  silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
  slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
  tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
  turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
  whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
}

/**
 * A `fill` or `stroke` value as something that can be painted.
 *
 * `null` means "this module cannot say what colour that is", which at upload is
 * a refusal and in the PDF writer is unreachable — the same answer serving both
 * callers, which is the point. `'none'` is a real answer and not an absence:
 * `fill="none"` on a stroked path is how an outline is drawn.
 *
 * **`url(#gradient)` resolves to `null`** rather than being special-cased,
 * because a paint server is a PDF shading dictionary and that is a different
 * piece of work from a fill.
 */
export function resolvePaint(value: string): Rgb | 'none' | null {
  const text = value.trim().toLowerCase()
  if (text === 'none' || text === 'transparent') return 'none'

  const named = NAMED_COLORS[text]
  if (named) return fromHex(named)

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)
  if (hex) {
    // `#rgba` and `#rrggbbaa` carry an alpha this module does not paint, so the
    // alpha is read and refused if it is not opaque, rather than dropped.
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      const expanded = digits
        .split('')
        .map((digit) => digit + digit)
        .join('')
      if (digits.length === 4 && expanded.slice(6) !== 'ff') return null
      return fromHex(expanded.slice(0, 6))
    }
    if (digits.length === 8 && digits.slice(6) !== 'ff') return null
    return fromHex(digits.slice(0, 6))
  }

  const rgb = /^rgba?\(([^)]*)\)$/.exec(text)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter((part) => part.length > 0)
    if (parts.length !== 3 && parts.length !== 4) return null
    if (parts.length === 4 && Number.parseFloat(parts[3]) !== 1) return null

    const channels = parts.slice(0, 3).map((part) =>
      part.endsWith('%')
        ? (Number.parseFloat(part) / 100) * 255
        : Number.parseFloat(part),
    )
    if (!channels.every((channel) => Number.isFinite(channel))) return null

    return {
      r: clamp01(channels[0] / 255),
      g: clamp01(channels[1] / 255),
      b: clamp01(channels[2] / 255),
    }
  }

  return null
}

function fromHex(digits: string): Rgb {
  const value = parseInt(digits, 16)
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

// ---------------------------------------------------------------------------
// Transforms

/** `[a, b, c, d, e, f]`, in the order a PDF `cm` operator takes them. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function multiply(outer: Matrix, inner: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ]
}

/**
 * A `transform` attribute as a single matrix, or `null` if it is not one.
 *
 * `skewX`/`skewY` are absent: they are representable as a matrix, so this is a
 * deliberate omission rather than a limit — nothing a logo needs produces them,
 * and a form nobody writes is a form nobody tested.
 */
export function parseTransform(value: string): Matrix | null {
  const pattern = /([a-zA-Z]+)\s*\(([^()]*)\)/g
  let result: Matrix = IDENTITY
  let match: RegExpExecArray | null
  let consumed = 0
  let seen = 0

  while ((match = pattern.exec(value)) !== null) {
    if (value.slice(consumed, match.index).trim().length > 0) return null
    consumed = pattern.lastIndex
    seen += 1

    const args = numbersIn(match[2])
    if (!args) return null

    const step = transformStep(match[1], args)
    if (!step) return null
    result = multiply(result, step)
  }

  if (seen === 0 || value.slice(consumed).trim().length > 0) return null
  return result
}

function transformStep(name: string, args: number[]): Matrix | null {
  switch (name) {
    case 'matrix':
      return args.length === 6 ? (args as Matrix) : null
    case 'translate':
      if (args.length === 1) return [1, 0, 0, 1, args[0], 0]
      return args.length === 2 ? [1, 0, 0, 1, args[0], args[1]] : null
    case 'scale':
      if (args.length === 1) return [args[0], 0, 0, args[0], 0, 0]
      return args.length === 2 ? [args[0], 0, 0, args[1], 0, 0] : null
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) return null
      const radians = (args[0] * Math.PI) / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (args.length === 1) return rotation

      // `rotate(a cx cy)` is a rotation about a point, which is three matrices.
      return multiply(
        multiply([1, 0, 0, 1, args[1], args[2]], rotation),
        [1, 0, 0, 1, -args[1], -args[2]],
      )
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Paths

/** One path command, with its arguments already split into whole commands. */
export type PathSegment = { command: string; args: number[] }

const ARGUMENT_COUNT: Record<string, number> = {
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
}

/**
 * A `d` attribute as a list of commands this module can redraw.
 *
 * Returns `null` for anything it cannot read, which is what makes the sanitiser
 * and the PDF writer agree: the sanitiser refuses a path on exactly the
 * condition under which the writer would have had nothing to draw.
 *
 * Shorthand repetition is expanded here rather than in the writer — `L 1 2 3 4`
 * is two line commands, and `M 1 2 3 4` is a move **and a line**, which is the
 * one irregularity in the grammar and the one most likely to be got wrong twice
 * if two readers existed.
 */
export function parsePath(value: string): PathSegment[] | null {
  const tokens = value.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null

  // Every character has to have been a command, a number or a separator. A
  // leftover is a `d` nobody can be sure of.
  if (value.replace(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?|[\s,]+/g, '') !== '') {
    return null
  }

  const segments: PathSegment[] = []
  let at = 0
  let command: string | null = null

  while (at < tokens.length) {
    if (/[A-Za-z]/.test(tokens[at])) {
      command = tokens[at]
      at += 1
    } else if (command === null) {
      return null
    } else if (command === 'M') {
      command = 'L'
    } else if (command === 'm') {
      command = 'l'
    }

    if (command === null) return null
    const needed = ARGUMENT_COUNT[command.toLowerCase()]
    if (needed === undefined) return null

    if (needed === 0) {
      segments.push({ command, args: [] })

      /*
        `Z` takes no arguments, so it cannot repeat — and clearing the command
        is what makes this loop terminate. Leaving it set meant `M0 0 Z 5 5`
        re-entered with a zero-argument command and never advanced `at`: a
        **hang**, on a path an uploaded file chooses, found by reading this
        loop rather than by any assertion. The next token must now be a
        command or the path is one this cannot read.
      */
      command = null
      continue
    }

    const args = tokens.slice(at, at + needed).map(Number)
    if (args.length !== needed || !args.every(Number.isFinite)) return null
    at += needed

    segments.push({ command, args })
  }

  if (segments.length === 0) return null
  if (segments[0].command !== 'M' && segments[0].command !== 'm') return null
  return segments
}

/** `points` on a polyline or polygon: an even count of at least two pairs. */
export function parsePoints(value: string): number[] | null {
  const numbers = numbersIn(value)
  if (!numbers || numbers.length < 4 || numbers.length % 2 !== 0) return null
  return numbers
}

function numbersIn(value: string): number[] | null {
  const trimmed = value.trim()
  if (trimmed === '') return []

  const tokens = trimmed.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null
  if (trimmed.replace(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?|[\s,]+/g, '') !== '') return null

  const numbers = tokens.map(Number)
  return numbers.every(Number.isFinite) ? numbers : null
}

// ---------------------------------------------------------------------------

export type SvgRefusal = { reason: string; remedy: string }

export type SvgNode = {
  name: SvgElement
  attributes: Record<string, string>
  children: SvgNode[]
  text?: string
}

/** A document this module has read completely: a tree and the box it lives in. */
export type SvgDocument = {
  root: SvgNode
  viewBox: [number, number, number, number]
}

export type SvgResult =
  | { ok: true; svg: string; width: number; height: number; viewBox: [number, number, number, number] }
  | { ok: false; refusal: SvgRefusal }

/**
 * The one reader.
 *
 * `sanitizeSvg` calls it to decide what may be stored and the PDF writer calls
 * it to decide what to draw, so the writer cannot meet a construct the
 * sanitiser let through — not because both were written carefully, but because
 * there is one of them.
 */
export function readSvg(source: string): SvgDocument | { refusal: SvgRefusal } {
  if (source.length > 512 * 1024) {
    return { refusal: refusal('this SVG is larger than 512 KB', 'Simplify it, or upload a PNG instead.') }
  }

  // A null byte, a byte-order mark mid-document or a control character is not
  // something a real exporter writes, and is something a parser-confusion
  // attack does.
  if (/[\0\u000B\u000C￾￿]/.test(source)) {
    return {
      refusal: refusal('this file contains control characters', 'Re-export it from a vector editor.'),
    }
  }

  let parsed: SvgNode | { refusal: SvgRefusal }
  try {
    parsed = parseSvg(source)
  } catch (error) {
    return {
      refusal: refusal(
        `this SVG could not be read (${(error as Error).message})`,
        'Re-export it from a vector editor.',
      ),
    }
  }

  if ('refusal' in parsed) return parsed
  if (parsed.name !== 'svg') {
    return { refusal: refusal('this file does not start with an <svg> element', 'Upload an SVG file.') }
  }

  const viewBox = viewBoxOf(parsed)
  if (!viewBox) {
    return {
      refusal: refusal(
        'this SVG has no viewBox and no width and height',
        'Re-export it with a viewBox, which every vector editor can do.',
      ),
    }
  }

  return { root: parsed, viewBox }
}

/**
 * Parses an uploaded SVG and emits a safe, printable one.
 *
 * Refuses rather than strips, which is the opposite of what a sanitiser
 * usually does and is deliberate: a logo with its gradient silently removed is
 * a logo that prints wrong, and the person who could fix it — by exporting a
 * flattened copy — is standing right there at the upload form. Stripping is
 * the right default when the content is a comment somebody typed; refusing is
 * the right default when it is a file they chose and can re-export.
 */
export function sanitizeSvg(source: string): SvgResult {
  const read = readSvg(source)
  if ('refusal' in read) return { ok: false, refusal: read.refusal }

  return {
    ok: true,
    svg: serialize(read.root, read.viewBox),
    width: Math.round(read.viewBox[2]),
    height: Math.round(read.viewBox[3]),
    viewBox: read.viewBox,
  }
}

/**
 * The document's user-space box.
 *
 * `viewBox` first, because it is the only one that says what the coordinates
 * in the paths mean. `width`/`height` are a *suggested* rendered size and a
 * logo's are routinely `100%`, which is why they are the fallback and not the
 * answer.
 */
function viewBoxOf(root: SvgNode): [number, number, number, number] | null {
  const raw = root.attributes.viewBox
  if (raw) {
    const parts = numbersIn(raw)
    if (parts && parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return [parts[0], parts[1], parts[2], parts[3]]
    }
  }

  const width = Number.parseFloat(root.attributes.width ?? '')
  const height = Number.parseFloat(root.attributes.height ?? '')
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return [0, 0, width, height]
  }

  return null
}

/**
 * A minimal XML reader, because this is the one place a general one would be
 * a liability.
 *
 * It understands elements, attributes, self-closing tags, comments and the XML
 * declaration, and **nothing else**. A DOCTYPE, an entity declaration, a
 * processing instruction or a CDATA section is refused rather than skipped —
 * every one of them is a parser-differential trick, and a reader that quietly
 * ignores what it does not understand is how a sanitiser is bypassed.
 */
function parseSvg(source: string): SvgNode | { refusal: SvgRefusal } {
  let at = 0
  const stack: SvgNode[] = []
  let root: SvgNode | null = null

  const fail = (reason: string, remedy: string) => ({ refusal: refusal(reason, remedy) })

  while (at < source.length) {
    const open = source.indexOf('<', at)
    if (open === -1) break

    // Text between tags only matters inside title and desc.
    if (stack.length > 0 && open > at) {
      const parent = stack[stack.length - 1]
      if (parent.name === 'title' || parent.name === 'desc') {
        parent.text = (parent.text ?? '') + decodeEntities(source.slice(at, open))
      }
    }

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open)
      if (end === -1) throw new Error('unterminated comment')
      at = end + 3
      continue
    }

    if (source.startsWith('<?xml', open)) {
      const end = source.indexOf('?>', open)
      if (end === -1) throw new Error('unterminated declaration')
      at = end + 2
      continue
    }

    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      return fail(
        'this SVG contains a DOCTYPE, an entity or a processing instruction',
        'Re-export it as plain SVG, without a DOCTYPE.',
      )
    }

    const close = source.indexOf('>', open)
    if (close === -1) throw new Error('unterminated tag')

    const raw = source.slice(open + 1, close).trim()

    if (raw.startsWith('/')) {
      const name = stripNamespace(raw.slice(1).trim().toLowerCase())
      const current = stack.pop()
      if (!current || current.name !== name) throw new Error(`mismatched </${name}>`)
      if (stack.length === 0) root = current
      at = close + 1
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body)
    if (!nameMatch) throw new Error('a tag with no name')

    const name = stripNamespace(nameMatch[1].toLowerCase())

    if (!(SVG_ELEMENTS as readonly string[]).includes(name)) {
      /*
        CSS is named apart from everything else because it is the refusal a
        real exporter is most likely to earn, and the one with the most exact
        remedy: Illustrator writes a `<style>` sheet and `class` attributes
        when its CSS option says to, and presentation attributes when it does
        not. "Flatten it to paths" would be useless advice for a file whose
        shapes are already paths.
      */
      if (name === 'style') return fail(CSS_REASON, CSS_REMEDY)

      return fail(
        `this SVG uses <${name}>, which cannot be printed safely`,
        'Flatten it to paths and shapes in a vector editor, then upload it again.',
      )
    }

    const element = name as SvgElement

    /*
      A nested `<svg>` establishes a second viewport, with its own coordinate
      system and its own `preserveAspectRatio`. Accepting it would mean the PDF
      writer honouring two of them, and a writer that honoured one and ignored
      the other is a logo that prints at the wrong size — so it is refused here
      rather than half-handled there.
    */
    if (element === 'svg' && stack.length > 0) {
      return fail(
        'this SVG contains a second <svg> element inside it',
        'Flatten it to one drawing in a vector editor, then upload it again.',
      )
    }

    const read = readAttributes(body.slice(nameMatch[0].length))
    if ('refusal' in read) return read

    const allowed = ELEMENT_ATTRIBUTES[element]
    const kept: Record<string, string> = {}

    for (const [key, value] of Object.entries(read.values)) {
      if (IGNORED_ATTRIBUTE.test(key)) continue

      /*
        An event handler, or anything else unlisted. Named in the refusal,
        because "this SVG is not allowed" is unactionable and "it uses onload"
        tells somebody what their exporter did.
      */
      if (!allowed.includes(key)) {
        if (key === 'style') return fail(CSS_REASON, CSS_REMEDY)

        return fail(
          `this SVG uses the ${key} attribute on <${name}>, which cannot be printed safely`,
          'Flatten it to paths and shapes in a vector editor, then upload it again.',
        )
      }

      const problem = attributeProblem(key, value)
      if (problem) return fail(`this SVG's ${key} ${problem.reason}`, problem.remedy)

      kept[key] = value
    }

    const node: SvgNode = { name: element, attributes: kept, children: [] }

    if (stack.length > 0) stack[stack.length - 1].children.push(node)

    if (selfClosing) {
      if (stack.length === 0) root = node
    } else {
      stack.push(node)
    }

    at = close + 1
  }

  if (stack.length > 0) throw new Error(`unclosed <${stack[stack.length - 1].name}>`)
  if (!root) throw new Error('no element found')

  return root
}

/** `xlink:href` and `svg:path` both lose their prefix before being judged. */
function stripNamespace(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

function readAttributes(
  source: string,
): { values: Record<string, string> } | { refusal: SvgRefusal } {
  const values: Record<string, string> = {}
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g

  let match: RegExpExecArray | null
  let consumed = 0

  while ((match = pattern.exec(source)) !== null) {
    if (source.slice(consumed, match.index).trim().length > 0) break
    values[match[1]] = decodeEntities(match[3] ?? match[4] ?? '')
    consumed = pattern.lastIndex
  }

  /*
    An attribute without quotes, or one this pattern could not read, leaves
    text behind. Refused rather than ignored: unparsed text in a tag is
    precisely where a bypass hides.
  */
  if (source.slice(consumed).trim().length > 0) {
    return {
      refusal: refusal(
        'this SVG has an attribute this cannot read',
        'Re-export it from a vector editor, which quotes every attribute.',
      ),
    }
  }

  return { values }
}

/**
 * The five XML entities, and nothing else.
 *
 * A numeric character reference is decoded too, because an exporter writes
 * them in `title` text. Anything else — a named entity the document declared —
 * cannot appear, because a DOCTYPE is refused above.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (whole, hex: string) => codePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d{1,7});/g, (whole, dec: string) => codePoint(Number(dec), whole))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function codePoint(value: number, whole: string): string {
  if (!Number.isFinite(value) || value < 1 || value > 0x10ffff) return whole
  return String.fromCodePoint(value)
}

/**
 * What is wrong with an attribute value, or `null` if nothing is.
 *
 * Every branch asks the question the writer will ask: not "does this look like
 * a colour" but "can `resolvePaint` name it", not "does this look like a path"
 * but "can `parsePath` read it".
 *
 * Each problem carries **its own remedy**, because one remedy for every
 * problem is one remedy that is wrong for most of them — "re-export with plain
 * colours" says nothing to somebody whose transform is a skew (Phase 119).
 */
function attributeProblem(name: string, value: string): { reason: string; remedy: string } | null {
  const fault = (reason: string, remedy: string) => ({ reason, remedy })

  // Belt and braces ahead of the allowlist: no value may reference anything.
  if (/url\s*\(|javascript\s*:|data\s*:|<|>/i.test(value)) {
    return fault(
      'value refers to something outside the file',
      'Re-export it with the reference flattened into the drawing.',
    )
  }

  const flatten = 'Flatten it to paths and shapes in a vector editor, then upload it again.'
  const reExport = 'Re-export it from a vector editor.'

  switch (name) {
    case 'fill':
    case 'stroke':
      return resolvePaint(value) === null
        ? fault(
            'is a colour this cannot paint — a gradient, a pattern, or one that is not fully opaque',
            'Re-export it with flat, opaque colours.',
          )
        : null
    case 'transform':
      return parseTransform(value) === null
        ? fault('is not a move, a scale or a rotation', flatten)
        : null
    case 'd':
      return parsePath(value) === null ? fault('is a path this cannot draw', flatten) : null
    case 'points':
      return parsePoints(value) === null
        ? fault('is not a list of coordinate pairs', reExport)
        : null
    case 'viewBox': {
      const parts = numbersIn(value)
      return parts && parts.length === 4 ? null : fault('is not four numbers', reExport)
    }
    case 'xmlns':
      return value === 'http://www.w3.org/2000/svg'
        ? null
        : fault('is not the SVG namespace', 'Upload a plain SVG file.')
    case 'version':
      return /^[\d.]{1,8}$/.test(value) ? null : fault('is not a version number', reExport)
    case 'stroke-linecap':
      return ['butt', 'round', 'square'].includes(value)
        ? null
        : fault('is not butt, round or square', reExport)
    case 'stroke-linejoin':
      return ['miter', 'round', 'bevel'].includes(value)
        ? null
        : fault('is not miter, round or bevel', reExport)
    case 'fill-rule':
      return ['nonzero', 'evenodd'].includes(value)
        ? null
        : fault('is neither winding rule', reExport)
    case 'opacity':
    case 'fill-opacity':
    case 'stroke-opacity':
      return opaque(value)
        ? null
        : fault(
            'makes part of this drawing see-through, which cannot be printed faithfully',
            'Flatten the transparency in a vector editor, then upload it again.',
          )
    default: {
      const length = /^([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)(px|pt|mm|cm|in|%)?$/
      return length.test(value.trim()) ? null : fault('is not a length', reExport)
    }
  }
}

/**
 * Transparency is accepted only where it is no transparency at all.
 *
 * `opacity="1"` and `fill-opacity="1"` are what every exporter writes, so
 * refusing the attribute outright would refuse most real logos. A value below
 * one is refused, and the reason is specific: `opacity` on a `<g>` is **group**
 * opacity — the group is composited once, as a unit — and the nearest thing a
 * PDF content stream can do without a transparency group is set an alpha on
 * each child, which composites overlapping children differently.
 *
 * That difference would be invisible until a logo with two overlapping shapes
 * printed wrong, which is the two-documents defect this phase's whole argument
 * is against. A transparency group XObject is the honest implementation and is
 * a larger piece of work than this phase; until it exists, flattening is a
 * thing the exporter does well and the refusal says so.
 */
function opaque(value: string): boolean {
  const text = value.trim()
  const number = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text)
  return Number.isFinite(number) && number >= 1
}

/**
 * Writes the document back out from what was understood.
 *
 * The emitted file is this module's, not the uploader's: same shapes, same
 * numbers, nothing else. That is what makes the result safe against the
 * attacks nobody listed — an unknown construct cannot survive a round trip
 * through a representation that has no place to put it.
 */
function serialize(root: SvgNode, box: [number, number, number, number]): string {
  const escape = (text: string) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const write = (node: SvgNode): string => {
    if (node.name === 'title' || node.name === 'desc') {
      const text = (node.text ?? '').trim()
      return text ? `<${node.name}>${escape(text)}</${node.name}>` : ''
    }

    const attributes = Object.entries(node.attributes)
      .map(([key, value]) => ` ${key}="${escape(value)}"`)
      .join('')

    const children = node.children.map(write).join('')
    return children
      ? `<${node.name}${attributes}>${children}</${node.name}>`
      : `<${node.name}${attributes}/>`
  }

  // The root's own presentation attributes are kept, because `fill` on `<svg>`
  // is how a single-colour icon set declares its colour once.
  const rootAttributes = (['fill', 'stroke'] as const)
    .filter((key) => root.attributes[key] !== undefined)
    .map((key) => ` ${key}="${escape(root.attributes[key])}"`)
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(' ')}"` +
    ` width="${box[2]}" height="${box[3]}"${rootAttributes}>` +
    `${root.children.map(write).join('')}</svg>`
  )
}

function refusal(reason: string, remedy: string): SvgRefusal {
  return { reason, remedy }
}
