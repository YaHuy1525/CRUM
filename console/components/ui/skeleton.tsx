import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * shadcn/ui `skeleton`, adapted to CRUM tokens. A raised graphite block that
 * pulses — the "reading" state the legacy `.skeleton-bar` already signals.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-bg-raised', className)}
      {...props}
    />
  )
}

export { Skeleton }
