// tests/console/knowledge-manager.test.ts
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'

describe('KnowledgeManager', () => {
  it('module file exists', () => {
    // React is not available in the root test environment (it lives in the
    // console sub-app), so we verify the component file exists rather than
    // importing it. Visual/integration tests come later.
    const componentPath = resolve(__dirname, '../../src/console/components/KnowledgeManager.tsx')
    expect(existsSync(componentPath)).toBe(true)
  })
})
