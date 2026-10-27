import { MCPServer } from '@mastra/mcp'
import { listCustomersTool, getCustomerTool } from './tools/customers'
import { findContactsTool } from './tools/contacts'
import { myOpenItemsTool } from './tools/tasks'
import { knowledgeRetrieveTool } from './tools/knowledge'

export function createCrumMcpServer(requestStateKey: string): MCPServer {
  return new MCPServer({
    id: 'crum-crm',
    name: 'CRUM CRM',
    version: '0.5.0',
    description: 'Read CRM records. Writes require CRUM console approval.',
    title: 'CRUM',
    websiteUrl: 'https://crum.example.com',

    tools: {
      'crm.list_customers': listCustomersTool,
      'crm.get_customer': getCustomerTool,
      'crm.find_contacts': findContactsTool,
      'crm.my_open_items': myOpenItemsTool,
      'knowledge.retrieve': knowledgeRetrieveTool,
    },

    requestState: {
      key: requestStateKey,
      ttlSeconds: 600,
    },

    mapAuthInfoToUser: ({ authInfo }) => {
      const info = authInfo as { extra?: { sub?: string; tenantId?: string } }
      if (!info.extra?.sub) return null
      return { id: info.extra.sub, tenantId: info.extra.tenantId }
    },

    cacheHints: {
      'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
      'server/discover': { ttlMs: 60_000, cacheScope: 'public' },
    },
  })
}

export function createCrumOAuthMiddleware() {
  const issuer = process.env.CRM_OIDC_ISSUER
  if (!issuer) return undefined

  return {
    oauth: {
      resource: 'https://mcp.crum.example.com/api/mcp/crum-crm/mcp',
      authorizationServers: [issuer],
      scopesSupported: ['crm:read', 'crm:write'],
      resourceName: 'CRUM CRM',
    },
    mcpPath: '/api/mcp/crum-crm/mcp',
  }
}
