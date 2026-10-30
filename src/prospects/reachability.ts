import type { Reachability } from './score'

// Reachability is how the first message can actually reach the business, not
// what the platform is called: a social profile is a DM, a website is a contact
// form, email is email. Every other platform (youtube included) is a form, and
// an unknown or missing channel is `none` rather than a hopeful guess — `none`
// scores the floor in score.ts.
const REACHABILITY_BY_PLATFORM: Record<string, Reachability> = {
  email: 'email',
  instagram: 'dm',
  tiktok: 'dm',
  facebook: 'dm',
  shopee: 'dm',
  linkedin: 'linkedin',
  youtube: 'form',
  website: 'form',
}

export function reachabilityFor(platform: string | null): Reachability {
  if (!platform) return 'none'
  return REACHABILITY_BY_PLATFORM[platform] ?? 'none'
}
