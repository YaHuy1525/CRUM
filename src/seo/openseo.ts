// src/seo/openseo.ts
// OpenSEO adapter: an open-source SEO analytics front-end that proxies
// DataForSEO. One configured URL (the OpenSEO instance) plus a DataForSEO API
// key; both must be present for any SEO tool to work. All four operations are
// read-only — keyword research, site audits, rank tracking and backlink
// analysis — so there is no approval gate on the tool side.

import type { CrumEnv } from '../config/env'

export class OpenSeoError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OpenSeoError'
    this.status = status
  }
}

export interface OpenSeoConfig {
  apiUrl: string
  apiKey: string
}

export function openseoConfigured(env: CrumEnv): OpenSeoConfig | null {
  if (!env.CRUM_OPENSEO_URL || !env.DATAFORSEO_API_KEY) return null
  return { apiUrl: env.CRUM_OPENSEO_URL, apiKey: env.DATAFORSEO_API_KEY }
}

// ── Keyword research ────────────────────────────────────────────────────────

export interface KeywordResearchParams {
  keywords: string[]
  country?: string
  language?: string
}

export interface KeywordResult {
  keyword: string
  searchVolume: number
  competition: number
  cpc: number
}

export async function searchKeywords(
  config: OpenSeoConfig,
  params: KeywordResearchParams,
): Promise<KeywordResult[]> {
  const res = await fetch(`${config.apiUrl}/v1/keywords`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      keywords: params.keywords,
      country: params.country ?? 'au',
      language: params.language ?? 'en',
    }),
  })

  const json = (await res.json().catch(() => ({}))) as {
    results?: Array<{ keyword?: string; search_volume?: number; competition?: number; cpc?: number }>
    message?: string
  }
  if (!res.ok) {
    throw new OpenSeoError(
      `openseo keywords failed: ${json.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return (json.results ?? []).map((r) => ({
    keyword: r.keyword ?? '',
    searchVolume: r.search_volume ?? 0,
    competition: r.competition ?? 0,
    cpc: r.cpc ?? 0,
  }))
}

// ── Site audit ──────────────────────────────────────────────────────────────

export interface SiteAuditParams {
  url: string
  maxPages?: number
}

export interface AuditIssue {
  severity: string
  type: string
  description: string
  page: string
}

export interface SiteAuditResult {
  score: number
  issues: AuditIssue[]
}

export async function auditSite(
  config: OpenSeoConfig,
  params: SiteAuditParams,
): Promise<SiteAuditResult> {
  const res = await fetch(`${config.apiUrl}/v1/audit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      url: params.url,
      max_pages: params.maxPages ?? 100,
    }),
  })

  const json = (await res.json().catch(() => ({}))) as {
    score?: number
    issues?: Array<{ severity?: string; type?: string; description?: string; page?: string }>
    message?: string
  }
  if (!res.ok) {
    throw new OpenSeoError(
      `openseo audit failed: ${json.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return {
    score: json.score ?? 0,
    issues: (json.issues ?? []).map((i) => ({
      severity: i.severity ?? 'unknown',
      type: i.type ?? 'unknown',
      description: i.description ?? '',
      page: i.page ?? '',
    })),
  }
}

// ── Rank tracking ───────────────────────────────────────────────────────────

export interface RankTrackingParams {
  domain: string
  keywords: string[]
  country?: string
}

export interface RankingResult {
  keyword: string
  position: number
  previousPosition: number
  url: string
}

export async function trackRankings(
  config: OpenSeoConfig,
  params: RankTrackingParams,
): Promise<RankingResult[]> {
  const res = await fetch(`${config.apiUrl}/v1/rankings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      domain: params.domain,
      keywords: params.keywords,
      country: params.country ?? 'au',
    }),
  })

  const json = (await res.json().catch(() => ({}))) as {
    rankings?: Array<{
      keyword?: string
      position?: number
      previous_position?: number
      url?: string
    }>
    message?: string
  }
  if (!res.ok) {
    throw new OpenSeoError(
      `openseo rankings failed: ${json.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return (json.rankings ?? []).map((r) => ({
    keyword: r.keyword ?? '',
    position: r.position ?? 0,
    previousPosition: r.previous_position ?? 0,
    url: r.url ?? '',
  }))
}

// ── Backlink analysis ───────────────────────────────────────────────────────

export interface BacklinkAnalysisParams {
  domain: string
  limit?: number
}

export interface BacklinkEntry {
  sourceUrl: string
  domainRating: number
  anchorText: string
  firstSeen: string
}

export interface BacklinkAnalysisResult {
  totalBacklinks: number
  referringDomains: number
  backlinks: BacklinkEntry[]
}

export async function analyzeBacklinks(
  config: OpenSeoConfig,
  params: BacklinkAnalysisParams,
): Promise<BacklinkAnalysisResult> {
  const res = await fetch(`${config.apiUrl}/v1/backlinks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      domain: params.domain,
      limit: params.limit ?? 50,
    }),
  })

  const json = (await res.json().catch(() => ({}))) as {
    total_backlinks?: number
    referring_domains?: number
    backlinks?: Array<{
      source_url?: string
      domain_rating?: number
      anchor_text?: string
      first_seen?: string
    }>
    message?: string
  }
  if (!res.ok) {
    throw new OpenSeoError(
      `openseo backlinks failed: ${json.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return {
    totalBacklinks: json.total_backlinks ?? 0,
    referringDomains: json.referring_domains ?? 0,
    backlinks: (json.backlinks ?? []).map((b) => ({
      sourceUrl: b.source_url ?? '',
      domainRating: b.domain_rating ?? 0,
      anchorText: b.anchor_text ?? '',
      firstSeen: b.first_seen ?? '',
    })),
  }
}
