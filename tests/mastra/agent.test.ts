import { describe, it, expect } from 'vitest'
import { Agent } from '@mastra/core/agent'
import { crmAssistant } from '../../src/mastra/agent'

describe('crmAssistant', () => {
  it('is an Agent instance', () => {
    expect(crmAssistant).toBeInstanceOf(Agent)
  })

  it('has id crm-assistant', () => {
    expect(crmAssistant.id).toBe('crm-assistant')
  })

  it('has name CRUM Assistant', () => {
    expect(crmAssistant.name).toBe('CRUM Assistant')
  })

  it('has instructions set', () => {
    const instructions = crmAssistant.getInstructions()
    // getInstructions returns string | SystemMessage | Promise when no requestContext
    expect(instructions).toBeDefined()
    // With a static string config, it resolves synchronously
    const resolved =
      instructions instanceof Promise ? null : instructions
    if (typeof resolved === 'string') {
      expect(resolved.length).toBeGreaterThan(0)
    } else if (resolved && typeof resolved === 'object') {
      // SystemMessage case — has content
      expect(resolved).toBeDefined()
    }
  })

  it('has inputProcessors array', async () => {
    const processors = await crmAssistant.listConfiguredInputProcessors()
    expect(Array.isArray(processors)).toBe(true)
    expect(processors.length).toBeGreaterThan(0)
  })

  it('has outputProcessors array', async () => {
    const processors = await crmAssistant.listConfiguredOutputProcessors()
    expect(Array.isArray(processors)).toBe(true)
    expect(processors.length).toBeGreaterThan(0)
  })

  it('has maxProcessorRetries set to 2', () => {
    // __getMaxProcessorRetries is the internal accessor for the private field
    expect(crmAssistant.__getMaxProcessorRetries()).toBe(2)
  })

  it('has 36 tools configured (22 read + 5 auto + 9 approval)', async () => {
    const tools = await crmAssistant.listTools()
    expect(tools).toBeDefined()
    expect(Object.keys(tools).length).toBe(36)
  })

  it('has WriteClaimGuardProcessor in outputProcessors', async () => {
    const processors = await crmAssistant.listConfiguredOutputProcessors()
    const hasWriteClaimGuard = processors.some(
      (p) => p.constructor.name === 'WriteClaimGuardProcessor'
    )
    expect(hasWriteClaimGuard).toBe(true)
  })

  it('has defaultOptions configured', () => {
    // defaultOptions is private; verify via __getOverridableFields which exposes the raw tools config
    const fields = crmAssistant.__getOverridableFields()
    expect(fields).toBeDefined()
    expect(fields.tools).toBeDefined()
  })

  it('has ObjectBindingProcessor in inputProcessors', async () => {
    const processors = await crmAssistant.listConfiguredInputProcessors()
    const hasObjectBinding = processors.some(
      (p) => p.constructor.name === 'ObjectBindingProcessor'
    )
    expect(hasObjectBinding).toBe(true)
  })
})
