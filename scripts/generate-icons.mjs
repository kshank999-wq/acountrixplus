/**
 * Generates the PWA icon set from one SVG source.
 *
 * Run by hand — `node scripts/generate-icons.mjs` — not during the build. The
 * PNGs it produces are committed, so a deployment never depends on `sharp`
 * being installable; it arrives here transitively through Next and could stop.
 * The script is the record of how the icons were made, and the files are what
 * ships.
 *
 * Two shapes are produced for a reason. Android masks icons to whatever shape
 * the launcher uses, so a `maskable` icon has to keep everything important
 * inside the middle 80% — the corners get cut. iOS does not mask, so an icon
 * padded for Android looks small there. One source, two paddings.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

/** The brand teal from `globals.css` — kept in step by hand, deliberately. */
const BRAND = '#0d6e60'
const INK = '#ffffff'

/**
 * The mark: an "A" over a ledger rule.
 *
 * Drawn as paths rather than text so it renders identically without a font,
 * which matters because this is rasterized in whatever environment runs the
 * script.
 */
function source({ padding }) {
  // The glyph is drawn in a 100×100 box and scaled into the safe area.
  const size = 100 - padding * 2

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${padding > 5 ? 0 : 22}" fill="${BRAND}"/>
  <g transform="translate(${padding} ${padding}) scale(${size / 100})">
    <path d="M50 18 L74 78 L62 78 L57 64 L43 64 L38 78 L26 78 Z M50 38 L46 54 L54 54 Z"
          fill="${INK}"/>
    <rect x="26" y="84" width="48" height="5" rx="2.5" fill="${INK}" opacity="0.65"/>
  </g>
</svg>`
}

const targets = [
  { file: 'icon-192.png', size: 192, padding: 4 },
  { file: 'icon-512.png', size: 512, padding: 4 },
  // Maskable: everything inside the middle 80%, because the corners are cut.
  { file: 'icon-maskable-192.png', size: 192, padding: 14 },
  { file: 'icon-maskable-512.png', size: 512, padding: 14 },
  // iOS reads this one and does not round it itself.
  { file: 'apple-touch-icon.png', size: 180, padding: 8 },
]

await mkdir(OUT, { recursive: true })

for (const target of targets) {
  const png = await sharp(Buffer.from(source({ padding: target.padding })))
    .resize(target.size, target.size)
    .png()
    .toBuffer()

  await writeFile(path.join(OUT, target.file), png)
  console.log(`  ${target.file}  ${target.size}×${target.size}  ${png.length} bytes`)
}

// The favicon stays SVG: it is the one place a vector is served directly, and
// browsers that support it get a sharp icon at every size.
await writeFile(path.join(OUT, 'icon.svg'), source({ padding: 4 }))
console.log('  icon.svg')
