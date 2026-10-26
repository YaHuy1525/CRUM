'use client'

import { useEffect } from 'react'

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
            outline: 2px solid #047857;
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
          background: '#f6f7f9',
          color: '#11161f',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          padding: 24,
        }}
      >
        <main
          style={{
            maxWidth: 560,
            width: '100%',
            border: '1px solid rgba(180, 35, 47, 0.30)',
            background: 'rgba(180, 35, 47, 0.06)',
            borderRadius: 16,
            padding: 32,
          }}
          data-testid="global-error"
        >
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 500 }}>
            The console hit an unexpected problem.
          </h1>
          <p style={{ marginTop: 8, fontSize: 14, color: '#3f4a5a' }}>
            Something broke while rendering the app shell. Try again, or reload the page if it keeps
            happening. No changes were made on your behalf.
          </p>

          {error?.message ? (
            <pre
              style={{
                marginTop: 16,
                maxHeight: 160,
                overflow: 'auto',
                border: '1px solid #dce1e8',
                background: '#eceef2',
                borderRadius: 8,
                padding: 12,
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                fontSize: 12,
                color: '#3f4a5a',
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
                background: '#047857',
                color: '#ffffff',
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
                color: '#11161f',
                border: '1px solid #cdd5df',
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
