import { jwtVerify, createRemoteJWKSet } from 'jose'
import { z } from 'zod'
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

function identityRejection(issues: z.ZodIssue[]): IdentityError {
  const allMissing = issues.every(
    (issue) => issue.code === 'invalid_type' && issue.input === undefined,
  )
  return new IdentityError(
    allMissing ? 'missing-claim' : 'invalid-claim',
    `Identity claims failed validation: ${issues.map((i) => i.path.join('.') || '(root)').join(', ')}`,
  )
}

function validateContext(candidate: Record<string, unknown>): TenantRequestContext {
  const parsed = TenantRequestContextSchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  throw identityRejection(parsed.error.issues)
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

const SocketIdentitySchema = z.object({
  tenantId: z.string().uuid('tenantId must be a valid UUID'),
  userId: z.string().uuid('userId must be a valid UUID'),
})

export type SocketIdentity = z.infer<typeof SocketIdentitySchema>

/**
 * Identity for a WebSocket handshake, which is not an HTTP request: a browser
 * cannot attach `Authorization` or `x-tenant-id` to an upgrade, so the only
 * places identity can come from are the query string and the subprotocol.
 *
 * dev mode reads the query string, the same unverified trust the dev headers
 * already carry (§13.2). jwt mode refuses rather than reading a token off the
 * URL — a bearer token in a query string is a bearer token in every proxy,
 * access log, and browser history between the page and this port, which is a
 * weaker guarantee than the REST plane already gives.
 */
export function resolveSocketIdentity(
  searchParams: URLSearchParams,
  env: CrumEnv,
): SocketIdentity {
  if (env.CRUM_AUTH_MODE === 'jwt') {
    throw new IdentityError(
      'missing-token',
      'The live document lane cannot verify identity on a WebSocket handshake, so it is ' +
        'only served in CRUM_AUTH_MODE="dev". Poll /api/documents/status/:jobId from the ' +
        'bearer-authenticated REST plane instead.',
    )
  }

  const parsed = SocketIdentitySchema.safeParse({
    tenantId: searchParams.get('tenantId') ?? undefined,
    userId: searchParams.get('userId') ?? undefined,
  })
  if (!parsed.success) throw identityRejection(parsed.error.issues)
  return parsed.data
}
