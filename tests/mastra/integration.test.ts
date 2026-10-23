import { describe, it, expect } from 'vitest'
import { createCrumMastra } from '../../src/mastra'
import { parseEnv } from '../../src/config/env'

describe('createCrumMastra with agent and memory', () => {
  it('registers crmAssistant in the agents map', () => {
    const env = parseEnv()
    const mastra = createCrumMastra(env)

    const agents = mastra.listAgents()
    expect(agents).toHaveProperty('crm-assistant')
  })

  it('crmAssistant is an Agent instance', () => {
    const env = parseEnv()
    const mastra = createCrumMastra(env)

    const agent = mastra.getAgent('crm-assistant')
    expect(agent).toBeDefined()
    expect(agent.id).toBe('crm-assistant')
  })
})
