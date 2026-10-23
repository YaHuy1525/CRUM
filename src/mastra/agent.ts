import { Agent } from '@mastra/core/agent'
import type {
  InputProcessorOrWorkflow,
  OutputProcessorOrWorkflow,
} from '@mastra/core/processors'
import { CRUM_INSTRUCTIONS } from './instructions'
import { crumInputProcessors, crumOutputProcessors } from './processors'

// §4.3.1 — CRUM's main agent. Phase 1 wires the harness skeleton;
// Phase 2 adds tools, model fallback, and defaultOptions.
export const crmAssistant = new Agent({
  id: 'crm-assistant',
  name: 'CRUM Assistant',
  description:
    'Conversational CRM workbench agent. Reads the spine directly, stages every write for human approval.',

  instructions: CRUM_INSTRUCTIONS,

  // Phase 1: single model. Phase 2 adds fallback array per §4.3.1.
  model: 'anthropic/claude-sonnet-5-5',

  // Phase 1: no tools. Phase 2 adds crumToolRegistry.
  tools: {},

  // Step retries are DISABLED unless this is set. The abort-and-retry path
  // in WriteClaimGuardProcessor (Phase 3) depends on it. §4.3.
  maxProcessorRetries: 2,

  // Processors are typed as Processor[] in processors.ts; the Agent constructor
  // expects the narrower InputProcessorOrWorkflow / OutputProcessorOrWorkflow
  // unions. The runtime dispatch is correct (the processor runner checks method
  // presence), so we assert at the boundary.
  inputProcessors: crumInputProcessors as InputProcessorOrWorkflow[],
  outputProcessors: crumOutputProcessors as OutputProcessorOrWorkflow[],

  // Phase 1: no memory. Phase 2 wires coreMemory via Mastra instance.
  // memory: buildCrumMemory(storage),
})
