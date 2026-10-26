'use client'

import { useEffect } from 'react'

/**
 * Last-resort error surface. Next renders this instead of the root layout when an
 * unhandled error breaks the shell itself, so it must bring its own `<html>` and
 * `<body>` — and its own styling, because the `theme.css` / `tailwind.css`
 * imports live in the layout this file replaces and are therefore not loaded.
 *
 * The colours below are inline literals matching the CRUM graphite-and-emerald
 * tokens; they are a fallback for exactly this broken-shell case, not a second
 * source of truth. The one style block here exists for the same reason: the
 * console's `.focus-ring` utility lives in `theme.css`, which is not loaded on
 * this surface, so the keyboard focus outline the rest of the app gets from that
 * utility has to be restated inline. Honest copy, a retry, and a hard reload as
 * the escape hatch.
 */
export default function GlobalError({
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
    <html lang="en">
      <head>
        <style>{`
          button:focus-visible,
          a:focus-visible {
            outline: 2px solid #34d399;
            outline-offset: 2px;
          }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0e14',
          color: '#e6e9ef',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          padding: 24,
        }}
      >
        <main
          style={{
            maxWidth: 560,
            width: '100%',
            border: '1px solid rgba(248, 113, 113, 0.35)',
            background: 'rgba(248, 113, 113, 0.08)',
            borderRadius: 16,
            padding: 32,
          }}
          data-testid="global-error"
        >
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 500 }}>
            The console hit an unexpected problem.
          </h1>
          <p style={{ marginTop: 8, fontSize: 14, color: '#a7b0c0' }}>
            Something broke while rendering the app shell. Try again, or reload the page if it keeps
            happening. No changes were made on your behalf.
          </p>

          {error?.message ? (
            <pre
              style={{
                marginTop: 16,
                maxHeight: 160,
                overflow: 'auto',
                border: '1px solid #232b3a',
                background: '#070910',
                borderRadius: 8,
                padding: 12,
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                fontSize: 12,
                color: '#8b95a7',
              }}
            >
              {error.message}
            </pre>
          ) : null}

          <div style={{ marginTop: 24, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                background: '#10b981',
                color: '#04120c',
                border: 'none',
                borderRadius: 10,
                padding: '9px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: 'transparent',
                color: '#e6e9ef',
                border: '1px solid #232b3a',
                borderRadius: 10,
                padding: '9px 16px',
                fontSize: 14,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Reload the page
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
