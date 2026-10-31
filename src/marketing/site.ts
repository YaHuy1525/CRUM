import { createHash } from 'node:crypto'

/**
 * The uploaded files of one bundle's page, and the only place a hosted path is
 * decided. The funnel builder never names a file: a path is a placement
 * instruction from the same agent that wrote the copy, so it would need
 * sanitising and would enter the content-addressed artifact id. Making the slot
 * the artifact kind keeps the model out of both. Spec section 3.1.
 *
 * The slot kind is spelled out here rather than read from `MarketingArtifactKind`
 * (src/db/marketing.ts:25): that union still lists the six kinds migration 0018
 * admitted and has not caught up with the `thank_you_html` that migration 0019
 * adds, so typing a slot as `MarketingArtifactKind` does not compile. Retype it
 * as `MarketingArtifactKind` once `ARTIFACT_KINDS` gains the seventh kind.
 */
export type SiteSlotKind = 'page_html' | 'thank_you_html'

export const SITE_SLOTS: readonly { kind: SiteSlotKind; suffix: string }[] = [
  { kind: 'page_html', suffix: 'index.html' },
  { kind: 'thank_you_html', suffix: 'thanks/index.html' },
]

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

function ofKind(artifacts: readonly SiteArtifact[], kind: SiteSlotKind): SiteArtifact[] {
  return artifacts.filter((a) => a.kind === kind && a.textContent !== null)
}

const SLOT_KINDS: readonly string[] = SITE_SLOTS.map((slot) => slot.kind)

/**
 * The question in text rather than as a throw, because the stage tool wants to
 * refuse and report, and `unreadPlanColumns` set that precedent in
 * src/marketing/outbox.ts: answer early, in a sentence a human can act on.
 */
export function slotProblem(artifacts: readonly SiteArtifact[]): string | null {
  for (const kind of SLOT_KINDS) {
    const rows = ofKind(artifacts, kind as SiteSlotKind)
    if (rows.length > 1) return new SlotProblemError(kind, rows.map((r) => r.id)).message
  }
  return null
}

/**
 * A slug of `physio-melbourne` publishes `physio-melbourne/index.html`, and the
 * thank-you page sits under it, so one bundle owns one path prefix and cannot
 * reach another bundle's page.
 */
export function resolveSite(slug: string, artifacts: readonly SiteArtifact[]): SiteFile[] {
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
