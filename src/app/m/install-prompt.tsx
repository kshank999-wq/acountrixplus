'use client'

import { useEffect, useState } from 'react'

/**
 * The install affordance.
 *
 * Shown once, quietly, at the bottom of the Today screen — and never when the
 * app is already installed. A banner that reappears every visit is the single
 * most disliked thing about installable web apps, so this one remembers being
 * dismissed and does not come back.
 *
 * iOS is a special case: Safari fires no `beforeinstallprompt` and has no
 * programmatic install, so the only honest thing to do is describe where the
 * button is.
 */
export function InstallPrompt() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [iosHint, setIosHint] = useState(false)
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    // Already installed: nothing to offer.
    if (window.matchMedia('(display-mode: standalone)').matches) return
    if (localStorage.getItem('accountrix:install-dismissed') === '1') return

    setDismissed(false)

    const onPrompt = (event: Event) => {
      event.preventDefault()
      setPrompt(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)

    // iOS Safari: no event will ever arrive, so detect it and explain instead.
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent)
    const isSafari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent)
    if (isIos && isSafari) setIosHint(true)

    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  function dismiss() {
    localStorage.setItem('accountrix:install-dismissed', '1')
    setDismissed(true)
  }

  if (dismissed || (!prompt && !iosHint)) return null

  return (
    <div className="card mt-4 p-4">
      <p className="text-sm font-medium">Add it to your home screen</p>
      <p className="mt-1 text-xs text-muted">
        {iosHint
          ? 'Tap Share, then "Add to Home Screen". It opens without the browser bars and keeps working when you have no signal.'
          : 'It opens full-screen and keeps working when you have no signal — anything you do is saved and sent later.'}
      </p>

      <div className="mt-3 flex gap-2">
        {prompt && (
          <button
            className="btn btn-primary flex-1 text-sm"
            onClick={async () => {
              await prompt.prompt()
              await prompt.userChoice
              // Either way this banner is done: they installed it, or they
              // said no and should not be asked again.
              dismiss()
            }}
          >
            Install
          </button>
        )}
        <button className="btn flex-1 text-sm" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  )
}

/** Not in TypeScript's DOM library — it is Chromium-only and non-standard. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
