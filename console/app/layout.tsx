import type { Metadata } from 'next'
import Link from 'next/link'
import { NavLinks } from '@/components/NavLinks'
import './theme.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'CRUM — Conversational CRM workbench',
  description:
    'CRUM is the AI-native workbench for mid-funnel sales: talk to your pipeline, and every change is staged for approval.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600;8..60,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="app-shell">
          <nav className="sidebar" aria-label="Main navigation">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                C
              </span>
              <span className="brand-name">CRUM</span>
            </Link>
            <p className="nav-section-label">Workspace</p>
            <NavLinks />
            <span className="nav-spacer" aria-hidden="true" />
            <div className="user-chip" title="Local development identity">
              <span className="user-avatar" aria-hidden="true">
                D
              </span>
              <span>
                <span className="user-name">dev user</span>
                <span className="user-workspace">
                  <span className="env-dot" aria-hidden="true" />
                  local tenant
                </span>
              </span>
            </div>
          </nav>
          <div className="app-main">{children}</div>
        </div>
      </body>
    </html>
  )
}
