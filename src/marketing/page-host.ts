/**
 * The only CRUM code that reaches a page host, and the second half of spec
 * section 6: an action becomes approvable only once it is executable here.
 * Hand-written fetch rather than wrangler, because wrangler is a CLI and this is
 * a server that must report what the provider said.
 */
import { listMarketingArtifacts } from '../db/marketing'
import { resolveSite, siteHashOf, type SiteFile } from './site'
import type { DerivedAction, MarketingActionAdapter, MarketingActionName } from './outbox'

export interface PageHostConfig {
  accountId: string
  project: string
  apiToken: string
  productionBranch: string
  previewBranchPrefix: string
}

export class PageHostError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`pages_upload_http_${status}: ${body.slice(0, 500)}`)
    this.name = 'PageHostError'
    this.status = status
    this.body = body
  }
}

export type DeployResult = { deploymentId: string; url: string }

/**
 * The shape Cloudflare documents: one `manifest` field of path to content hash,
 * and one part per hash holding the bytes. `skip_upload` variants and zip
 * bodies are not used, because the zip path is the dashboard's and the
 * community reports say API zip uploads fail quietly.
 */
export function buildUploadForm(files: readonly SiteFile[], branch: string, commitMessage: string): FormData {
  const form = new FormData()
  const manifest: Record<string, string> = {}
  for (const file of files) {
    manifest[file.path] = file.sha256
    form.set(file.sha256, new Blob([file.content], { type: 'text/html' }))
  }
  form.set('manifest', JSON.stringify(manifest))
  form.set('branch', branch)
  form.set('commit_message', commitMessage)
  return form
}

function deploymentUrl(value: unknown): string {
  const record = value as Record<string, unknown> | null
  const raw = typeof record?.['url'] === 'string' ? record['url'] : ''
  return raw.startsWith('http') ? raw : `https://${raw.replace(/^\/+/, '')}`
}

export async function deploySite(
  config: PageHostConfig,
  files: readonly SiteFile[],
  branch: string,
  commitMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployResult> {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.project}/deployments`,
    { method: 'POST', headers: { Authorization: `Bearer ${config.apiToken}` }, body: buildUploadForm(files, branch, commitMessage) },
  )
  const text = await response.text()
  if (!response.ok) throw new PageHostError(response.status, text)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new PageHostError(response.status, 'unparseable body')
  }
  if (parsed['success'] !== true) throw new PageHostError(response.status, text)

  const result = parsed['result'] as Record<string, unknown> | null
  const id = typeof result?.['id'] === 'string' ? result['id'] : ''
  if (id === '' || typeof result?.['url'] !== 'string') {
    throw new PageHostError(response.status, `result carried no deployment id or url: ${text.slice(0, 300)}`)
  }
  return { deploymentId: id, url: deploymentUrl(result) }
}

// A payload key that is not a string is a payload this build cannot act on, and
// an empty value refuses downstream (resolveSite shouts at an empty slug). It
// must not become '[object Object]' in a query or a commit message instead.
function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The outbox payload is a hash and an id, never the bytes: spec section 7. So
 * the adapter reads the artifacts back and re-derives the hash, and refuses to
 * upload anything other than the bytes the receipt covered. The read goes
 * through `listMarketingArtifacts`, because the payload's bundle id carries no
 * tenant: only the claimed action row knows whose bundle this is, and a query
 * scoped by bundle id alone would happily publish another tenant's page.
 */
export async function readSiteFiles(action: DerivedAction, tenantId: string): Promise<SiteFile[]> {
  const bundleId = stringField(action.payload['bundleId'])
  const slug = stringField(action.payload['slug'])
  const expected = stringField(action.payload['siteHash'])
  const artifacts = await listMarketingArtifacts(tenantId, bundleId)
  const files = resolveSite(slug, artifacts)
  if (files.length === 0) {
    throw new Error(`no_site_files: bundle ${bundleId} holds no uploaded file for slug ${slug}`)
  }
  if (expected === '') {
    throw new Error(
      `site_hash_missing: bundle ${bundleId} carries no approved siteHash, so the stored bytes ` +
        'cannot be checked against it; rebuild the action from the hash the reviewer approved',
    )
  }
  if (siteHashOf(files) !== expected) {
    throw new Error(
      `site_hash_moved: bundle ${bundleId} no longer hashes to the approved siteHash, so the ` +
        'stored bytes are not the ones the reviewer approved; re-approve the bundle to issue ' +
        'an action over the bytes stored now',
    )
  }
  return files
}

/**
 * Two adapters, one endpoint. Promotion is a re-upload to the production branch,
 * because Cloudflare documents no call that promotes an existing deployment, so
 * the live deployment carries a new id and the preview URL keeps serving the
 * old one. Spec section 2 and the spike file.
 */
export function makePublishPageAdapter(config: PageHostConfig): MarketingActionAdapter {
  return {
    name: 'publish_page' satisfies MarketingActionName,
    execute: async (action, context) => {
      const files = await readSiteFiles(action, context.tenantId)
      const slug = stringField(action.payload['slug'])
      const deployed = await deploySite(
        config,
        files,
        `${config.previewBranchPrefix}/${slug}`,
        `CRUM bundle ${stringField(action.payload['bundleId'])} preview`,
      )
      return { externalId: deployed.deploymentId, url: deployed.url, fileCount: files.length }
    },
  }
}

export function makePromotePageAdapter(config: PageHostConfig): MarketingActionAdapter {
  return {
    name: 'promote_page' satisfies MarketingActionName,
    execute: async (action, context) => {
      const files = await readSiteFiles(action, context.tenantId)
      const deployed = await deploySite(
        config,
        files,
        config.productionBranch,
        `CRUM bundle ${stringField(action.payload['bundleId'])} live`,
      )
      return { externalId: deployed.deploymentId, url: deployed.url, fileCount: files.length }
    },
  }
}

/**
 * All or nothing on purpose. A half-configured host would register an adapter
 * that throws at drain time, after a human approved the bundle, which is the
 * failure spec section 6 exists to prevent. Missing config keeps the action
 * unexecutable and the stage refusal honest.
 */
export function pageHostConfigFromEnv(env: {
  CRUM_CLOUDFLARE_ACCOUNT_ID?: string
  CRUM_CLOUDFLARE_PAGES_PROJECT?: string
  CRUM_CLOUDFLARE_API_TOKEN?: string
  CRUM_PAGES_PRODUCTION_BRANCH?: string
}): PageHostConfig | null {
  const { CRUM_CLOUDFLARE_ACCOUNT_ID: accountId, CRUM_CLOUDFLARE_PAGES_PROJECT: project } = env
  const apiToken = env.CRUM_CLOUDFLARE_API_TOKEN
  const productionBranch = env.CRUM_PAGES_PRODUCTION_BRANCH
  if (!accountId || !project || !apiToken || !productionBranch) return null
  return { accountId, project, apiToken, productionBranch, previewBranchPrefix: 'crum-preview' }
}
