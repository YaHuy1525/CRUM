import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Every page's header row: a serif title, an optional muted subline, and an
 * `actions` slot for contextual controls. §"App shell" ("Each page renders its
 * own header row with title and contextual actions inside a consistent max width
 * content column").
 *
 * A server-safe presentational component (no hooks), so a page can render it
 * from either a server or client component. Styled with the Tailwind token
 * utilities rather than the legacy `.console-page h1` rules so it does not
 * depend on the stylesheet that Phase 5 deletes.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-normal tracking-tight text-text-primary">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  )
}
