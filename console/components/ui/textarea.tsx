import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * shadcn/ui `textarea`, adapted to CRUM tokens. Same sunken-well recipe as
 * `input`, with vertical resize like `.console-form textarea`.
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full rounded-md border border-border-strong bg-bg-sunken px-3 py-2 text-base text-text-primary shadow-sm outline-none transition-[color,box-shadow] placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-accent focus-visible:bg-bg-raised focus-visible:ring-2 focus-visible:ring-accent/40',
        'aria-invalid:border-danger aria-invalid:ring-danger/20',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
