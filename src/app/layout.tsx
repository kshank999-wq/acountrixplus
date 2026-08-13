import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Accountrix Plus',
  description:
    'One operating environment for bookkeeping, accounting, clients, proposals, and marketing.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Accountrix Plus',
  icons: {
    icon: [
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    title: 'Accountrix',
    // The status bar sits over the page, so the app's own header supplies the
    // colour behind it rather than iOS painting a band above it.
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    // Left off deliberately: iOS otherwise turns transaction amounts and
    // reference numbers into phone links, which looks broken in a ledger.
    telephone: false,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays enabled. Disabling it makes small figures unreadable for anyone
  // who needs to enlarge them, and a ledger is exactly where that matters.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0d6e60' },
    { media: '(prefers-color-scheme: dark)', color: '#091420' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  )
}
