import { describe, it, expect } from 'vitest'
import { createCrumMcpServer } from '../../src/mastra/mcp-server'
import { resolveMcpRequestState } from '../../src/mastra/mcp-guard'
import { parseEnv } from '../../src/config/env'

describe('createCrumMcpServer', () => {
  const env = parseEnv({
    NODE_ENV: 'test',
    MCP_REQUEST_STATE_KEY: 'a'.repeat(32),
  })

  it('creates a server with the correct id', () => {
    const decision = resolveMcpRequestState(env)
    const server = createCrumMcpServer(decision.key)
    expect(server.id).toBe('crum-crm')
  })

  it('exposes read tools', () => {
    const decision = resolveMcpRequestState(env)
    const server = createCrumMcpServer(decision.key)
    const tools = server.tools()
    expect(tools).toHaveProperty('crm.list_customers')
    expect(tools).toHaveProperty('crm.get_customer')
    expect(tools).toHaveProperty('crm.find_contacts')
    expect(tools).toHaveProperty('crm.my_open_items')
    expect(tools).toHaveProperty('knowledge.retrieve')
  })

  it('does not expose approval-class write tools', () => {
    const decision = resolveMcpRequestState(env)
    const server = createCrumMcpServer(decision.key)
    const tools = server.tools()
    expect(tools).not.toHaveProperty('crm.create_customer')
    expect(tools).not.toHaveProperty('crm.create_contact')
    expect(tools).not.toHaveProperty('crm.create_schedule')
    expect(tools).not.toHaveProperty('crm.transfer_owner')
    expect(tools).not.toHaveProperty('mail.send')
  })
})
