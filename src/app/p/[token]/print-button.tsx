'use client'

/**
 * Opens the browser's print dialogue.
 *
 * With the document stylesheet's `@page` rules this produces a paginated,
 * print-ready PDF through Save as PDF.
 *
 * Kept alongside the server-rendered download built in Phase 21, because the
 * two answer different questions. This prints *what is on the screen now*,
 * with the real brand font and any images; the download beside it is the
 * snapshot of what was actually sent, which is the one that settles an
 * argument. See ADR 0021.
 */
export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="btn text-xs">
      Print or save as PDF
    </button>
  )
}
