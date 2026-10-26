'use client'

import Link from 'next/link'
import { BarChart3, BookOpen, ClipboardType, MessageSquarePlus, type LucideIcon } from 'lucide-react'

/**
 * The quick launcher row. §"Route map": "A quick launcher row offers New chat,
 * Capture from text, Knowledge, and Usage."
 *
 * A four item nav rather than buttons, because every one of them is a route: no
 * launcher mints state, opens a dialog, or does work on the way. Usage is here
 * on purpose — it is not in the sidebar, so Home is the only way in besides the
 * URL (`§"Route map"`, `/usage`).
 */

const LAUNCHERS: { href: string; label: string; detail: string; icon: LucideIcon }[] = [
  {
    href: '/chats/new',
    label: 'New chat',
    detail: 'Talk to the assistant',
    icon: MessageSquarePlus,
  },
  {
    href: '/records/new',
    label: 'Capture from text',
    detail: 'Paste a note, parse it',
    icon: ClipboardType,
  },
  {
    href: '/knowledge',
    label: 'Knowledge',
    detail: 'Upload and re-ingest docs',
    icon: BookOpen,
  },
  { href: '/usage', label: 'Usage', detail: 'Tokens, cost, tools', icon: BarChart3 },
]

export function QuickLauncher() {
  return (
    <nav aria-label="Quick actions" className="mt-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LAUNCHERS.map(({ href, label, detail, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="focus-ring flex items-start gap-3 rounded-lg border border-border bg-bg-card p-3 transition-colors hover:bg-bg-hover"
          >
            <Icon size={16} aria-hidden="true" className="mt-0.5 text-accent-bright" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-primary">{label}</span>
              <span className="mt-0.5 block text-xs text-text-muted">{detail}</span>
            </span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
