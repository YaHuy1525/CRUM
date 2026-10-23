import { Agent } from '@mastra/core/agent'
import type {
  InputProcessorOrWorkflow,
  OutputProcessorOrWorkflow,
} from '@mastra/core/processors'
import { CRUM_INSTRUCTIONS } from './instructions'
import { crumInputProcessors, crumOutputProcessors } from './processors'
import { listCustomersTool, getCustomerTool } from './tools/customers'
import { findContactsTool } from './tools/contacts'
import { listFollowupsTool } from './tools/followups'
import { listTasksTool, myOpenItemsTool } from './tools/tasks'
import { listSchedulesTool } from './tools/schedules'
import { searchTool } from './tools/search'
import { knowledgeRetrieveTool } from './tools/knowledge'
import { resolveActiveTools } from './active-tools'
import type { TenantRequestContext } from './tenant-context'

const crumToolRegistry = {
  'crm.list_customers': listCustomersTool,
  'crm.get_customer': getCustomerTool,
  'crm.find_contacts': findContactsTool,
  'crm.list_followups': listFollowupsTool,
  'crm.list_tasks': listTasksTool,
  'crm.list_schedules': listSchedulesTool,
  'crm.my_open_items': myOpenItemsTool,
  'crm.search': searchTool,
  'knowledge.retrieve': knowledgeRetrieveTool,
}

// §4.3.1 — CRUM's main agent. Phase 2 wires tools, defaultOptions, and activeTools resolution.
export const crmAssistant = new Agent({
  id: 'crm-assistant',
  name: 'CRUM Assistant',
  description:
    'Conversational CRM workbench agent. Reads the spine directly, stages every write for human approval.',

  instructions: CRUM_INSTRUCTIONS,

  // Phase 1: single model. Phase 2 adds fallback array per §4.3.1.
  model: 'anthropic/claude-sonnet-5-5',

  tools: crumToolRegistry,

  // Step retries are DISABLED unless this is set. The abort-and-retry path
  // in WriteClaimGuardProcessor (Phase 3) depends on it. §4.3.
  maxProcessorRetries: 2,

  // Processors are typed as Processor[] in processors.ts; the Agent constructor
  // expects the narrower InputProcessorOrWorkflow / OutputProcessorOrWorkflow
  // unions. The runtime dispatch is correct (the processor runner checks method
  // presence), so we assert at the boundary.
  inputProcessors: crumInputProcessors as InputProcessorOrWorkflow[],
  outputProcessors: crumOutputProcessors as OutputProcessorOrWorkflow[],

  defaultOptions: ({ requestContext }) => {
    const tenantContext = requestContext?.get('tenantContext') as TenantRequestContext | undefined
    if (!tenantContext) {
      return { activeTools: [] }
    }
    return {
      activeTools: resolveActiveTools(tenantContext),
    }
  },

  // Phase 1: no memory. Phase 2 wires coreMemory via Mastra instance.
  // memory: buildCrumMemory(storage),
})
