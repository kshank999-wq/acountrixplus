/**
 * A sanitised SVG as PDF path operators (Phase 190, spec §7).
 *
 * ## Why this exists at all
 *
 * `design/svg.ts` argues that SVG import is practical because the subset worth
 * importing is tiny, and that the allowlist is *both* the security boundary and
 * the printable subset. This module is the second half of that claim being
 * true. Without it the claim would be a sentence in a docstring: an SVG logo
 * would render on the proposal page and the PDF the client prints would have a
 * hole in it — which is exactly Phase 185's defect, which was a *declared*
 * limitation nobody re-read for sixty phases.
 *
 * ## It is the same reader
 *
 * This module does not parse SVG. It calls `readSvg`, the function the
 * sanitiser calls, so a construct it could not draw cannot have been stored:
 * `parsePath`, `parseTransform` and `resolvePaint` already returned `null` for
 * it at upload and the file was refused with a remedy. That is why there is no
 * "unsupported, skip it" branch below — the branch would be unreachable, and an
 * unreachable fallback is how a silent blank gets into a document.
 *
 * ## The geometry
 *
 * Three facts do all the work:
 *
 * 1. **SVG's y axis points down and PDF's points up**, so the base matrix has a
 *    negative `d` and the whole drawing is emitted in SVG's own coordinates
 *    with one flip at the top. Converting each coordinate as it is written is
 *    the alternative and it gets arcs and curve control points wrong.
 * 2. **`transform` nests exactly like `q`/`cm` … `Q`**, which is why the tree
 *    walk below is a direct translation rather than a matrix accumulation.
 * 3. **A PDF stroke scales with the matrix**, as an SVG one does, so
 *    `stroke-width` is written once in user units and needs no correction.
 *
 * Paint, by contrast, is tracked in JavaScript and written out explicitly on
 * every shape. PDF's graphics state would inherit it too, but SVG's inheritance
 * rules are not PDF's, and a shape that is the right shape in the wrong colour
 * is a worse bug than one that is missing.
 */

import {
  parsePath,
  parsePoints,
  parseTransform,
  readSvg,
  resolvePaint,
  type Matrix,
  type PathSegment,
  type Rgb,
  type SvgDocument,
  type SvgNode,
} from '@/modules/design/svg'
import { KAPPA, fixed } from './geometry'

/** Where on the page the drawing goes, in PDF user space (`y` upward). */
export type VectorPlacement = { x: number; y: number; width: number; height: number }

/**
 * SVG's initial paint, which is not "nothing".
 *
 * `fill` defaults to **black** and `stroke` to none, so a `<path d="...">` with
 * no attributes at all is a solid black shape. Getting that default wrong makes
 * every minimal icon invisible, and minimal icons are most of them.
 */
const INITIAL_PAINT: Paint = {
  fill: { r: 0, g: 0, b: 0 },
  stroke: 'none',
  strokeWidth: 1,
  evenOdd: false,
  lineCap: 0,
  lineJoin: 0,
}

type Paint = {
  fill: Rgb | 'none'
  stroke: Rgb | 'none'
  strokeWidth: number
  evenOdd: boolean
  lineCap: 0 | 1 | 2
  lineJoin: 0 | 1 | 2
}

/**
 * The operators that draw a stored SVG inside `placement`.
 *
 * Returns `[]` for an SVG this cannot read, which in practice means one that
 * was not stored by `sanitizeSvg` — the caller treats that as "no drawing"
 * rather than as an error, because a PDF is produced on a background job and
 * refusing to produce one over a logo would be the wrong trade. The upload path
 * is where a refusal reaches a person.
 */
export function vectorOperators(svg: string, placement: VectorPlacement): string[] {
  const read = readSvg(svg)
  if ('refusal' in read) return []

  return drawDocument(read, placement)
}

function drawDocument(document: SvgDocument, placement: VectorPlacement): string[] {
  const [boxX, boxY, boxWidth, boxHeight] = document.viewBox

  /*
    `preserveAspectRatio="xMidYMid meet"`, the SVG default, which is also what
    the page does with the same file. Stretching to fill the box is the only
    other option and it is never what somebody wants of a logo.
  */
  const scale = Math.min(placement.width / boxWidth, placement.height / boxHeight)
  if (!Number.isFinite(scale) || scale <= 0) return []

  const left = placement.x + (placement.width - boxWidth * scale) / 2
  const bottom = placement.y + (placement.height - boxHeight * scale) / 2

  /*
    The flip. A point `(ux, uy)` in the file's coordinates lands at
    `left + (ux - boxX) * scale` across and `bottom + boxHeight * scale -
    (uy - boxY) * scale` up, which is this matrix and nothing else.
  */
  const base: Matrix = [
    scale,
    0,
    0,
    -scale,
    left - boxX * scale,
    bottom + (boxHeight + boxY) * scale,
  ]

  const ops: string[] = ['q', matrixOp(base)]
  const root = document.root
  const paint = inherit(INITIAL_PAINT, root)

  for (const child of root.children) ops.push(...drawNode(child, paint))

  ops.push('Q')
  return ops
}

function drawNode(node: SvgNode, inherited: Paint): string[] {
  if (node.name === 'title' || node.name === 'desc') return []

  const paint = inherit(inherited, node)
  const transform = node.attributes.transform
    ? parseTransform(node.attributes.transform)
    : null

  const body =
    node.name === 'g'
      ? node.children.flatMap((child) => drawNode(child, paint))
      : drawShape(node, paint)

  if (body.length === 0) return []
  if (!transform) return body

  return ['q', matrixOp(transform), ...body, 'Q']
}

/**
 * One shape's path and its paint operator.
 *
 * The paint operator is chosen last and from the paint alone: `f` for a fill,
 * `S` for a stroke, `B` for both, and **`n` for neither**. `n` is the one worth
 * naming — `fill="none"` with no stroke is a legitimate thing for an exporter
 * to write (a hit area, a hidden guide), and a path left on the stack with no
 * paint operator would make the next shape's operator paint it.
 */
function drawShape(node: SvgNode, paint: Paint): string[] {
  const path = shapePath(node)
  if (path.length === 0) return []

  const painted = paintOperator(node, paint)
  if (!painted) return []

  return [...paintState(paint, node), ...path, painted]
}

function paintOperator(node: SvgNode, paint: Paint): string | null {
  // A line has no interior, so SVG never fills one however `fill` is set.
  const fills = paint.fill !== 'none' && node.name !== 'line' && node.name !== 'polyline'
  const strokes = paint.stroke !== 'none'

  if (fills && strokes) return paint.evenOdd ? 'B*' : 'B'
  if (fills) return paint.evenOdd ? 'f*' : 'f'
  if (strokes) return 'S'
  return null
}

function paintState(paint: Paint, node: SvgNode): string[] {
  const ops: string[] = []

  if (paint.fill !== 'none' && node.name !== 'line' && node.name !== 'polyline') {
    ops.push(`${fixed(paint.fill.r)} ${fixed(paint.fill.g)} ${fixed(paint.fill.b)} rg`)
  }

  if (paint.stroke !== 'none') {
    ops.push(
      `${fixed(paint.stroke.r)} ${fixed(paint.stroke.g)} ${fixed(paint.stroke.b)} RG`,
      `${fixed(paint.strokeWidth)} w`,
      `${paint.lineCap} J`,
      `${paint.lineJoin} j`,
    )
  }

  return ops
}

/**
 * The paint in force on a node, given what it inherited.
 *
 * Every property is read from the attribute if present and inherited if not,
 * which is SVG's rule for presentation attributes and the reason `<g
 * fill="#0d6e60">` works at all.
 */
function inherit(parent: Paint, node: SvgNode): Paint {
  const paint: Paint = { ...parent }

  if (node.attributes.fill !== undefined) {
    const fill = resolvePaint(node.attributes.fill)
    if (fill !== null) paint.fill = fill
  }

  if (node.attributes.stroke !== undefined) {
    const stroke = resolvePaint(node.attributes.stroke)
    if (stroke !== null) paint.stroke = stroke
  }

  if (node.attributes['stroke-width'] !== undefined) {
    const width = Number.parseFloat(node.attributes['stroke-width'])
    if (Number.isFinite(width) && width >= 0) paint.strokeWidth = width
  }

  if (node.attributes['fill-rule'] !== undefined) {
    paint.evenOdd = node.attributes['fill-rule'] === 'evenodd'
  }

  const caps = { butt: 0, round: 1, square: 2 } as const
  const cap = caps[node.attributes['stroke-linecap'] as keyof typeof caps]
  if (cap !== undefined) paint.lineCap = cap

  const joins = { miter: 0, round: 1, bevel: 2 } as const
  const join = joins[node.attributes['stroke-linejoin'] as keyof typeof joins]
  if (join !== undefined) paint.lineJoin = join

  return paint
}

// ---------------------------------------------------------------------------
// Shapes

function shapePath(node: SvgNode): string[] {
  switch (node.name) {
    case 'path': {
      const segments = node.attributes.d ? parsePath(node.attributes.d) : null
      return segments ? pathOperators(segments) : []
    }
    case 'rect':
      return rectOperators(node)
    case 'circle': {
      const r = number(node, 'r')
      return r > 0 ? ellipseOperators(number(node, 'cx'), number(node, 'cy'), r, r) : []
    }
    case 'ellipse': {
      const rx = number(node, 'rx')
      const ry = number(node, 'ry')
      return rx > 0 && ry > 0
        ? ellipseOperators(number(node, 'cx'), number(node, 'cy'), rx, ry)
        : []
    }
    case 'line':
      return [
        `${fixed(number(node, 'x1'))} ${fixed(number(node, 'y1'))} m`,
        `${fixed(number(node, 'x2'))} ${fixed(number(node, 'y2'))} l`,
      ]
    case 'polyline':
    case 'polygon': {
      const points = node.attributes.points ? parsePoints(node.attributes.points) : null
      if (!points) return []

      const ops = [`${fixed(points[0])} ${fixed(points[1])} m`]
      for (let at = 2; at < points.length; at += 2) {
        ops.push(`${fixed(points[at])} ${fixed(points[at + 1])} l`)
      }
      if (node.name === 'polygon') ops.push('h')
      return ops
    }
    default:
      return []
  }
}

/**
 * A rectangle, rounded if it asks to be.
 *
 * `rx` alone means both radii, which is SVG's rule and the form an exporter
 * writes. The radii are clamped to half the side, as the spec requires —
 * without which `rx="50"` on a 10-wide rect draws a shape that turns inside
 * out.
 */
function rectOperators(node: SvgNode): string[] {
  const x = number(node, 'x')
  const y = number(node, 'y')
  const width = number(node, 'width')
  const height = number(node, 'height')
  if (width <= 0 || height <= 0) return []

  const hasRx = node.attributes.rx !== undefined
  const hasRy = node.attributes.ry !== undefined
  let rx = hasRx ? number(node, 'rx') : hasRy ? number(node, 'ry') : 0
  let ry = hasRy ? number(node, 'ry') : rx

  rx = Math.min(Math.max(rx, 0), width / 2)
  ry = Math.min(Math.max(ry, 0), height / 2)

  if (rx === 0 || ry === 0) {
    return [`${fixed(x)} ${fixed(y)} ${fixed(width)} ${fixed(height)} re`]
  }

  const kx = rx * KAPPA
  const ky = ry * KAPPA
  const right = x + width
  const bottom = y + height

  return [
    `${fixed(x + rx)} ${fixed(y)} m`,
    `${fixed(right - rx)} ${fixed(y)} l`,
    curve(right - rx + kx, y, right, y + ry - ky, right, y + ry),
    `${fixed(right)} ${fixed(bottom - ry)} l`,
    curve(right, bottom - ry + ky, right - rx + kx, bottom, right - rx, bottom),
    `${fixed(x + rx)} ${fixed(bottom)} l`,
    curve(x + rx - kx, bottom, x, bottom - ry + ky, x, bottom - ry),
    `${fixed(x)} ${fixed(y + ry)} l`,
    curve(x, y + ry - ky, x + rx - kx, y, x + rx, y),
    'h',
  ]
}

/** Four Béziers, the same approximation `clipPath` uses for a circular mask. */
function ellipseOperators(cx: number, cy: number, rx: number, ry: number): string[] {
  const kx = rx * KAPPA
  const ky = ry * KAPPA

  return [
    `${fixed(cx - rx)} ${fixed(cy)} m`,
    curve(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
    curve(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
    curve(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
    curve(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
    'h',
  ]
}

// ---------------------------------------------------------------------------
// Paths

/**
 * Path segments as PDF operators.
 *
 * PDF has three path constructors — `m`, `l` and `c` — so every one of SVG's
 * ten commands arrives here as a move, a line or a **cubic**. Quadratics are
 * exact as cubics; the smooth forms are a cubic with a reflected control point;
 * an elliptical arc is the one that is an approximation, and is split so that
 * no piece spans more than a quarter turn.
 *
 * `current` and `start` are tracked because the relative commands are relative
 * to the former and `Z` returns to the latter. `previousControl` is what makes
 * `S` and `T` smooth: the reflection of the last curve's second control point,
 * and **the current point when the last command was not a curve**, which is the
 * clause that is easy to miss and shows as a kink.
 */
function pathOperators(segments: PathSegment[]): string[] {
  const ops: string[] = []
  let current: [number, number] = [0, 0]
  let start: [number, number] = [0, 0]
  let previousControl: [number, number] | null = null
  let previousWasCubic = false
  let previousWasQuadratic = false

  for (const segment of segments) {
    const relative = segment.command === segment.command.toLowerCase()
    const command = segment.command.toUpperCase()
    const args = segment.args
    const [cx, cy] = current
    const dx = relative ? cx : 0
    const dy = relative ? cy : 0

    let cubic = false
    let quadratic = false

    switch (command) {
      case 'M':
        current = [args[0] + dx, args[1] + dy]
        start = current
        ops.push(`${fixed(current[0])} ${fixed(current[1])} m`)
        break

      case 'L':
        current = [args[0] + dx, args[1] + dy]
        ops.push(`${fixed(current[0])} ${fixed(current[1])} l`)
        break

      case 'H':
        current = [args[0] + dx, cy]
        ops.push(`${fixed(current[0])} ${fixed(current[1])} l`)
        break

      case 'V':
        current = [cx, args[0] + dy]
        ops.push(`${fixed(current[0])} ${fixed(current[1])} l`)
        break

      case 'C': {
        const control = [args[0] + dx, args[1] + dy] as [number, number]
        const second = [args[2] + dx, args[3] + dy] as [number, number]
        current = [args[4] + dx, args[5] + dy]
        ops.push(curve(control[0], control[1], second[0], second[1], current[0], current[1]))
        previousControl = second
        cubic = true
        break
      }

      case 'S': {
        const first = previousWasCubic && previousControl ? reflect(previousControl, [cx, cy]) : [cx, cy]
        const second = [args[0] + dx, args[1] + dy] as [number, number]
        current = [args[2] + dx, args[3] + dy]
        ops.push(curve(first[0], first[1], second[0], second[1], current[0], current[1]))
        previousControl = second
        cubic = true
        break
      }

      case 'Q': {
        const control = [args[0] + dx, args[1] + dy] as [number, number]
        current = [args[2] + dx, args[3] + dy]
        ops.push(quadraticAsCubic([cx, cy], control, current))
        previousControl = control
        quadratic = true
        break
      }

      case 'T': {
        const control: [number, number] =
          previousWasQuadratic && previousControl ? reflect(previousControl, [cx, cy]) : [cx, cy]
        current = [args[0] + dx, args[1] + dy]
        ops.push(quadraticAsCubic([cx, cy], control, current))
        previousControl = control
        quadratic = true
        break
      }

      case 'A': {
        const end = [args[5] + dx, args[6] + dy] as [number, number]
        ops.push(
          ...arcAsCubics([cx, cy], end, args[0], args[1], args[2], args[3] !== 0, args[4] !== 0),
        )
        current = end
        break
      }

      case 'Z':
        ops.push('h')
        current = start
        break
    }

    previousWasCubic = cubic
    previousWasQuadratic = quadratic
    if (!cubic && !quadratic) previousControl = null
  }

  return ops
}

function reflect(control: [number, number], about: [number, number]): [number, number] {
  return [2 * about[0] - control[0], 2 * about[1] - control[1]]
}

/**
 * A quadratic as the cubic it exactly equals.
 *
 * The two control points sit two thirds of the way from each endpoint to the
 * quadratic's single control point. This is an identity, not an approximation,
 * which is why no quadratic in an imported path loses anything.
 */
function quadraticAsCubic(
  from: [number, number],
  control: [number, number],
  to: [number, number],
): string {
  return curve(
    from[0] + (2 / 3) * (control[0] - from[0]),
    from[1] + (2 / 3) * (control[1] - from[1]),
    to[0] + (2 / 3) * (control[0] - to[0]),
    to[1] + (2 / 3) * (control[1] - to[1]),
    to[0],
    to[1],
  )
}

/**
 * An elliptical arc as cubic Béziers.
 *
 * SVG writes an arc in **endpoint** form — "get to this point along an ellipse
 * of these radii" — and a Bézier needs the **centre** form, so the first half
 * of this is the conversion the SVG specification sets out in its implementation
 * notes, radii correction included: an arc whose radii are too small to reach
 * the endpoint has them scaled up until it can, which is the spec's rule and
 * not a repair invented here.
 *
 * The arc is then split into pieces of at most a quarter turn, because the
 * Bézier approximation to a circular arc degrades with its span. A quarter is
 * where `KAPPA` comes from, which is why that is the limit rather than a third
 * or a half.
 */
function arcAsCubics(
  from: [number, number],
  to: [number, number],
  rxIn: number,
  ryIn: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
): string[] {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)

  // "If rx or ry is 0, this arc is treated as a straight line." The spec says
  // so, and so does every renderer the page will be viewed in.
  if (rx === 0 || ry === 0) return [`${fixed(to[0])} ${fixed(to[1])} l`]
  if (from[0] === to[0] && from[1] === to[1]) return []

  const phi = (rotationDegrees * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)

  const halfDx = (from[0] - to[0]) / 2
  const halfDy = (from[1] - to[1]) / 2
  const x1 = cosPhi * halfDx + sinPhi * halfDy
  const y1 = -sinPhi * halfDx + cosPhi * halfDy

  // Radii correction (spec §B.2.5 step 3): scale them up to the smallest pair
  // that can reach the endpoint.
  const excess = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (excess > 1) {
    const factor = Math.sqrt(excess)
    rx *= factor
    ry *= factor
  }

  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  const numerator = rx * rx * ry * ry - denominator
  const radical = Math.sqrt(Math.max(0, numerator / denominator)) * (largeArc === sweep ? -1 : 1)

  const cxPrime = (radical * rx * y1) / ry
  const cyPrime = (-radical * ry * x1) / rx
  const centreX = cosPhi * cxPrime - sinPhi * cyPrime + (from[0] + to[0]) / 2
  const centreY = sinPhi * cxPrime + cosPhi * cyPrime + (from[1] + to[1]) / 2

  const startAngle = Math.atan2((y1 - cyPrime) / ry, (x1 - cxPrime) / rx)
  const endAngle = Math.atan2((-y1 - cyPrime) / ry, (-x1 - cxPrime) / rx)

  let sweepAngle = endAngle - startAngle
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI

  const pieces = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)))
  const step = sweepAngle / pieces
  const ops: string[] = []

  // The tangent-length constant for an arbitrary span. At a quarter turn this
  // is KAPPA, which is the check that the general formula is the right one.
  const alpha = (4 / 3) * Math.tan(step / 4)

  for (let piece = 0; piece < pieces; piece += 1) {
    const theta1 = startAngle + piece * step
    const theta2 = theta1 + step

    const start = onEllipse(centreX, centreY, rx, ry, cosPhi, sinPhi, theta1)
    const end = onEllipse(centreX, centreY, rx, ry, cosPhi, sinPhi, theta2)
    const startTangent = tangent(rx, ry, cosPhi, sinPhi, theta1)
    const endTangent = tangent(rx, ry, cosPhi, sinPhi, theta2)

    ops.push(
      curve(
        start[0] + alpha * startTangent[0],
        start[1] + alpha * startTangent[1],
        end[0] - alpha * endTangent[0],
        end[1] - alpha * endTangent[1],
        end[0],
        end[1],
      ),
    )
  }

  return ops
}

function onEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  cosPhi: number,
  sinPhi: number,
  theta: number,
): [number, number] {
  const x = rx * Math.cos(theta)
  const y = ry * Math.sin(theta)
  return [cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y]
}

function tangent(
  rx: number,
  ry: number,
  cosPhi: number,
  sinPhi: number,
  theta: number,
): [number, number] {
  const x = -rx * Math.sin(theta)
  const y = ry * Math.cos(theta)
  return [cosPhi * x - sinPhi * y, sinPhi * x + cosPhi * y]
}

// ---------------------------------------------------------------------------

function curve(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): string {
  return (
    `${fixed(x1)} ${fixed(y1)} ${fixed(x2)} ${fixed(y2)} ` +
    `${fixed(x3)} ${fixed(y3)} c`
  )
}

function matrixOp(matrix: Matrix): string {
  return `${matrix.map(fixed).join(' ')} cm`
}

function number(node: SvgNode, name: string): number {
  const value = Number.parseFloat(node.attributes[name] ?? '')
  return Number.isFinite(value) ? value : 0
}
