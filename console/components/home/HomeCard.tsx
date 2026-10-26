'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'

import { describeError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'


export function HomeCard({
  title,
  action,
  children,
  className,
}: {
  title: string
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

export function CardFailure({
  error,
  onRetry,
  label,
}: {
  error: unknown
  onRetry: () => void
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
