import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Accountrix Plus',
  description:
    'One operating environment for bookkeeping, accounting, clients, proposals, and marketing.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  )
}
