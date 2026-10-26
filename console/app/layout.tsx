import type { Metadata } from 'next'
import Link from 'next/link'
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'

import { Providers } from '@/components/providers'
import { SidebarNav, type SidebarIdentity } from '@/components/SidebarNav'

/**
 * The three families `theme.css` names, served by the console's own origin.
 *
 * §"Design system foundation": "all self hosted through `next/font` instead of a
 * blocking external request". `next/font/google` downloads the faces at build
 * time, self-hosts them, and hands each one a custom property; the three
 * variables are then the first entry of the matching `--font-*` stack in
 * `theme.css`, which keeps that file the source of truth for the fallback chain
 * a machine without the build cache would still resolve. No weights are pinned:
 * all three families are variable fonts, so one file covers the 400 to 700 range
 * the console uses.
 */
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

// Import order is load-bearing and must not change:
//   1. theme.css    — every design token (:root custom properties), plus the
//                     `.focus-ring` utility and the reduced-motion override.
//   2. tailwind.css — Tailwind utilities mapped *onto* those tokens, and the
//                     `@layer base` element defaults.
// Dropping theme.css silently unstyles the whole app: the Tailwind layer only
// references var(--token), it never defines the values.
//
// The legacy `globals.css` was deleted in the polish phase. Its element
// defaults moved into `@layer base` in tailwind.css, and the three surfaces
// that still read its class names (this shell, `SidebarNav`, `UsageDashboard`)
// now carry Tailwind token utilities.
import './theme.css'
import './tailwind.css'

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

/**
 * The app shell. §"App shell".
 *
 * The classes here were the last live readers of `globals.css`'s `.app-shell`,
 * `.sidebar`, `.brand`, `.brand-mark`, `.brand-name` and `.app-main` rules, so
 * they are composed from Tailwind token utilities now. Two rules the legacy
 * stylesheet enforced by element specificity still need saying out loud, and are
 * the reason for `hover:no-underline` on the two anchors: tailwind.css puts the
 * `a:hover { text-decoration: underline }` default in `@layer base`, where a
 * utility can override it.
 *
 * The sidebar is a permanent 240px column until the `nav` breakpoint (900px,
 * registered in tailwind.css), where it becomes a horizontally scrollable strip
 * and the identity footer hides. That is the same collapse the `@media (max-width:
 * 900px)` block in the legacy stylesheet produced.
 */
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
          {/* Keyboard users reach the rail before the page. The link is off
              screen until focus lands on it, so it never disturbs the layout. */}
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
            {/* `tabIndex={-1}` is what makes the skip link actually move focus.
                A plain `#app-main` anchor only scrolls the region into view and
                leaves `document.activeElement` on `<body>`, so the next Tab would
                start over at the rail. With the target itself focusable, sequential
                focus navigation resumes inside the content instead. */}
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
