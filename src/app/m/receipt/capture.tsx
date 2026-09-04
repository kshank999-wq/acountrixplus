'use client'

import { useRef, useState } from 'react'
import { formatCents } from '@/lib/money'
import { OutboxBadge } from '../outbox-badge'
import { messageFor, Refusal } from '@/modules/errors'

type Candidate = { id: string; postedDate: string; amountCents: number; label: string }

/**
 * Receipt capture (spec §3 "attach receipts/documents").
 *
 * ## The photo is downscaled here, in the browser
 *
 * A modern phone camera produces three to five megabytes for a photograph of a
 * piece of till paper. Uploading that over a mobile connection is slow, costs
 * the person money, and stores forty times more bytes than a legible receipt
 * needs. Downscaling to 1600px on the long edge takes a few hundred
 * milliseconds and produces a file around 200 KB that is still perfectly
 * readable — including by whatever OCR is added later.
 *
 * Doing it server-side would mean uploading the large file first, which is the
 * expensive part. This is the one case where client-side image processing is
 * clearly right.
 *
 * ## `capture` rather than `getUserMedia`
 *
 * A file input with `capture="environment"` opens the phone's own camera app,
 * with its focus, its exposure, and its document mode. A custom camera built
 * on `getUserMedia` is more impressive and takes worse photographs.
 */
export function ReceiptCapture({ transactions }: { transactions: Candidate[] }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [assetId, setAssetId] = useState<string | null>(null)
  const [sizeLabel, setSizeLabel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [attachedTo, setAttachedTo] = useState<string | null>(null)

  async function onFile(file: File) {
    setBusy(true)
    setMessage(null)
    setAssetId(null)
    setAttachedTo(null)

    try {
      const prepared = await downscale(file)
      setPreview(URL.createObjectURL(prepared))
      setSizeLabel(`${Math.round(prepared.size / 1024)} KB`)

      const form = new FormData()
      form.append('file', prepared, prepared.name)

      const response = await fetch('/api/mobile/v1/receipts', { method: 'POST', body: form })
      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        // The upload is the one part of this flow that cannot be queued: there
        // is nowhere to put a megabyte of JPEG in the outbox without filling
        // the device's storage quota. Offline, the honest answer is to say so.
        setMessage({
          text: navigator.onLine
            ? (body.error ?? 'That upload failed.')
            : 'No connection. Photos need one — take it again when you are back online.',
          ok: false,
        })
        return
      }

      setAssetId(body.assetId)
      setMessage({ text: 'Uploaded. Now choose what it belongs to.', ok: true })
    } catch (error) {
      setMessage({
        text: messageFor(error, 'Could not read that photo.'),
        ok: false,
      })
    } finally {
      setBusy(false)
    }
  }

  async function attach(transaction: Candidate) {
    if (!assetId) return
    setBusy(true)

    try {
      // The attachment *is* queueable — it is a few bytes of JSON — so this
      // part works offline even though the upload did not.
      const { queueOperation } = await import('../outbox-client')
      await queueOperation({
        operation: 'receipt.attach',
        entityId: transaction.id,
        payload: { transactionId: transaction.id, assetId },
      })

      setAttachedTo(transaction.id)
      setMessage({ text: `Attached to ${transaction.label}.`, ok: true })
      window.dispatchEvent(new CustomEvent('accountrix:outbox-changed'))
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null)
    setAssetId(null)
    setSizeLabel(null)
    setAttachedTo(null)
    setMessage(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <div>
      <OutboxBadge />

      {!preview && (
        <div className="card p-6 text-center">
          <p className="text-sm font-medium">Photograph a receipt</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
            The photo is shrunk on this phone before it is sent, so it costs a fraction of your
            data and still reads clearly.
          </p>

          <button
            className="btn btn-primary mt-4 min-h-[3rem] w-full text-sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            Open the camera
          </button>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*,application/pdf"
        // Opens the rear camera directly on a phone, and an ordinary file
        // picker everywhere else — including on a desktop, where it is ignored.
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onFile(file)
        }}
      />

      {preview && (
        <div className="card overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="The receipt you just photographed" className="w-full" />
          <div className="flex items-center justify-between gap-2 border-t border-line p-3">
            <span className="text-xs text-muted">{sizeLabel}</span>
            <button className="btn px-3 py-1 text-xs" onClick={reset} disabled={busy}>
              Retake
            </button>
          </div>
        </div>
      )}

      {message && (
        <p className={`mt-3 text-sm ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </p>
      )}

      {assetId && !attachedTo && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">What is it for?</p>
          {transactions.length === 0 ? (
            <p className="text-xs text-muted">
              Nothing to attach it to yet. The receipt is saved — attach it once the charge
              appears in your feed.
            </p>
          ) : (
            <ul className="space-y-1">
              {transactions.slice(0, 25).map((transaction) => (
                <li key={transaction.id}>
                  <button
                    className="flex min-h-[3rem] w-full items-center justify-between gap-3 rounded-lg border border-line px-3 text-left text-sm active:bg-raised"
                    disabled={busy}
                    onClick={() => void attach(transaction)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{transaction.label}</span>
                      <span className="block text-xs text-muted">{transaction.postedDate}</span>
                    </span>
                    <span className="tnum shrink-0 text-sm">
                      {formatCents(Math.abs(transaction.amountCents))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {attachedTo && (
        <button className="btn btn-primary mt-4 w-full text-sm" onClick={reset}>
          Capture another
        </button>
      )}
    </div>
  )
}

/** The long edge, in pixels, a receipt is shrunk to. */
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.82

/**
 * Shrinks an image to something worth uploading over a mobile connection.
 *
 * PDFs pass straight through — there is nothing to downscale, and rasterizing
 * one would lose the text layer. An image already smaller than the ceiling
 * also passes through untouched rather than being re-encoded, which would only
 * add JPEG artefacts.
 */
async function downscale(file: File): Promise<File> {
  if (file.type === 'application/pdf') return file
  if (!file.type.startsWith('image/')) {
    throw new Refusal('That is not a photo or a PDF.')
  }

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))

  if (scale === 1 && file.size < 400_000) {
    bitmap.close()
    return file
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)

  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    return file
  }

  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  )

  // A canvas that refuses to encode is rare but possible; sending the original
  // is better than failing.
  if (!blob) return file

  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
}
