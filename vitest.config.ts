import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Vitest inline projects inherit the root `test.*` options but NOT the root
 * Vite options, so `resolve.alias` has to be repeated inside every project.
 * It is factored into one constant because two copies of a path are two
 * chances to edit only one of them.
 *
 * Without this the failure is unusually quiet: every `@/` import fails at
 * collection time while `tsc` stays green, because TypeScript resolves the
 * alias from tsconfig `paths` and never consults this file. The same boundary
 * applies to any other root Vite option a later task comes to rely on —
 * `define`, `resolve.extensions`, plugins — so repeat it per project too.
 */
const resolveAlias = {
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
}

export default defineConfig({
  resolve: resolveAlias,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    projects: [
      {
        resolve: resolveAlias,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**'],
        },
      },
      {
        resolve: resolveAlias,
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
