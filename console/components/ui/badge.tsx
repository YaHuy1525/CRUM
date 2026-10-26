import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-xs font-medium transition-[color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg shadow-accent [a&]:hover:bg-accent/90',
        secondary: 'bg-bg-raised text-text-primary [a&]:hover:bg-bg-elevated',
        destructive: 'bg-danger text-white [a&]:hover:bg-danger/90',
        outline: 'border-border text-text-primary [a&]:hover:bg-bg-hover',
        success: 'bg-success-soft text-success [a&]:hover:bg-success-soft',
        warning: 'bg-warning-soft text-warning [a&]:hover:bg-warning-soft',
        danger: 'bg-danger-soft text-danger [a&]:hover:bg-danger-soft',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
