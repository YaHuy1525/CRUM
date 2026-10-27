import type { Metadata } from 'next'
import Link from 'next/link'
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'

import { Providers } from '@/components/providers'
import { SidebarNav, type SidebarIdentity } from '@/components/SidebarNav'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
})
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
})

import './theme.css'
import './tailwind.css'

export const metadata: Metadata = {
  title: 'CRUM — Conversational CRM workbench',
  description:
    'CRUM is the AI-native workbench for mid-funnel sales: talk to your pipeline, and every change is staged for approval.',
}

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
    <html
      lang="en"
      className={`${inter.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <Providers>
          <a
            href="#app-main"
            className="focus-ring sr-only rounded-md border border-border bg-bg-raised px-3 py-2 text-sm font-medium text-text-primary hover:no-underline focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
          >
            Skip to content
          </a>
          <div className="flex min-h-dvh max-nav:flex-col">
            <nav
              aria-label="Main navigation"
              className="sticky top-0 flex h-dvh w-[var(--sidebar-w)] shrink-0 flex-col gap-1 border-r border-border bg-bg-base px-3 py-4 max-nav:static max-nav:h-auto max-nav:w-auto max-nav:flex-row max-nav:items-center max-nav:gap-2 max-nav:overflow-x-auto max-nav:border-r-0 max-nav:border-b max-nav:py-2"
            >
              <Link
                href="/"
                className="focus-ring mb-4 inline-flex items-center gap-2 px-2 py-2 text-text-primary hover:no-underline max-nav:mb-0 max-nav:whitespace-nowrap"
              >
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-sm bg-[image:linear-gradient(150deg,var(--cedar-500),var(--cedar-900))] font-display text-[length:var(--text-md)] font-bold text-accent-fg shadow-sm"
                >
                  C
                </span>
                <span className="font-display text-lg font-bold tracking-tight text-text-primary">
                  CRUM
                </span>
              </Link>
              <SidebarNav identity={identity} />
            </nav>
            <div
              id="app-main"
              tabIndex={-1}
              className="h-dvh min-w-0 flex-1 overflow-y-auto outline-none max-nav:h-auto max-nav:overflow-visible"
            >
              {children}
            </div>
          </div>
        </Providers>
      </body>
    </html>
  )
}
