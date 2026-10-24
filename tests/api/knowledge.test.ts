// tests/api/knowledge.test.ts
import { describe, it, expect } from 'vitest'
import { createKnowledgeRouter } from '../../src/api/knowledge'

describe('knowledge routes', () => {
  it('creates a router', () => {
    const router = createKnowledgeRouter()
    expect(router).toBeDefined()
  })
})
