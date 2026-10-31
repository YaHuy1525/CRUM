import { describe, expect, it } from 'vitest'
import type { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'

import { offerStrategistAgent, offerStrategistSubagent } from '../../src/mastra/agents/offer-strategist'
import { marketerCopywriterAgent, marketerCopywriterSubagent } from '../../src/mastra/agents/marketer-copywriter'
import { creativeDesignerAgent, creativeDesignerSubagent } from '../../src/mastra/agents/creative-designer'
import { mediaBuyerAgent, mediaBuyerSubagent } from '../../src/mastra/agents/media-buyer'
import { funnelBuilderAgent, funnelBuilderSubagent } from '../../src/mastra/agents/funnel-builder'
import { campaignAnalystAgent, campaignAnalystSubagent } from '../../src/mastra/agents/campaign-analyst'
import { LEAD_ENDPOINT_PLACEHOLDER } from '../../src/marketing/lead-token'

const PAIRS: { role: string; agent: Agent; subagent: AgentControllerSubagent }[] = [
  { role: 'offer-strategist', agent: offerStrategistAgent, subagent: offerStrategistSubagent },
  { role: 'marketer-copywriter', agent: marketerCopywriterAgent, subagent: marketerCopywriterSubagent },
  { role: 'creative-designer', agent: creativeDesignerAgent, subagent: creativeDesignerSubagent },
  { role: 'media-buyer', agent: mediaBuyerAgent, subagent: mediaBuyerSubagent },
  { role: 'funnel-builder', agent: funnelBuilderAgent, subagent: funnelBuilderSubagent },
  { role: 'campaign-analyst', agent: campaignAnalystAgent, subagent: campaignAnalystSubagent },
]

const REQUIRED_PHRASE: Record<string, string> = {
  'offer-strategist': 'Never invent a number',
  'marketer-copywriter': 'Never promise an outcome',
  'creative-designer': 'Never describe stock',
  'media-buyer': 'paused',
  'funnel-builder': 'state what happens to the data',
  'campaign-analyst': 'Never estimate a metric',
}

describe.each(PAIRS)('$role', ({ role, agent, subagent }) => {
  it('shares one instruction string between the Agent and its subagent declaration', async () => {
    // The duplication the repo already carries for email-drafter is the drift
    // this exists to prevent: one string, two consumers.
    expect(await agent.getInstructions()).toBe(subagent.instructions)
  })

  it('carries the same id and name into both declarations', () => {
    expect(subagent.id).toBe(agent.id)
    expect(subagent.name).toBe(agent.name)
    expect(subagent.id).toBe(role)
  })

  it('is declared with no tools and no borrowed controller tools', () => {
    // A subagent that can write is a subagent that bypasses the gate.
    expect(subagent.tools).toEqual({})
    expect(subagent.allowedControllerTools).toBeUndefined()
  })

  it('states its load-bearing prohibition', () => {
    const phrase = REQUIRED_PHRASE[role]
    expect(phrase, `${role} is not a known marketing role`).toBeTruthy()
    expect(subagent.instructions).toContain(phrase)
  })
})

describe('the funnel builder and the lead endpoint', () => {
  it('is told the one action its form may carry, spelled exactly as the stamper looks for it', () => {
    // The save tool refuses an inbound bundle whose page holds zero or two of
    // these, so a prompt that never names the placeholder, or names a near miss,
    // makes every inbound save refuse. Pinning the exported constant rather than
    // the words means a typo on either side fails here.
    const funnel = PAIRS.find(({ role }) => role === 'funnel-builder')
    expect(funnel?.subagent.instructions).toContain(LEAD_ENDPOINT_PLACEHOLDER)
    expect(funnel?.agent.getInstructions()).toBe(funnel?.subagent.instructions)
  })
})

describe('the marketing team shape', () => {
  it('has exactly six roles with the spec ids', () => {
    expect(PAIRS.map(({ agent }) => agent.id).sort()).toEqual([
      'campaign-analyst',
      'creative-designer',
      'funnel-builder',
      'marketer-copywriter',
      'media-buyer',
      'offer-strategist',
    ])
  })

  it('gives the designer room to prompt, generate and check, and the writers one pass each', () => {
    expect(creativeDesignerSubagent.maxSteps).toBe(4)
    for (const { subagent } of PAIRS.filter(({ role }) => role !== 'creative-designer')) {
      expect(subagent.maxSteps, subagent.id).toBe(2)
    }
  })

  it('runs the two judgement roles on the main model and the four production roles on the light one', () => {
    expect(offerStrategistSubagent.defaultModelId).toBe(marketerCopywriterSubagent.defaultModelId)
    for (const id of ['creative-designer', 'media-buyer', 'funnel-builder', 'campaign-analyst']) {
      const sub = PAIRS.map(({ subagent }) => subagent).find((s) => s.id === id)
      expect(sub?.defaultModelId).not.toBe(offerStrategistSubagent.defaultModelId)
    }
  })
})
