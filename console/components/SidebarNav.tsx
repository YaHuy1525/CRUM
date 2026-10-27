'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Home,
  ShieldCheck,
  BookOpen,
  CalendarDays,
  Database,
  Mail,
  MessageSquarePlus,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'


const PAGES: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/governance', label: 'Governance', icon: ShieldCheck },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { href: '/records', label: 'Records', icon: Database },
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/mail', label: 'Mailbox', icon: Mail },
]

const CHATS_INDEX = { href: '/chats', label: 'All conversations', icon: MessagesSquare }
const CHATS_NEW = { href: '/chats/new', label: 'New chat' }

const SECTION_LABEL =
  'm-0 px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-[var(--tracking-label)] text-text-muted max-nav:hidden'

const NAV_LINK =
  'focus-ring flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary hover:no-underline aria-[current=page]:bg-bg-active-pill aria-[current=page]:font-semibold aria-[current=page]:text-text-primary max-nav:whitespace-nowrap'

const navIcon = (active: boolean) => cn('shrink-0 opacity-75', active && 'text-accent opacity-100')

export type SidebarIdentity = {
  mode: string
  userId?: string
  tenantId?: string
}

function shortId(id?: string): string {
  if (!id) return '—'
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

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
