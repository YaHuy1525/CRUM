'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Every route the console actually serves. `/approvals`, `/knowledge` and `/new`
 * are new here because the components behind them used to exist with no page
 * importing them — a governance surface you cannot reach is not a feature, and the
 * phase's exit criterion is explicitly "approvals and knowledge routes reachable
 * from the nav". §11.2.
 *
 * Rendered as a Cedar-style sidebar list: line icon, label, warm pill when the
 * pathname matches. The icons are inline SVG so the console pulls no icon package.
 */
const links = [
  {
    href: '/',
    label: 'Home',
    icon: (
      <>
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5.5 9.5V20h13V9.5" />
      </>
    ),
  },
  {
    href: '/today',
    label: 'Today',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
      </>
    ),
  },
  {
    href: '/approvals',
    label: 'Approvals',
    icon: (
      <>
        <path d="M12 3l7 2.8V11c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V5.8z" />
        <path d="M9 11.5l2.2 2.2L15.5 9" />
      </>
    ),
  },
  {
    href: '/new',
    label: 'New',
    icon: (
      <>
        <path d="M12 4.5l1.8 4.7L18.5 11l-4.7 1.8L12 17.5l-1.8-4.7L5.5 11l4.7-1.8z" />
        <path d="M18.5 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
      </>
    ),
  },
  {
    href: '/knowledge',
    label: 'Knowledge',
    icon: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5z" />
        <path d="M4 16.5A2.5 2.5 0 0 1 6.5 14H20" />
      </>
    ),
  },
  {
    href: '/usage',
    label: 'Usage',
    icon: (
      <>
        <path d="M4 20V9" />
        <path d="M10 20V4" />
        <path d="M16 20v-8" />
        <path d="M22 20H2" />
      </>
    ),
  },
]

export function NavLinks() {
  const pathname = usePathname()
  return (
    <>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="nav-link focus-ring"
          aria-current={pathname === link.href ? 'page' : undefined}
        >
          <svg
            className="nav-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {link.icon}
          </svg>
          {link.label}
        </Link>
      ))}
    </>
  )
}
