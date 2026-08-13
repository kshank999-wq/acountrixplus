'use client'

/**
 * Opens the browser's print dialogue.
 *
 * With the document stylesheet's `@page` rules this produces a paginated,
 * print-ready PDF through Save as PDF. Server-side generation (spec §18) is
 * not built — see ADR 0004.
 */
export function PrintButton() {
  return (
    <button onClick={() => window.print()} className="btn text-xs">
      Print or save as PDF
    </button>
  )
}
