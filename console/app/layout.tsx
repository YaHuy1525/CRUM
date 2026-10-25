import type { Metadata } from 'next'
import Link from 'next/link'

import { Providers } from '@/components/providers'
import { SidebarNav, type SidebarIdentity } from '@/components/SidebarNav'

// Import order is load-bearing and must not change:
//   1. theme.css   — every design token (:root custom properties).
//   2. tailwind.css— Tailwind utilities mapped *onto* those tokens.
//   3. globals.css — the legacy stylesheet (composed from the same tokens),
//                    which stays until the Phase 5 polish deletes it.
// Dropping theme.css silently unstyles the whole app: globals.css and the
// Tailwind layer only reference var(--token), they never define the values.
import './theme.css'
import './tailwind.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'CRUM — Conversational CRM workbench',
  description:
    'CRUM is the AI-native workbench for mid-funnel sales: talk to your pipeline, and every change is staged for approval.',
}

/**
 * Identity for the sidebar footer, read on the server from this process's own
 * environment — the same keys `middleware.ts` injects into the proxied planes.
 * Nothing here is fabricated: in `dev` mode the real `CRUM_DEV_*` ids are shown,
 * and in any other mode the footer falls back to a generic "Signed-in
 * workspace". These are non-secret local fixtures (see `middleware.ts`), so
 * rendering them into the shell is safe; `jwt` mode reads the caller's own token
 * and exposes no id here.
 */
function resolveIdentity(): SidebarIdentity {
  return {
    mode: process.env.CRUM_AUTH_MODE ?? 'dev',
    userId: process.env.CRUM_DEV_USER_ID,
    tenantId: process.env.CRUM_DEV_TENANT_ID,
  }
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = resolveIdentity()

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
        <Providers>
          <div className="app-shell">
            <nav className="sidebar" aria-label="Main navigation">
              <Link href="/" className="brand">
                <span className="brand-mark" aria-hidden="true">
                  C
                </span>
                <span className="brand-name">CRUM</span>
              </Link>
              <SidebarNav identity={identity} />
            </nav>
            <div className="app-main">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  )
}
