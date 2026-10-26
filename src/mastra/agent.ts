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
import {
  listDocumentsTool,
  getInvoiceTool,
  getContractTool,
  sumInvoicesTool,
} from './tools/documents'
import { logFollowupTool, createTaskTool, draftMailTool } from './tools/auto-writes'
import { createCustomerTool, updateCustomerTool, deleteCustomerTool } from './tools/customer-writes'
import { createContactTool, createScheduleTool, transferOwnerTool, sendMailTool } from './tools/approval-writes'
import { approvalFlow } from './workflows/approval-flow'
import { resolveActiveTools, providerToolName } from './active-tools'
import { CRUM_MAIN_MODEL, CRUM_LIGHT_MODEL } from './models'
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
  'mail.search_threads': searchThreadsTool,
  'doc.list_documents': listDocumentsTool,
  'doc.get_invoice': getInvoiceTool,
  'doc.get_contract': getContractTool,
  'doc.sum_invoices': sumInvoicesTool,
  'crm.log_followup': logFollowupTool,
  'crm.create_task': createTaskTool,
  'mail.draft': draftMailTool,
  'crm.create_customer': createCustomerTool,
  'crm.update_customer': updateCustomerTool,
  'crm.delete_customer': deleteCustomerTool,
  'crm.create_contact': createContactTool,
  'crm.create_schedule': createScheduleTool,
  'crm.transfer_owner': transferOwnerTool,
  'mail.send': sendMailTool,
}

export const crmAssistant = new Agent({
  id: 'crm-assistant',
  name: 'CRUM Assistant',
  description:
    'Conversational CRM workbench agent. Reads the spine directly, stages every write for human approval.',

  instructions: CRUM_INSTRUCTIONS,

  model: CRUM_MAIN_MODEL,

  tools: crumToolRegistry,

  workflows: {
    'approval-flow': approvalFlow,
  },

  maxProcessorRetries: 2,

  goal: {
    judge: CRUM_MAIN_MODEL,
    maxRuns: 12,
  },

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
      activeTools: resolveActiveTools(tenantContext).map(providerToolName),
    }
  },

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
