import { MCPServer } from '@mastra/mcp'
import { listCustomersTool, getCustomerTool } from './tools/customers'
import { findContactsTool } from './tools/contacts'
import { myOpenItemsTool } from './tools/tasks'
import { knowledgeRetrieveTool } from './tools/knowledge'

/**
 * §10.3 — CRUM MCP 2.0 server.
 *
 * Exposes read tools only. Writes are NOT exposed: an external MCP host never
 * sees CRUM's approval gate as an approval — it sees a tool that refuses with
 * an explanation (§10.3.2). The server speaks MCP 2026-07-28 only; 2025-era
 * clients receive an unsupported-protocol error on negotiation (§10.3.5).
 *
 * `requestState.key` comes from `resolveMcpRequestState()` in `mcp-guard.ts`,
 * which throws in production when `MCP_REQUEST_STATE_KEY` is unset (§13.8).
 *
 * OAuth middleware is created separately via `createCrumOAuthMiddleware()` and
 * mounted by the Mastra server at `/api/mcp/crum-crm/mcp`.
 */
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

/**
 * §10.3.4 — OAuth middleware factory.
 *
 * Returns the configuration for the Mastra server to mount at
 * `/api/mcp/crum-crm/mcp`. Uses `createOAuthMiddleware` from `@mastra/mcp`
 * with `createIntrospectionValidator` for token validation.
 *
 * In development without `CRM_OIDC_ISSUER`, returns undefined so the server
 * can start without OAuth (the MCP guard's ephemeral key still signs
 * continuations).
 */
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
