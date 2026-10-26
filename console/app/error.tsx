'use client'

import { useEffect } from 'react'

import { Button } from '@/components/ui/button'

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 md:px-8 md:py-16">
      <div
        className="rounded-lg border border-danger-line bg-danger-soft p-8"
        role="alert"
        data-testid="route-error"
      >
        <h1 className="font-display text-2xl font-normal tracking-tight text-text-primary">
          This page hit a problem.
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Something went wrong while rendering this view. You can try it again — this re-runs just
          this page — or head back home. No changes were made on your behalf.
        </p>

        {error?.message ? (
          <pre className="mt-4 max-h-40 overflow-auto rounded-md border border-border bg-bg-sunken p-3 font-mono text-xs text-text-muted">
            {error.message}
          </pre>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" asChild>
            <a href="/">Back to home</a>
          </Button>
        </div>
      </div>
    </main>
  )
}
