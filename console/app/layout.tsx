import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'CRUM Console',
  description: 'Conversational CRM workbench',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <nav className="top-nav">
          <span className="brand">CRUM</span>
          <Link href="/">Home</Link>
          <Link href="/usage">Usage</Link>
        </nav>
        {children}
      </body>
    </html>
  )
}
