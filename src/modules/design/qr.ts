import QRCode from 'qrcode'
import type { Block } from './blocks'
import { safeQrValue } from './urls'

/**
 * Server-side QR rendering (spec §8).
 *
 * Encoded to SVG rather than a raster so a code printed on a capability
 * statement stays scannable at any size, and done on the server so the markup
 * is identical in the browser, in print, and in an email where no script runs.
 */

/** Renders every QR block in a document, keyed by block id. */
export async function renderQrCodes(blocks: Block[]): Promise<Record<string, string>> {
  const codes: Record<string, string> = {}

  for (const block of blocks) {
    if (block.type !== 'qrCode') continue

    const value = safeQrValue(block.value)
    if (!value) continue

    try {
      codes[block.id] = await QRCode.toString(value, {
        type: 'svg',
        margin: 1,
        // Survives a fold or a coffee ring on printed collateral.
        errorCorrectionLevel: 'M',
      })
    } catch {
      // A value too long to encode should drop the code, not the page.
      continue
    }
  }

  return codes
}
