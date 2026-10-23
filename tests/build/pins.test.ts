import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageJson {
  name: string
  version: string
  type: string
  engines: { node: string }
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson

// Appendix B of TECHNICAL_PLAN.md. Exact, because a caret range on @mastra/core
// resolves below 1.78.0 and beforeApproval disappears.
const EXPECTED_DEPENDENCIES: Record<string, string> = {
  '@mastra/core': '1.79.0',
  '@mastra/mcp': '2.5.0',
  '@mastra/memory': '1.39.0',
  '@mastra/pg': '1.32.0',
  '@mastra/rag': '2.7.0',
  '@mastra/evals': '1.10.8',
  '@mastra/observability': '1.21.0',
  '@mastra/ai-sdk': '1.11.2',
  '@ai-sdk/typesafe-ai': '3.0.24',
  zod: '4.6.7',
  yaml: '2.9.1',
  pg: '8.23.1',
}

const EXPECTED_DEV_DEPENDENCIES: Record<string, string> = {
  typescript: '5.9.3',
  vitest: '3.2.7',
  '@vitest/coverage-v8': '3.2.7',
  tsx: '4.23.15',
  eslint: '9.39.5',
  'typescript-eslint': '8.72.0',
  '@types/node': '22.20.5',
  '@types/pg': '8.23.1',
}

describe('package.json pins', () => {
  it.each(Object.entries(EXPECTED_DEPENDENCIES))(
    'pins %s exactly',
    (name, version) => {
      expect(pkg.dependencies[name]).toBe(version)
    },
  )

  it.each(Object.entries(EXPECTED_DEV_DEPENDENCIES))(
    'dev-pins %s exactly',
    (name, version) => {
      expect(pkg.devDependencies[name]).toBe(version)
    },
  )

  it('rejects every range operator in the dependency set', () => {
    const ranged = [...Object.entries(pkg.dependencies), ...Object.entries(pkg.devDependencies)]
      .filter(([, v]) => /[\^~><*]/.test(String(v)))
      .map(([k, v]) => `${k}@${v}`)
    expect(ranged).toEqual([])
  })

  it('asserts the Node 22.18.0 floor', () => {
    expect(pkg.engines.node).toBe('>=22.18.0')
  })

  it('is an ES module', () => {
    expect(pkg.type).toBe('module')
  })
})
