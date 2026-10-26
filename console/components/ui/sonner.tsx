'use client'

import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group toast flex w-full items-center gap-3 rounded-md border border-border bg-bg-elevated p-4 text-sm text-text-primary shadow-lg',
          title: 'font-semibold text-text-primary',
          description: 'text-text-muted',
          actionButton: 'rounded-md bg-accent px-3 py-1 font-medium text-accent-fg',
          cancelButton: 'rounded-md bg-bg-raised px-3 py-1 text-text-secondary',
          success: 'text-success',
          error: 'text-danger',
          warning: 'text-warning',
          info: 'text-info',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--bg-elevated)',
          '--normal-text': 'var(--text-primary)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
