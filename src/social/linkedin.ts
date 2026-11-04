// src/social/linkedin.ts
// LinkedIn post creation through the ugcPosts REST endpoint. Messaging and
// InMail are partner-gated and deliberately absent; a member or organization
// text post with the w_member_social (or w_organization_social) scope is the
// surface any approved LinkedIn app can call. The author URN decides member vs
// organization, which is why it is config rather than tool input.

import type { CrumEnv } from '../config/env'

const LINKEDIN_API_ROOT = 'https://api.linkedin.com'

export class LinkedInError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'LinkedInError'
    this.status = status
  }
}

export interface LinkedInConfig {
  accessToken: string
  authorUrn: string
}

export function linkedinConfigured(env: CrumEnv): LinkedInConfig | null {
  if (!env.CRUM_LINKEDIN_ACCESS_TOKEN || !env.CRUM_LINKEDIN_AUTHOR_URN) return null
  return {
    accessToken: env.CRUM_LINKEDIN_ACCESS_TOKEN,
    authorUrn: env.CRUM_LINKEDIN_AUTHOR_URN,
  }
}

export interface LinkedInPostResult {
  postId: string
}

export async function createLinkedInPost(config: LinkedInConfig, post: { text: string }): Promise<LinkedInPostResult> {
  // An author URN looks like urn:li:person:xxxx or urn:li:organization:123456.
  // Shape-checked because it is interpolated into the request body's author
  // field; a malformed value would otherwise round-trip to LinkedIn as a
  // confusing 422 instead of a config error named here.
  if (!/^urn:li:(person|organization):[\w-]{1,64}$/.test(config.authorUrn)) {
    throw new LinkedInError(
      'CRUM_LINKEDIN_AUTHOR_URN must look like urn:li:person:<id> or urn:li:organization:<id>',
      400,
    )
  }

  const res = await fetch(`${LINKEDIN_API_ROOT}/v2/ugcPosts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: config.authorUrn,
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: post.text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility:
        config.authorUrn.startsWith('urn:li:person:')
          ? { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
          : { 'com.linkedin.ugc.OrganizationNetworkVisibility': 'PUBLIC' },
    }),
  })

  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string; status?: number }
  if (!res.ok || !json.id) {
    throw new LinkedInError(
      `linkedin ugcPosts.create failed: ${json.message ?? `HTTP ${res.status}`}`,
      res.status,
    )
  }
  return { postId: json.id }
}
