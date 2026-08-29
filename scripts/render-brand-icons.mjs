/**
 * Renders the brand's raster icons from the mark (Phase 73).
 *
 * The PNG sizes a web manifest needs cannot be drawn by the application at
 * request time without a rasteriser, so they are produced here and committed —
 * but produced *from `modules/brand/identity`*, so the home-screen icon and
 * the mark in the rail cannot drift apart the way the old teal one had.
 *
 *   node scripts/render-brand-icons.mjs
 *
 * Chromium is the rasteriser because Playwright is already a dependency of the
 * browser checks; nothing new is installed to draw four squares.
 */

import { createRequire } from 'node:module'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The constants, inlined rather than imported: this is a plain `.mjs` script
// and `modules/brand/identity` is TypeScript behind a path alias. Kept in step
// by `tests/brand-identity.test.ts`, which fails if they drift.
const GROUND = '#D6F24E'
const LETTER_FILL = '#0D1117'
const PLUS_FILL = '#98A2B0'
const RADIUS = 26
const LETTER = 'M43.5 21h13l19 58h-13.5l-3.5-11.5h-17L38 79H24.5zM50 36.5l-5 19h10z'
const PLUS = 'M69 30h8.5v9H86v8.5h-8.5V56H69v-8.5h-8.5V39H69z'

/**
 * Playwright is a tool this container provides rather than a dependency of the
 * application, so it is resolved from wherever it actually is rather than
 * added to `package.json` — nothing the product ships needs a browser.
 */
const require = createRequire(import.meta.url)
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright',
)

const here = dirname(fileURLToPath(import.meta.url))
const icons = join(here, '..', 'public', 'icons')

const shapes = `
  <path d="${LETTER}" fill="${LETTER_FILL}" fill-rule="evenodd"/>
  <path d="${PLUS}" fill="${PLUS_FILL}"/>`

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${RADIUS}" fill="${GROUND}"/>${shapes}
</svg>`

/**
 * Full-bleed, with the mark inside the middle 80%.
 *
 * Android crops a maskable icon to whatever shape the launcher uses and only
 * that 80% is guaranteed to survive, so a round launcher gets a lime disc with
 * the A+ centred rather than a rounded square with its corners shaved off.
 */
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="${GROUND}"/>
  <g transform="translate(10 10) scale(0.8)">${shapes}</g>
</svg>`

writeFileSync(join(icons, 'icon.svg'), markSvg)
console.log('wrote icon.svg')

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

for (const [file, svg, size] of [
  ['icon-192.png', markSvg, 192],
  ['icon-512.png', markSvg, 512],
  ['apple-touch-icon.png', markSvg, 180],
  ['icon-maskable-192.png', maskableSvg, 192],
  ['icon-maskable-512.png', maskableSvg, 512],
  ['favicon-32.png', markSvg, 32],
]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px">${svg.replace(
      '<svg ',
      `<svg width="${size}" height="${size}" `,
    )}</body>`,
  )
  // `omitBackground` so the rounded corners stay transparent rather than
  // picking up the white of a page nobody will ever see.
  const png = await page.screenshot({ omitBackground: true })
  writeFileSync(join(icons, file), png)
  await page.close()
  console.log('wrote', file, `${size}×${size}`)
}

/**
 * `/favicon.ico`, because a browser asks for it whatever the metadata says.
 *
 * It was a 404 on every page load — the one request no page declares and every
 * browser makes. An ICO is a six-byte header, one sixteen-byte directory entry
 * and a payload; since Vista that payload may be a PNG, so the 32px render
 * above is wrapped rather than re-encoded into the old bitmap format.
 */
const png = readFileSync(join(icons, 'favicon-32.png'))
const ico = Buffer.alloc(22 + png.length)
ico.writeUInt16LE(0, 0) // reserved
ico.writeUInt16LE(1, 2) // 1 = icon
ico.writeUInt16LE(1, 4) // one image
ico.writeUInt8(32, 6) // width
ico.writeUInt8(32, 7) // height
ico.writeUInt8(0, 8) // colours in palette: none, it is truecolour
ico.writeUInt8(0, 9) // reserved
ico.writeUInt16LE(1, 10) // colour planes
ico.writeUInt16LE(32, 12) // bits per pixel
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18) // where the payload starts
png.copy(ico, 22)
writeFileSync(join(here, '..', 'public', 'favicon.ico'), ico)
// The 32px render was only ever scaffolding for the line above.
rmSync(join(icons, 'favicon-32.png'))
console.log('wrote favicon.ico', `32×32, ${ico.length} bytes`)

await browser.close()
