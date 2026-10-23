import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * A Vitest inline project inherits nothing from this file unless it sets
 * `extends: true`, and `extends` defaults to false in Vitest 3. Vitest
 * resolves such a project's `configFile` to `false`, so the root config is
 * never loaded for it: the project receives only its own inline options, the
 * CLI overrides and Vitest's built-in defaults. That covers root Vite options
 * — `resolve.alias`, `define`, `resolve.extensions`, plugins — and root
 * `test.*` options alike. Every option a project needs must therefore be
 * repeated inside it. A later task that adds root `setupFiles`, `env`,
 * `globals` or `testTimeout` must copy it into both projects below, or it
 * silently does nothing while the suite still reports green.
 *
 * The failure this prevents is unusually quiet: every `@/` import fails at
 * collection time while `tsc` stays green, because TypeScript resolves the
 * alias from tsconfig `paths` and never consults this file.
 */
const sharedResolve = {
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
}

export default defineConfig({
  resolve: sharedResolve,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: { lines: 70, functions: 70, branches: 65, statements: 70 },
    },
  },
})
