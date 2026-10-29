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
const LINK = /https?:\/\/|www\./i
// The `g` flag is required: `String.match` without it returns only the first
// hit, so the ">= 3 marks" test below would never fire on a real sample.
const VIETNAMESE = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gi
const LATIN_WORD = /\b[a-z]{3,}\b/gi

function countWords(body: string): number {
  return body.trim().split(/\s+/).filter(Boolean).length
}

export function checkDraft(input: DraftInput): DraftViolation[] {
  const violations: DraftViolation[] = []
  const body = input.body ?? ''
  if (body.trim() === '') violations.push('empty')
  if (countWords(body) > WORD_CAP[input.channel]) violations.push('too_long')
  if (input.evidenceSnapshotId === null) violations.push('no_cited_fact')
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
