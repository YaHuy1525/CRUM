import type { Metadata } from 'next'
import { NavLinks } from '@/components/NavLinks'
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
        <nav className="top-nav" aria-label="Main navigation">
          <span className="brand">CRUM</span>
          <NavLinks />
        </nav>
        {children}
      </body>
    </html>
  )
}
