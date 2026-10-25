import Link from 'next/link'

/**
 * 404 surface. §"Route map": routes moved during the IA redesign all keep
 * redirects, so landing here means the path genuinely does not exist rather than
 * that a bookmark broke. Honest copy, a way home, and the real section links —
 * no fabricated content.
 */
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-2xl px-8 py-16" data-testid="not-found">
      <p className="font-mono text-sm text-accent-bright">404</p>
      <h1 className="mt-2 font-display text-3xl font-normal tracking-tight text-text-primary">
        We could not find that page.
      </h1>
      <p className="mt-2 max-w-prose text-sm text-text-secondary">
        The address you followed does not match a console route. Try one of these instead:
      </p>

      <nav className="mt-6 flex flex-wrap gap-2" aria-label="Console sections">
        <Link
          href="/"
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg shadow-accent transition-colors hover:bg-accent/90"
        >
          Home
        </Link>
        <Link
          href="/governance"
          className="focus-ring inline-flex items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
        >
          Governance
        </Link>
        <Link
          href="/knowledge"
          className="focus-ring inline-flex items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
        >
          Knowledge
        </Link>
        <Link
          href="/records"
          className="focus-ring inline-flex items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
        >
          Records
        </Link>
      </nav>
    </main>
  )
}
