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
  // The four asset fields are optional on purpose. Every fixture in nine test
  // files spells three, and the loader in Task 4 is the only code that can fill
  // these, because a title, a mime and bytes are a read rather than a fact
  // about the artifact row.
  documentId?: string | null
  title?: string | null
  mime?: string | null
  bytes?: Uint8Array | null
}

/**
 * A closed table, and a refusal outside it. A guessed extension is a file the
 * browser may not render, and `pageHostConfigFromEnv`'s `nonBlank` set the
 * precedent for refusing rather than assuming (spec section 5.3).
 */
export const ASSET_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

// The Cloudflare Pages per-file and per-deployment limits are higher than these,
// so they are CRUM's own ceilings: a page that needs a 40 MB hero is a mistake in
// the creative, and the cheap place to say so is before a reviewer is asked.
export const MAX_ASSET_BYTES = 8 * 1024 * 1024
export const MAX_SITE_BYTES = 24 * 1024 * 1024
export const MAX_SITE_ASSETS = 12

export type AssetProblemToken =
  | 'asset_name_missing'
  | 'asset_name_ambiguous'
  | 'asset_mime_unsupported'
  | 'asset_bytes_missing'
  | 'asset_too_large'
  | 'asset_unresolved'

/**
 * Which of the three byte ceilings refused. All three answer `asset_too_large`,
 * and the token union stays at its six members (spec section 12), so a consumer
 * that has to tell "shrink this picture" from "use fewer pictures" from "the
 * bundle is too big" reads this field rather than parsing English.
 */
export type AssetCeiling = 'image' | 'count' | 'site'

/**
 * The asset refusal as a throw, for the path that must not proceed: the approval
 * re-derives the site hash, and a page whose picture cannot be resolved is not a
 * page anyone approved. `siteProblem` says the same thing in text for the tool
 * that has to answer rather than fail.
 */
export class AssetProblemError extends Error {
  readonly token: AssetProblemToken
  readonly detail: string
  // Present on exactly the three lanes that check a ceiling and absent elsewhere,
  // so a consumer branching on it is never handed a guess.
  readonly ceiling?: AssetCeiling

  constructor(token: AssetProblemToken, detail: string, ceiling?: AssetCeiling) {
    super(`${token}: ${detail}`)
    this.name = 'AssetProblemError'
    this.token = token
    this.detail = detail
    this.ceiling = ceiling
  }
}

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

export const TEXT_HTML_CONTENT_TYPE = 'text/html'

export interface SiteFile {
  path: string
  sha256: string
  // Travels with the file rather than being decided at the upload, because an
  // image uploaded as `text/html` is an image the browser is told to parse as
  // markup, and nobody reviewing a page can tell from the outside.
  contentType: string
  // Bytes, not text: a hosted page can now carry a PNG, and a union would put
  // the same two decode lines in every consumer.
  content: Uint8Array
}

export function encodeSiteText(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text)
}

export function siteTextOf(file: SiteFile): string {
  return TEXT_DECODER.decode(file.content)
}

/**
 * The hash of exactly the bytes that are uploaded. For a text page this is the
 * value `site.ts` has produced since slice 2, because `createHash` on a string
 * already hashes its UTF-8 encoding; the pinned test above is what keeps that
 * claim honest rather than assumed.
 */
export function sha256OfText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
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
 * The publishability decision in one place. slugProblem answers it in text for
 * the stage tool, and resolveSite throws on the same answer; a second spelling
 * of the pattern here would let a slug pass the refusal and still fail the
 * manifest, or the reverse.
 */
function slugIsPublishable(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/**
 * The slug question in text for the same reason slotProblem answers in text: the
 * stage tool wants to refuse and report in a sentence a human can act on, not
 * throw inside an agent turn. A null slug is an understood plan — a bundle with
 * no page publishes nothing — so only a present-and-unpublishable slug is a
 * problem.
 */
export function slugProblem(slug: string | null): string | null {
  if (slug === null || slugIsPublishable(slug)) return null
  return new SlugProblemError(slug).message
}

function imageArtifacts(artifacts: readonly SiteArtifact[]): SiteArtifact[] {
  return artifacts.filter((a) => a.kind === 'image')
}

function pageArtifacts(artifacts: readonly SiteArtifact[]): SiteArtifact[] {
  const pages: SiteArtifact[] = []
  for (const slot of SITE_SLOTS) pages.push(...ofKind(artifacts, slot.kind))
  return pages
}

/**
 * The names the pages ask for, in the order the first page wrote them and
 * deduped across the bundle: one picture can serve the landing page and the
 * thank-you page, and it is still one file at one path.
 */
function referencedNames(artifacts: readonly SiteArtifact[]): string[] {
  const names: string[] = []
  for (const page of pageArtifacts(artifacts)) {
    for (const name of assetNamesReferenced(page.textContent ?? '')) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * A picture a page named whose bytes were found, with the pieces the hosted path
 * and the site total are built from. Exported because `assetPathOf` takes one: an
 * export whose parameter type cannot be named outside this module is a decoy, and
 * Task 7's integration proof has to name the hosted path it fetched.
 */
export interface AssetChoice {
  name: string
  artifact: SiteArtifact
  documentId: string
  extension: string
  byteLength: number
}

/**
 * The answer a lane gives when it refuses: a token, a sentence, and which ceiling
 * it hit when a ceiling is what it hit. `refuse` is the only thing that builds one.
 */
interface AssetProblem {
  token: AssetProblemToken
  detail: string
  ceiling?: AssetCeiling
}

/**
 * One refusal, spelled the same way in every lane, so `resolveAssets` reads as the
 * list of questions it answers rather than as a stack of object literals: nothing
 * is chosen, and the sentence says what the owner can do about it.
 */
function refuse(token: AssetProblemToken, detail: string, ceiling?: AssetCeiling): {
  choices: AssetChoice[]
  problem: AssetProblem
} {
  return { choices: [], problem: { token, detail, ceiling } }
}

/**
 * Every asset question this slice can ask, in the order it asks it: a placeholder
 * that names nothing, whether it never closed or its name came out blank, then a
 * name with no answer, then more answers than one, then the bytes behind the
 * answer, then the size of the whole site. Cheapest and most specific first,
 * because the owner reading a stage refusal has to be able to act on the first
 * sentence they see.
 */
function resolveAssets(artifacts: readonly SiteArtifact[]): {
  choices: AssetChoice[]
  problem: AssetProblem | null
} {
  const images = imageArtifacts(artifacts)
  // A picture is findable by its title and an untitled one is skipped rather than
  // matched on the empty string. `marketing.generate_assets` requires a non-empty
  // name in its input schema and Task 4's loader carries `title` straight from the
  // document row, so nothing that reaches this map can be without one.
  const byTitle = new Map<string, SiteArtifact[]>()
  for (const image of images) {
    const key = (image.title ?? '').trim()
    if (key === '') continue
    byTitle.set(key, [...(byTitle.get(key) ?? []), image])
  }

  const names = referencedNames(artifacts)
  for (const page of pageArtifacts(artifacts)) {
    const html = page.textContent ?? ''
    const bad = unterminatedAssetReferences(html)
    if (bad.length > 0) {
      return refuse(
        'asset_unresolved',
        `a page carries \`${ASSET_LITERAL}\` with no closing braces, so nothing could ` +
          `be substituted into ${JSON.stringify(bad[0])}`,
      )
    }
    // A placeholder the grammar matches but no name fills is the same mistake in a
    // different shape: `assetNamesReferenced` drops it, so the name lanes never see
    // it, and substitution would look up the empty string. Refusing here is what
    // keeps the promise that `siteProblem` says everything `resolveSite` would throw
    // about.
    for (const match of html.matchAll(ASSET_REFERENCE)) {
      if ((match[1] ?? '').trim() === '') {
        return refuse(
          'asset_unresolved',
          `a page carries ${JSON.stringify(match[0])}, which names no asset, so there is nothing to substitute`,
        )
      }
    }
  }

  const choices: AssetChoice[] = []
  for (const name of names) {
    const matches = byTitle.get(name) ?? []
    if (matches.length === 0) {
      const titles = [...byTitle.keys()].sort()
      return refuse(
        'asset_name_missing',
        `the page names the asset "${name}" and the bundle holds no image with that ` +
          `title (its images are ${titles.length > 0 ? titles.map((t) => `"${t}"`).join(', ') : 'none'})`,
      )
    }
    if (matches.length > 1) {
      // Counted, not assumed: the guard is more than one, and an owner told there
      // are two would delete a picture that is not the mistake.
      return refuse(
        'asset_name_ambiguous',
        `${matches.length} images in this bundle are titled "${name}" (${matches.map((m) => m.id).join(', ')}), ` +
          'so the placeholder has more than one answer',
      )
    }
    const artifact = matches[0]!
    const documentId = artifact.documentId ?? ''
    if (documentId === '') {
      return refuse(
        'asset_bytes_missing',
        `the image "${name}" (${artifact.id}) is attached to no document, so there are no bytes to publish`,
      )
    }
    const mime = artifact.mime ?? ''
    const extension = ASSET_MIME_EXTENSIONS[mime]
    if (extension === undefined) {
      return refuse(
        'asset_mime_unsupported',
        `the image "${name}" is ${mime || 'mime-less'} and CRUM publishes png, jpeg and webp only`,
      )
    }
    const bytes = artifact.bytes ?? null
    if (bytes === null || bytes.byteLength === 0) {
      return refuse(
        'asset_bytes_missing',
        `the image "${name}" (document ${documentId}) has no file row, or an empty one`,
      )
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      return refuse(
        'asset_too_large',
        `the image "${name}" is ${bytes.byteLength} bytes and CRUM publishes nothing over ${MAX_ASSET_BYTES}`,
        'image',
      )
    }
    choices.push({ name, artifact, documentId, extension, byteLength: bytes.byteLength })
  }

  if (choices.length > MAX_SITE_ASSETS) {
    return refuse(
      'asset_too_large',
      `the page references ${choices.length} images and ${MAX_SITE_ASSETS} is the most CRUM publishes for one bundle`,
      'count',
    )
  }
  // The page counts against the site ceiling with its pictures, because a
  // deployment is refused as a whole and a 30 MB page with a 30-byte picture is
  // the same mistake as the reverse. And in the unit the sentence quotes: a page
  // of accented copy is up to three times its `.length`, so counting code units
  // here would understate the very bundle it then refuses.
  const total = choices.reduce((sum, c) => sum + c.byteLength, 0) +
    pageArtifacts(artifacts).reduce((sum, p) => sum + encodeSiteText(p.textContent ?? '').byteLength, 0)
  if (total > MAX_SITE_BYTES) {
    // The size and the bound, never the size as an excess: Task 6 shows this
    // sentence to an owner deciding how much creative to re-cut.
    return refuse(
      'asset_too_large',
      `the page and its pictures together are ${total} bytes and CRUM publishes nothing over ${MAX_SITE_BYTES}`,
      'site',
    )
  }
  return { choices, problem: null }
}

/**
 * The URL a page is given for its picture, root-relative from the first
 * character: the thank-you page sits one directory deeper than the landing page,
 * so a path relative to the page would mean two different files for one
 * placeholder. `resolveSite` derives the published key from this string rather
 * than spelling it again, because a host key is a key and not a URL and the two
 * must never be one edit apart.
 */
export function assetPathOf(slug: string, choice: AssetChoice): string {
  return `/${slug}/assets/${choice.documentId}.${choice.extension}`
}

/**
 * The pictures a bundle paid for that no page names. Nothing here refuses them —
 * a page without an unused image is correct — but the stage report names them,
 * because five images generated and four used is the conversation the owner
 * should have before launch rather than the one they find by clicking around a
 * live page. A title twice is one line, the way `referencedNames` dedupes: two
 * unused pictures sharing a title are one mistake to read, not the same sentence
 * printed twice.
 */
export function unreferencedAssetNames(artifacts: readonly SiteArtifact[]): string[] {
  const names = new Set(referencedNames(artifacts))
  const unused: string[] = []
  for (const image of imageArtifacts(artifacts)) {
    const title = (image.title ?? '').trim()
    if (title === '' || names.has(title) || unused.includes(title)) continue
    unused.push(title)
  }
  return unused
}

/**
 * The asset question in text, for the tool that refuses and reports rather than
 * throws: the slot lane first, because two artifacts in one slot decides whether
 * there is a page to hang a picture on at all, then the asset lane. `resolveSite`
 * throws the same predicate as an `AssetProblemError`, which is the house shape
 * this file has kept since `slotProblem`.
 */
export function siteProblem(artifacts: readonly SiteArtifact[]): string | null {
  const slot = slotProblem(artifacts)
  if (slot !== null) return slot
  const { problem } = resolveAssets(artifacts)
  return problem === null ? null : new AssetProblemError(problem.token, problem.detail, problem.ceiling).message
}

/**
 * A slug of `physio-melbourne` publishes `physio-melbourne/index.html`, and the
 * thank-you page sits under it, so one bundle owns one path prefix and cannot
 * reach another bundle's page. A picture a page names publishes under the same
 * prefix, at `physio-melbourne/assets/<documentId>.<extension>`, which is why
 * the placeholder is substituted with a root-relative URL rather than a path
 * next to the page. The slug is checked first because every path and the site
 * hash are built from it, and it is a phrase an agent wrote.
 */
export function resolveSite(slug: string, artifacts: readonly SiteArtifact[]): SiteFile[] {
  if (!slugIsPublishable(slug)) throw new SlugProblemError(slug)
  // The throw spelling of `slotProblem`, and unconditional rather than nested
  // inside its answer: the publish loop below takes `rows[0]`, so a short-circuit
  // added to the text predicate would otherwise drop a page silently here instead
  // of refusing it.
  for (const kind of SLOT_KINDS) {
    const rows = ofKind(artifacts, kind)
    if (rows.length > 1) throw new SlotProblemError(kind, rows.map((r) => r.id))
  }
  const { choices, problem } = resolveAssets(artifacts)
  if (problem !== null) throw new AssetProblemError(problem.token, problem.detail, problem.ceiling)
  const byName = new Map(choices.map((c) => [c.name, c]))

  const files: SiteFile[] = []
  for (const slotDef of SITE_SLOTS) {
    const rows = ofKind(artifacts, slotDef.kind)
    if (rows.length === 0) continue
    const raw = rows[0]?.textContent ?? ''
    // Substitution happens here, inside the bytes the approval hashes, and not
    // after the hash the way the pixel snippet does. Spec section 2 is the
    // reason a picture cannot ride the shape that is right next to it.
    const content = raw.replace(ASSET_REFERENCE, (_match, name: string) => {
      const choice = byName.get(name.trim())
      if (!choice) throw new AssetProblemError('asset_name_missing', `the page names "${name.trim()}" and no image answers it`)
      return assetPathOf(slug, choice)
    })
    files.push({
      path: `${slug}/${slotDef.suffix}`,
      sha256: sha256OfText(content),
      contentType: TEXT_HTML_CONTENT_TYPE,
      content: encodeSiteText(content),
    })
  }

  // Only the images a page actually named, and once each: two placeholders for
  // one picture are one file, and a hash the approval re-derives must not depend
  // on how many times the copy asked for it. The key is `assetPathOf` with its
  // leading slash taken off, so the URL inside the hashed page cannot name a file
  // this list does not upload. Two choices landing on one path are the same
  // document twice, because the path is keyed on `documentId`, and then the bytes
  // the first one writes are the bytes the second would have written.
  const seen = new Set<string>()
  for (const choice of choices) {
    const path = assetPathOf(slug, choice).slice(1)
    if (seen.has(path)) continue
    seen.add(path)
    const bytes = choice.artifact.bytes as Uint8Array
    files.push({
      path,
      // Over the bytes as they will be uploaded, and never through
      // `sha256OfText`: a PNG is not text, and a hash of a decode of it is a
      // promise the publisher cannot keep.
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: choice.artifact.mime as string,
      content: bytes,
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

/**
 * The handle is the designer's asset name, which `marketing.generate_assets`
 * already stores as the document title, so the funnel builder can write a page
 * that names a picture before that picture is paid for. Spec section 5.1.
 *
 * `[^{}]+?` and not `.+?`: a name with a brace in it is refused by the prompt
 * parser long before it reaches a page, and a grammar that could match across a
 * second placeholder would make one typo eat the page.
 *
 * Never call `.test()` or `.exec()` on this exported global. `matchAll` clones the
 * regex and a global `replace` resets `lastIndex`, but a manual `.test()` would
 * leave the pointer mid-string and make this scan and Task 3's substitution
 * disagree about one page, which is the divergence this slice cannot afford.
 */
export const ASSET_REFERENCE = /\{\{ASSET:([^{}]+?)\}\}/g
export const ASSET_LITERAL = '{{ASSET:'

export function assetNamesReferenced(html: string): string[] {
  const names: string[] = []
  for (const match of html.matchAll(ASSET_REFERENCE)) {
    const name = (match[1] ?? '').trim()
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * The fragments the grammar refused to match. A literal that no well-formed
 * placeholder explains is the whole finding, so each entry starts at that literal
 * and runs to the next `}}` or the end of the page, cut at `MAX_FRAGMENT_CHARS` so
 * a refusal quotes a phrase rather than a paragraph of the client's copy. A page
 * that survives substitution still carrying the literal is a page whose placeholder
 * was malformed, and publishing `{{ASSET:hero` to a live domain is a bug the owner
 * finds by clicking, which is the finding this slice refuses to leave in place.
 *
 * Counting literals against matches would report the fact but not the place, and it
 * would under-report a page with two broken placeholders, so this walks the literals.
 */
const MAX_FRAGMENT_CHARS = 120

export function unterminatedAssetReferences(html: string): string[] {
  const matchedStarts = new Set([...html.matchAll(ASSET_REFERENCE)].map((match) => match.index))
  const fragments: string[] = []
  for (let at = html.indexOf(ASSET_LITERAL); at !== -1; at = html.indexOf(ASSET_LITERAL, at + ASSET_LITERAL.length)) {
    if (matchedStarts.has(at)) continue
    const closing = html.indexOf('}}', at)
    const end = closing === -1 ? html.length : Math.min(closing + 2, html.length)
    fragments.push(html.slice(at, Math.min(end, at + MAX_FRAGMENT_CHARS)))
  }
  return fragments
}
