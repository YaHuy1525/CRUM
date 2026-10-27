import * as React from 'react'

import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-border-strong bg-bg-sunken px-3 py-1 text-base text-text-primary shadow-sm outline-none transition-[color,box-shadow] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-accent focus-visible:bg-bg-raised focus-visible:ring-2 focus-visible:ring-accent/40',
        'aria-invalid:border-danger aria-invalid:ring-danger/20',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
