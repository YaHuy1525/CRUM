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
 * The rail was one of the last three surfaces still reading class names out of
 * `globals.css` (`.nav-link`, `.nav-icon`, `.nav-section-label`, `.nav-spacer`,
 * `.user-chip` and friends). Those rules are now Tailwind utilities composed
 * from the same tokens, so the stylesheet could be deleted. Two consequences of
 * that swap are visible in the code below and neither is a style choice:
 *
 * 1. The active state was a CSS attribute selector (`[aria-current='page']
 *    .nav-icon`). A child element cannot select its parent's attribute in
 *    Tailwind, so the icon tone is computed from `isActive` in JSX instead.
 *    `aria-current` is still what carries the state for assistive tech.
 * 2. Below the `nav` breakpoint the shell lies down into a horizontal strip, and
 *    the group labels, the spacer and the identity chip hide, exactly as the
 *    legacy `@media (max-width: 900px)` block did.
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

/**
 * The group label recipe (Cedar's "Pages" / "Chats" mini headers: small caps,
 * generous tracking) and the plain rail link recipe. Both were `.nav-section-label`
 * and `.nav-link` in the legacy stylesheet; they are constants here because six
 * elements share them and a typo in one of them is an invisible style regression.
 */
const SECTION_LABEL =
  'm-0 px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-[var(--tracking-label)] text-text-muted max-nav:hidden'

const NAV_LINK =
  'focus-ring flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary hover:no-underline aria-[current=page]:bg-bg-active-pill aria-[current=page]:font-semibold aria-[current=page]:text-text-primary max-nav:whitespace-nowrap'

/** The icon tone. The active variant used to be a descendant CSS selector. */
const navIcon = (active: boolean) => cn('shrink-0 opacity-75', active && 'text-accent opacity-100')

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
      className="flex items-center gap-2 rounded-md border border-border bg-bg-card p-2 max-nav:hidden"
      title={showDev ? `CRUM_AUTH_MODE=${identity.mode}` : 'Workspace identity from the active session'}
      data-testid="sidebar-identity"
    >
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-pill bg-accent-soft text-xs font-semibold text-accent-bright"
      >
        {showDev ? (identity.userId ?? 'd').slice(0, 1).toUpperCase() : '•'}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-[1.3] text-text-primary">{name}</span>
        <span className="flex items-center gap-[5px] text-xs leading-[1.3] text-text-muted">
          <span aria-hidden="true" className="size-[7px] shrink-0 rounded-pill bg-accent-bright" />
          <span className="truncate font-mono">{detail}</span>
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
      <p className={SECTION_LABEL}>Pages</p>
      {PAGES.map(({ href, label, icon: Icon }) => {
        const active = isActive(href)
        return (
          <Link
            key={href}
            href={href}
            className={NAV_LINK}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className={navIcon(active)} size={16} aria-hidden="true" />
            {label}
          </Link>
        )
      })}

      <p className={SECTION_LABEL}>Chats</p>
      <Link
        href={CHATS_NEW.href}
        aria-current={isActive(CHATS_NEW.href) ? 'page' : undefined}
        className={cn(
          'focus-ring flex items-center gap-3 rounded-md border border-accent-line bg-accent-soft px-3 py-2 text-sm font-semibold text-accent-bright transition-colors hover:bg-accent hover:text-accent-fg hover:no-underline max-nav:whitespace-nowrap',
        )}
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
        {CHATS_NEW.label}
      </Link>
      <Link
        href={CHATS_INDEX.href}
        className={NAV_LINK}
        aria-current={isActive(CHATS_INDEX.href) ? 'page' : undefined}
      >
        <CHATS_INDEX.icon className={navIcon(isActive(CHATS_INDEX.href))} size={16} aria-hidden="true" />
        {CHATS_INDEX.label}
      </Link>

      <span className="min-h-4 flex-1 max-nav:hidden" aria-hidden="true" />

      <IdentityFooter identity={identity} />
    </>
  )
}
