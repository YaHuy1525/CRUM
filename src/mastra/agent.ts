import { Agent } from '@mastra/core/agent'
import type { AgentControllerSubagent } from '@mastra/core/agent-controller'
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
import { searchThreadsTool } from './tools/gmail'
import { logFollowupTool, createTaskTool, draftMailTool } from './tools/auto-writes'
import { createCustomerTool, updateCustomerTool, deleteCustomerTool } from './tools/customer-writes'
import { createContactTool, createScheduleTool, transferOwnerTool, sendMailTool } from './tools/approval-writes'
import { approvalFlow } from './workflows/approval-flow'
import { resolveActiveTools, providerToolName } from './active-tools'
import { CRUM_MAIN_MODEL, CRUM_LIGHT_MODEL } from './models'
import type { TenantRequestContext } from './tenant-context'

const crumToolRegistry = {
  // read-only (10)
  'crm.list_customers': listCustomersTool,
  'crm.get_customer': getCustomerTool,
  'crm.find_contacts': findContactsTool,
  'crm.list_followups': listFollowupsTool,
  'crm.list_tasks': listTasksTool,
  'crm.list_schedules': listSchedulesTool,
  'crm.my_open_items': myOpenItemsTool,
  'crm.search': searchTool,
  'knowledge.retrieve': knowledgeRetrieveTool,
  'mail.search_threads': searchThreadsTool,
  // auto (3)
  'crm.log_followup': logFollowupTool,
  'crm.create_task': createTaskTool,
  'mail.draft': draftMailTool,
  // approval (7)
  'crm.create_customer': createCustomerTool,
  'crm.update_customer': updateCustomerTool,
  'crm.delete_customer': deleteCustomerTool,
  'crm.create_contact': createContactTool,
  'crm.create_schedule': createScheduleTool,
  'crm.transfer_owner': transferOwnerTool,
  'mail.send': sendMailTool,
}

// §4.3.1 — CRUM's main agent. Phase 2 wires tools, defaultOptions, and activeTools resolution.
export const crmAssistant = new Agent({
  id: 'crm-assistant',
  name: 'CRUM Assistant',
  description:
    'Conversational CRM workbench agent. Reads the spine directly, stages every write for human approval.',

  instructions: CRUM_INSTRUCTIONS,

  // Phase 1: single model. Phase 2 adds fallback array per §4.3.1.
  model: CRUM_MAIN_MODEL,

  tools: crumToolRegistry,

  workflows: {
    'approval-flow': approvalFlow,
  },

  // Step retries are DISABLED unless this is set. The abort-and-retry path
  // in WriteClaimGuardProcessor (Phase 3) depends on it. §4.3.
  maxProcessorRetries: 2,

  // §4.7.3 — Goal defaults. Judge model evaluates completion each loop iteration.
  // Hard maxRuns budget; exhaustion pauses with a persisted reason. The GoalConfig
  // field is `judge` (a model id/object/resolver), not `judgeModelId`.
  goal: {
    judge: CRUM_MAIN_MODEL,
    maxRuns: 12,
  },

  // Processors are typed as Processor[] in processors.ts; the Agent constructor
  // expects the narrower InputProcessorOrWorkflow / OutputProcessorOrWorkflow
  // unions. The runtime dispatch is correct (the processor runner checks method
  // presence), so we assert at the boundary.
  inputProcessors: crumInputProcessors as InputProcessorOrWorkflow[],
  outputProcessors: crumOutputProcessors as OutputProcessorOrWorkflow[],

  defaultOptions: ({ requestContext }) => {
    const tenantContext = requestContext?.get<'tenantContext', TenantRequestContext | undefined>(
      'tenantContext',
    )
    if (!tenantContext) {
      return { activeTools: [] }
    }
    return {
      // Spelled in the provider-facing form: `activeTools` is filtered against
      // the keys AFTER Agent#formatTools rewrites them, so the dotted registry
      // ids would match nothing and hand the model an empty tool list.
      activeTools: resolveActiveTools(tenantContext).map(providerToolName),
    }
  },

  // Memory is registered on the Mastra instance as `coreMemory` (index.ts), but
  // an agent only ever resolves its own `memory` or one delegated through
  // MASTRA_INHERITED_MEMORY_KEY — instance registration alone does not reach it,
  // and a run without memory fails in the goal-state processor before the first
  // model call. Resolve it from the registry so there is still one instance.
  // A resolver that returns nothing is a tracked agent error, so fail closed
  // here instead of letting a silently memory-less agent run.
  memory: ({ mastra }) => {
    const coreMemory = mastra?.getMemory('coreMemory')
    if (!coreMemory) {
      throw new Error(
        'crm-assistant requires `coreMemory` registered on the Mastra instance (see createCrumMastra)',
      )
    }
    return coreMemory
  },
})

// §6 — Controller subagents. Pure definitions registered on the
// AgentController in index.ts. Each subagent gets its own model and step
// ceiling; the harness enforces the ceiling rather than trusting the prompt.
export const CRUM_SUBAGENTS: AgentControllerSubagent[] = [
  {
    id: 'parser',
    name: 'Record Parser',
    description:
      'Turns pasted business cards, email signatures or meeting notes into structured CRM fields.',
    instructions:
      'Extract CRM record fields from untrusted pasted text. Return only fields ' +
      'literally present. Never infer a city from an area code or an email domain. ' +
      'Omit anything not stated.',
    tools: {},
    defaultModelId: CRUM_LIGHT_MODEL,
    maxSteps: 3,
  },
  {
    id: 'email-drafter',
    name: 'Email Drafter',
    description:
      'Drafts an outbound email body from a customer record and a stated intent. Never sends.',
    instructions:
      'Draft a professional email body based on the customer context and intent provided. ' +
      'Never send the email. Never include placeholders the user must fill in. ' +
      'Keep the tone matching the relationship stage: formal for new contacts, ' +
      'warm but professional for established ones.',
    tools: {},
    defaultModelId: CRUM_MAIN_MODEL,
    maxSteps: 1,
  },
]
