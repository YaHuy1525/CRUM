export type DraftChannel = 'dm' | 'email'
export type DraftStage = 'first_touch' | 'followup_1' | 'followup_2'

export interface DraftInput {
  body: string
  channel: DraftChannel
  stage: DraftStage
  evidenceSnapshotId: string | null
}

export type DraftViolation = 'empty' | 'too_long' | 'no_cited_fact' | 'link_in_first_touch'

const WORD_CAP: Record<DraftChannel, number> = { dm: 90, email: 120 }
// Scheme-less links count too: `example.com` and `t.me/x` evade the https/www
// tests entirely. A bare domain only matches on a known suffix, which keeps a
// sentence ending in a full stop ("your Sydney studio.") from reading as a link.
const LINK = /(?:https?:\/\/|www\.|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|co|io|au|vn|ly|me)\b)/i
// The `g` flag is required: `String.match` without it returns only the first
// hit, so the ">= 3 marks" test below would never fire on a real sample.
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gi
const LATIN_WORD = /\b[a-z]{3,}\b/gi

function countWords(body: string): number {
  // Bullets and hyphen-separated lists leave standalone dashes as whitespace
  // tokens. They are punctuation, not words, and counting them rejects a body
  // that is inside the cap.
  return body
    .trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length
}

export function checkDraft(input: DraftInput): DraftViolation[] {
  const violations: DraftViolation[] = []
  const body = input.body ?? ''
  if (body.trim() === '') violations.push('empty')
  if (countWords(body) > WORD_CAP[input.channel]) violations.push('too_long')
  if (!input.evidenceSnapshotId) violations.push('no_cited_fact')
  if (input.stage === 'first_touch' && input.channel === 'dm' && LINK.test(body)) {
    violations.push('link_in_first_touch')
  }
  return violations
}

export function pickLanguage(country: 'AU' | 'VN', sample: string): 'en' | 'vi' {
  if (country === 'VN') return 'vi'
  const text = sample ?? ''
  const vietnameseHits = (text.match(VIETNAMESE) ?? []).length
  const latinWords = (text.match(LATIN_WORD) ?? []).length
  return vietnameseHits >= 3 && vietnameseHits > latinWords / 2 ? 'vi' : 'en'
}
