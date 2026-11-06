/**
 * The two numeric primitives the PDF writer and the vector converter share.
 *
 * A leaf of its own rather than an export from `writer.ts`, because the
 * converter needs both and the writer calls the converter — so exporting them
 * from `writer.ts` would make the two modules import each other. A cycle that
 * happens to work because the uses are inside functions is a cycle that stops
 * working when somebody moves a constant.
 *
 * They are shared rather than copied for a stronger reason than tidiness.
 * `fixed`'s rounding is what makes the output bytes stable, and a PDF's digest
 * is load-bearing here (Phase 134's reproducibility claim); two roundings would
 * be two answers to "how many decimals", with the disagreement landing in a
 * hash. `KAPPA` is shared because a mask's circle and an imported circle have
 * to be the same circle.
 */

/**
 * Fixed to three decimals, and `-0` collapsed.
 *
 * The rounding is what makes the output stable: floating-point drift in a
 * layout calculation would otherwise change the bytes without changing the
 * document, and the digest is load-bearing here.
 */
export function fixed(value: number): string {
  const rounded = Number(value.toFixed(3))
  return String(rounded === 0 ? 0 : rounded)
}

/**
 * How far a Bézier control point sits along the tangent to approximate a
 * quarter arc.
 *
 * `4/3 × (√2 − 1)`. The standard constant, written as the arithmetic rather
 * than as `0.5523` so a reader can see it is derived and not tuned.
 */
export const KAPPA = (4 / 3) * (Math.SQRT2 - 1)
