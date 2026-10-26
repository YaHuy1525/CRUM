import { jwtVerify, createRemoteJWKSet } from 'jose'
import type { CrumEnv } from '../config/env'
import { TenantRequestContextSchema, type TenantRequestContext } from './tenant-context'

export class IdentityError extends Error {
  readonly reason: IdentityRejectReason

  constructor(reason: IdentityRejectReason, message: string) {
    super(message)
    this.name = 'IdentityError'
    this.reason = reason
  }
}

export type IdentityRejectReason =
  | 'missing-claim'
  | 'invalid-claim'
  | 'missing-token'
  | 'jwks-unconfigured'
  | 'token-verification-failed'

export type HeaderReader = (name: string) => string | undefined

export interface VerifiedClaims {
  tenantId?: unknown
  userId?: unknown
  userRole?: unknown
}

export interface IdentityDeps {
  verifyJwt?: (token: string, env: CrumEnv) => Promise<VerifiedClaims>
}

const DEV_TENANT_HEADER = 'x-tenant-id'
const DEV_USER_HEADER = 'x-user-id'
const DEV_ROLE_HEADER = 'x-user-role'

export async function resolveIdentity(
  headers: HeaderReader,
  env: CrumEnv,
  deps: IdentityDeps = {},
): Promise<TenantRequestContext> {
  const candidate =
    env.CRUM_AUTH_MODE === 'jwt'
      ? await claimsFromJwt(headers, env, deps.verifyJwt ?? defaultVerifyJwt)
      : claimsFromDevHeaders(headers)

  return validateContext(candidate)
}

function claimsFromDevHeaders(headers: HeaderReader): Record<string, unknown> {
  return {
    tenantId: headers(DEV_TENANT_HEADER),
    userId: headers(DEV_USER_HEADER),
    userRole: headers(DEV_ROLE_HEADER),
  }
}

async function claimsFromJwt(
  headers: HeaderReader,
  env: CrumEnv,
  verify: NonNullable<IdentityDeps['verifyJwt']>,
): Promise<Record<string, unknown>> {
  const auth = headers('authorization')
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    throw new IdentityError('missing-token', 'jwt mode requires an Authorization: Bearer token.')
  }
  if (!env.SUPABASE_JWKS_URL) {
    throw new IdentityError(
      'jwks-unconfigured',
      'CRUM_AUTH_MODE="jwt" requires SUPABASE_JWKS_URL to verify the token signature (§13.2).',
    )
  }

  const token = auth.replace(/^Bearer\s+/i, '').trim()
  let claims: VerifiedClaims
  try {
    claims = await verify(token, env)
  } catch {
    throw new IdentityError('token-verification-failed', 'The bearer token could not be verified.')
  }

  return {
    tenantId: claims.tenantId,
    userId: claims.userId,
    userRole: claims.userRole,
  }
}

function validateContext(candidate: Record<string, unknown>): TenantRequestContext {
  const parsed = TenantRequestContextSchema.safeParse(candidate)
  if (parsed.success) return parsed.data

  const allMissing = parsed.error.issues.every((issue) => issue.code === 'invalid_type' && issue.input === undefined)
  throw new IdentityError(
    allMissing ? 'missing-claim' : 'invalid-claim',
    `Identity claims failed validation: ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`,
  )
}

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined
let cachedJwksUrl: string | undefined

const defaultVerifyJwt: NonNullable<IdentityDeps['verifyJwt']> = async (token, env) => {
  const url = env.SUPABASE_JWKS_URL
  if (!url) throw new IdentityError('jwks-unconfigured', 'SUPABASE_JWKS_URL is not set.')
  if (cachedJwksUrl !== url) {
    cachedJwks = createRemoteJWKSet(new URL(url))
    cachedJwksUrl = url
  }
  const { payload } = await jwtVerify(token, cachedJwks!)
  return claimsFromSupabasePayload(payload)
}

export function claimsFromSupabasePayload(payload: Record<string, unknown>): VerifiedClaims {
  const appMeta = (payload.app_metadata ?? {}) as Record<string, unknown>
  return {
    tenantId: payload.tenant_id ?? appMeta.tenant_id,
    userId: payload.sub,
    userRole: payload.user_role ?? appMeta.role,
  }
}
