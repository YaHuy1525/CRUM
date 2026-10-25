'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Every route the console actually serves. `/approvals`, `/knowledge` and `/new`
 * are new here because the components behind them used to exist with no page
 * importing them — a governance surface you cannot reach is not a feature, and the
 * phase's exit criterion is explicitly "approvals and knowledge routes reachable
 * from the nav". §11.2.
 */
const links = [
  { href: '/', label: 'Home' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/new', label: 'New' },
  { href: '/usage', label: 'Usage' },
  { href: '/today', label: 'Today' },
]

export function NavLinks() {
  const pathname = usePathname()
  return (
    <>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="focus-ring"
          aria-current={pathname === link.href ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
    </>
  )
}
