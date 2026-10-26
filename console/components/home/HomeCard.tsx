'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'

import { describeError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The shell the three Home cards share. §"Page migrations": "Home composes three
 * named and testable card components."
 *
 * One shell rather than three hand-rolled sections, because the states are a
 * contract: every card must be able to say "still reading", "the read failed",
 * and "nothing here" in the same visual language. A card that quietly rendered
 * an empty list over an unreachable plane would be the failure mode the state
 * recipes exist to prevent.
 *
 * `<section aria-label>` gives each card a named region, so the tests locate
 * them by what they are rather than by class names.
 */

export function HomeCard({
  title,
  action,
  children,
  className,
}: {
  title: string
  /** A small link in the corner, e.g. "Open governance". */
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex flex-col rounded-lg border border-border bg-bg-card p-4 shadow-sm',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-text-muted">{title}</h2>
        {action}
      </div>
      <div className="mt-3 flex-1">{children}</div>
    </section>
  )
}

/** The corner link. Deliberately quiet: a card is a pointer, not a page. */
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="shrink-0 text-xs font-medium text-accent-bright underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
    </Link>
  )
}

export function CardPending({ label }: { label: string }) {
  return (
    <div className="space-y-2" data-testid="home-card-loading">
      <p className="sr-only" role="status">
        Loading {label}
      </p>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  )
}

/**
 * A failed read. The message is the plane's own sentence, never a generic one,
 * and the retry re-runs the same query so the card can recover without a reload.
 */
export function CardFailure({
  error,
  onRetry,
  label,
}: {
  error: unknown
  onRetry: () => void
  /** Names what failed for screen readers: "Retry loading the approval queue". */
  label: string
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      <p className="break-words">{describeError(error)}</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRetry}
        aria-label={label}
        className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger"
      >
        Retry
      </Button>
    </div>
  )
}

export function CardEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>
}
