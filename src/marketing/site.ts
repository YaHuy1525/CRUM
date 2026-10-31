import { createHash } from 'node:crypto'
import type { MarketingArtifactKind } from '../db/marketing'

/**
 * The uploaded files of one bundle's page, and the only place a hosted path is
 * decided. The funnel builder never names a file: a path is a placement
 * instruction from the same agent that wrote the copy, so it would need
 * sanitising and would enter the content-addressed artifact id. Making the slot
 * the artifact kind keeps the model out of both. Spec section 3.1.
 *
 * `satisfies` pins every slot kind to `MarketingArtifactKind`, so a slot the
 * artifact table refuses is a compile error rather than a page that can never
 * be saved.
 */
export const SITE_SLOTS = [
  { kind: 'page_html', suffix: 'index.html' },
  { kind: 'thank_you_html', suffix: 'thanks/index.html' },
] as const satisfies readonly { kind: MarketingArtifactKind; suffix: string }[]

/**
 * Narrower than an artifact kind on purpose: only the kinds CRUM places at a
 * path have a slot, so this union is the vocabulary of the registry, not of the
 * artifact table.
 */
export type SiteSlotKind = (typeof SITE_SLOTS)[number]['kind']

export interface SiteArtifact {
  id: string
  kind: string
  textContent: string | null
}

export interface SiteFile {
  path: string
  sha256: string
  content: string
}

export class SlotProblemError extends Error {
  readonly kind: string
  readonly artifactIds: string[]

  constructor(kind: string, artifactIds: string[]) {
    super(
      `slot_${kind}: ${artifactIds.length} artifacts claim the ${kind} slot (${artifactIds.join(', ')}). ` +
        'A publisher that picked one would be publishing a page nobody approved.',
    )
    this.name = 'SlotProblemError'
    this.kind = kind
    this.artifactIds = artifactIds
  }
}

/**
 * One path segment and no more: lowercase letters, digits and hyphens, starting
 * with a letter or digit, at most 63 characters, so a slug cannot become a
 * second segment or climb out of the bundle's own prefix.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export class SlugProblemError extends Error {
  readonly slug: string

  constructor(slug: string) {
    super(
      `slug_${JSON.stringify(slug)} cannot be published: a slug is one path segment of ` +
        'lowercase letters, digits and hyphens, starting with a letter or digit, ' +
        '63 characters at most. The reviewer approves a hash over this path, so a slug ' +
        'that is not one is refused before it names anything.',
    )
    this.name = 'SlugProblemError'
    this.slug = slug
  }
}

function ofKind(artifacts: readonly SiteArtifact[], kind: SiteSlotKind): SiteArtifact[] {
  return artifacts.filter((a) => a.kind === kind && a.textContent !== null)
}

const SLOT_KINDS: readonly SiteSlotKind[] = SITE_SLOTS.map((slot) => slot.kind)

/**
 * The question in text rather than as a throw, because the stage tool wants to
 * refuse and report, and `unreadPlanColumns` set that precedent in
 * src/marketing/outbox.ts: answer early, in a sentence a human can act on.
 */
export function slotProblem(artifacts: readonly SiteArtifact[]): string | null {
  for (const kind of SLOT_KINDS) {
    const rows = ofKind(artifacts, kind)
    if (rows.length > 1) return new SlotProblemError(kind, rows.map((r) => r.id)).message
  }
  return null
}

/**
 * A slug of `physio-melbourne` publishes `physio-melbourne/index.html`, and the
 * thank-you page sits under it, so one bundle owns one path prefix and cannot
 * reach another bundle's page. The slug is checked first because every path and
 * the site hash are built from it, and it is a phrase an agent wrote.
 */
export function resolveSite(slug: string, artifacts: readonly SiteArtifact[]): SiteFile[] {
  if (!SLUG_PATTERN.test(slug)) throw new SlugProblemError(slug)
  const files: SiteFile[] = []
  for (const slot of SITE_SLOTS) {
    const rows = ofKind(artifacts, slot.kind)
    if (rows.length === 0) continue
    if (rows.length > 1) throw new SlotProblemError(slot.kind, rows.map((r) => r.id))
    const content = rows[0]?.textContent ?? ''
    files.push({
      path: `${slug}/${slot.suffix}`,
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    })
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Sorted pairs of path and content hash, canonicalised before hashing so two
 * callers holding the same files in a different order agree. This is the value
 * the reviewer is shown and the value the approval re-derives under the row
 * lock: the bytes move, the hash moves, the approval throws.
 */
export function siteHashOf(files: readonly SiteFile[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${f.sha256}`)
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}
