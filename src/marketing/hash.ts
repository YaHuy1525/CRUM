import { createHash } from 'node:crypto'

/**
 * The nine columns that make a bundle the bundle it is. Status, ids and
 * timestamps are excluded on purpose: a bundle that moved from draft to staged
 * is the same work, and a hash that moved with it would stage a second pending
 * write for one review.
 */
export interface BundleHashInput {
  brief: string
  objective: string
  audienceNote: string | null
  strategy: unknown
  copy: unknown
  mediaPlan: unknown
  funnelPlan: unknown
  analysis: unknown
  promptVersion: string
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalJson(value: unknown): string {
  return canonical(value)
}

export function computeBundleHash(columns: BundleHashInput): string {
  return createHash('sha256').update(canonical(columns)).digest('hex')
}

/**
 * RFC 9562 UUIDv8 layout, copied from snapshotIdFor in
 * src/mastra/tools/prospect-writes.ts:438-445 so the two content-addressed
 * lanes are derived the same way and a reader who knows one knows the other.
 */
export function uuidFromSeed(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

export function artifactIdFor(input: {
  tenantId: string
  bundleId: string
  role: string
  kind: string
  content: string
}): string {
  return uuidFromSeed(
    `${input.tenantId}:${input.bundleId}:${input.role}:${input.kind}:${input.content}`,
  )
}
