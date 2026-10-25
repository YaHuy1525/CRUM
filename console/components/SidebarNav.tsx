'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Home,
  ShieldCheck,
  BookOpen,
  Database,
  MessageSquarePlus,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * The grouped sidebar. §"Approved decisions" 1, §"App shell".
 *
 * Two groups, and only navigation lives here — conversation *history* belongs to
 * the Chats section (`/chats`), not the rail. Icons come from `lucide-react`
 * rather than the duplicated inline SVG the old `NavLinks` carried.
 *
 * The link and group-label class names (`.nav-link`, `.nav-icon`,
 * `.nav-section-label`, `.user-chip`) are the same ones `globals.css` already
 * styles, so the sidebar keeps the Cedar-aligned graphite look while the page
 * bodies migrate onto primitives in later phases. The one deliberately
 * different element is the "New chat" call to action, styled with Tailwind
 * utilities so it reads as the primary entry into the Chats section.
 *
 * `/today` and `/usage` stay live routes but are intentionally absent here: the
 * spec keeps Usage out of the sidebar (entered from Home launchers and by URL)
 * and folds Today's digest into Home in a later phase.
 */

/** The Pages group. Exact-path active matching keeps `aria-current` predictable. */
const PAGES: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/governance', label: 'Governance', icon: ShieldCheck },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { href: '/records', label: 'Records', icon: Database },
]

/** The Chats group. `/chats/new` is the prominent action, `/chats` the index. */
const CHATS_INDEX = { href: '/chats', label: 'All conversations', icon: MessagesSquare }
const CHATS_NEW = { href: '/chats/new', label: 'New chat' }

export type SidebarIdentity = {
  /** Value of `CRUM_AUTH_MODE` as read on the server. */
  mode: string
  /** `CRUM_DEV_USER_ID` when present. Never a fabricated name. */
  userId?: string
  /** `CRUM_DEV_TENANT_ID` when present. */
  tenantId?: string
}

function shortId(id?: string): string {
  if (!id) return '—'
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/**
 * Sidebar footer identity. Reads only what the server injected: in `dev` mode it
 * shows the real `CRUM_DEV_*` ids (truncated), and in any other mode it shows a
 * generic "Signed-in workspace" — never a hard-coded fake name.
 */
function IdentityFooter({ identity }: { identity: SidebarIdentity }) {
  const isDev = identity.mode !== 'jwt'
  const hasDevIds = Boolean(identity.userId && identity.tenantId)
  const showDev = isDev && hasDevIds

  const name = showDev ? 'Dev identity' : 'Signed-in workspace'
  const detail = showDev
    ? `user ${shortId(identity.userId)} · tenant ${shortId(identity.tenantId)}`
    : identity.mode

  return (
    <div
      className="user-chip"
      title={showDev ? `CRUM_AUTH_MODE=${identity.mode}` : 'Workspace identity from the active session'}
      data-testid="sidebar-identity"
    >
      <span className="user-avatar" aria-hidden="true">
        {showDev ? (identity.userId ?? 'd').slice(0, 1).toUpperCase() : '•'}
      </span>
      <span>
        <span className="user-name">{name}</span>
        <span className="user-workspace">
          <span className="env-dot" aria-hidden="true" />
          <span className="font-mono">{detail}</span>
        </span>
      </span>
    </div>
  )
}

export function SidebarNav({ identity }: { identity: SidebarIdentity }) {
  const pathname = usePathname()
  const isActive = (href: string) => pathname === href

  return (
    <>
      <p className="nav-section-label">Pages</p>
      {PAGES.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="nav-link focus-ring"
          aria-current={isActive(href) ? 'page' : undefined}
        >
          <Icon className="nav-icon" size={16} aria-hidden="true" />
          {label}
        </Link>
      ))}

      <p className="nav-section-label">Chats</p>
      <Link
        href={CHATS_NEW.href}
        aria-current={isActive(CHATS_NEW.href) ? 'page' : undefined}
        className={cn(
          'focus-ring flex items-center gap-3 rounded-md border border-accent-line bg-accent-soft px-3 py-2 text-sm font-semibold text-accent-bright transition-colors',
          'hover:bg-accent hover:text-accent-fg',
        )}
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
        {CHATS_NEW.label}
      </Link>
      <Link
        href={CHATS_INDEX.href}
        className="nav-link focus-ring"
        aria-current={isActive(CHATS_INDEX.href) ? 'page' : undefined}
      >
        <CHATS_INDEX.icon className="nav-icon" size={16} aria-hidden="true" />
        {CHATS_INDEX.label}
      </Link>

      <span className="nav-spacer" aria-hidden="true" />

      <IdentityFooter identity={identity} />
    </>
  )
}
