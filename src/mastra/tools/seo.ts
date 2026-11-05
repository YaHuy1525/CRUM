// src/mastra/tools/seo.ts
// Read-only SEO analytics tools backed by OpenSEO (DataForSEO). All four are
// observational — keyword research, site audits, rank tracking and backlink
// analysis — so none carry requireApproval. A tool that only reads search
// engine data cannot stage an irreversible change the way a sent text message
// or a published page can.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { parseEnv } from '../../config/env'
import {
  openseoConfigured,
  searchKeywords,
  auditSite,
  trackRankings,
  analyzeBacklinks,
} from '../../seo/openseo'
import { TenantRequestContextSchema } from '../../mastra/tenant-context'

// ── Keyword research ────────────────────────────────────────────────────────

const KeywordResultSchema = z.object({
  keyword: z.string(),
  searchVolume: z.number(),
  competition: z.number(),
  cpc: z.number(),
})

const KeywordResearchOutputSchema = z.object({
  results: z.array(KeywordResultSchema),
})

export const seoKeywordResearchTool = createTool({
  id: 'seo.keyword_research',
  title: 'SEO Keyword Research',
  description:
    'Look up search volume, competition and CPC for keywords via OpenSEO/DataForSEO. Requires CRUM_OPENSEO_URL and DATAFORSEO_API_KEY.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    keywords: z.array(z.string().trim().min(1)).min(1).max(10),
    country: z.string().trim().min(1).max(2).default('au').optional(),
    language: z.string().trim().min(1).max(2).default('en').optional(),
  }),
  outputSchema: KeywordResearchOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) =>
    context.observe.span('seo.keyword_research', async () => {
      const env = parseEnv()
      const config = openseoConfigured(env)
      if (!config) {
        throw new Error('OpenSEO not configured: set CRUM_OPENSEO_URL and DATAFORSEO_API_KEY')
      }
      const results = await searchKeywords(config, {
        keywords: input.keywords,
        country: input.country,
        language: input.language,
      })
      return { results }
    }),
})

// ── Site audit ──────────────────────────────────────────────────────────────

const AuditIssueSchema = z.object({
  severity: z.string(),
  type: z.string(),
  description: z.string(),
  page: z.string(),
})

const SiteAuditOutputSchema = z.object({
  score: z.number(),
  issues: z.array(AuditIssueSchema),
})

export const seoSiteAuditTool = createTool({
  id: 'seo.site_audit',
  title: 'SEO Site Audit',
  description:
    'Run an SEO audit on a website URL. Returns health score and categorized issues. Requires CRUM_OPENSEO_URL and DATAFORSEO_API_KEY.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    url: z.string().url(),
    maxPages: z.number().int().min(1).max(10000).default(100).optional(),
  }),
  outputSchema: SiteAuditOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) =>
    context.observe.span('seo.site_audit', async () => {
      const env = parseEnv()
      const config = openseoConfigured(env)
      if (!config) {
        throw new Error('OpenSEO not configured: set CRUM_OPENSEO_URL and DATAFORSEO_API_KEY')
      }
      return auditSite(config, { url: input.url, maxPages: input.maxPages })
    }),
})

// ── Rank tracking ───────────────────────────────────────────────────────────

const RankingResultSchema = z.object({
  keyword: z.string(),
  position: z.number(),
  previousPosition: z.number(),
  url: z.string(),
})

const RankTrackingOutputSchema = z.object({
  rankings: z.array(RankingResultSchema),
})

export const seoRankTrackingTool = createTool({
  id: 'seo.rank_tracking',
  title: 'SEO Rank Tracking',
  description:
    'Check current search engine rankings for a domain across specified keywords. Requires CRUM_OPENSEO_URL and DATAFORSEO_API_KEY.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    domain: z.string().trim().min(1),
    keywords: z.array(z.string().trim().min(1)).min(1).max(10),
    country: z.string().trim().min(1).max(2).optional(),
  }),
  outputSchema: RankTrackingOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) =>
    context.observe.span('seo.rank_tracking', async () => {
      const env = parseEnv()
      const config = openseoConfigured(env)
      if (!config) {
        throw new Error('OpenSEO not configured: set CRUM_OPENSEO_URL and DATAFORSEO_API_KEY')
      }
      const rankings = await trackRankings(config, {
        domain: input.domain,
        keywords: input.keywords,
        country: input.country,
      })
      return { rankings }
    }),
})

// ── Backlink analysis ───────────────────────────────────────────────────────

const BacklinkEntrySchema = z.object({
  sourceUrl: z.string(),
  domainRating: z.number(),
  anchorText: z.string(),
  firstSeen: z.string(),
})

const BacklinkAnalysisOutputSchema = z.object({
  totalBacklinks: z.number(),
  referringDomains: z.number(),
  backlinks: z.array(BacklinkEntrySchema),
})

export const seoBacklinkAnalysisTool = createTool({
  id: 'seo.backlink_analysis',
  title: 'SEO Backlink Analysis',
  description:
    'Analyze backlink profile for a domain. Returns referring domains, ratings and anchor texts. Requires CRUM_OPENSEO_URL and DATAFORSEO_API_KEY.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    domain: z.string().trim().min(1),
    limit: z.number().int().min(1).max(1000).default(50).optional(),
  }),
  outputSchema: BacklinkAnalysisOutputSchema,
  outputValidation: 'warn',

  execute: async (input, context) =>
    context.observe.span('seo.backlink_analysis', async () => {
      const env = parseEnv()
      const config = openseoConfigured(env)
      if (!config) {
        throw new Error('OpenSEO not configured: set CRUM_OPENSEO_URL and DATAFORSEO_API_KEY')
      }
      return analyzeBacklinks(config, { domain: input.domain, limit: input.limit })
    }),
})
