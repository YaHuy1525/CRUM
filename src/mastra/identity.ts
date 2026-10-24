import { jwtVerify, createRemoteJWKSet } from 'jose'
import type { CrumEnv } from '../config/env'
import { TenantRequestContextSchema, type TenantRequestContext } from './tenant-context'

/**
 * Raised when a request cannot be resolved to a valid tenant identity. The
 * server middleware turns any of these into a `401` and never calls `next()`;
 * there is no path where a failed identity becomes an empty or default context,
 * because that would let a forged request read another tenant's rows (§13.2,
 * §13.8: identity is one of the two fail-closed exceptions).
 */
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

/** A read-only header accessor, e.g. Hono's `c.req.header` bound to the request. */
export type HeaderReader = (name: string) => string | undefined

/** The verified claims `jwt` mode derives a context from. */
export interface VerifiedClaims {
  tenantId?: unknown
  userId?: unknown
  userRole?: unknown
}

/**
 * Injectable so the `jwt` branch is unit-testable without a network round-trip
 * or a live Supabase project. Production leaves this unset and uses the real
 * jose verifier below.
 */
export interface IdentityDeps {
  verifyJwt?: (token: string, env: CrumEnv) => Promise<VerifiedClaims>
}

const DEV_TENANT_HEADER = 'x-tenant-id'
const DEV_USER_HEADER = 'x-user-id'
const DEV_ROLE_HEADER = 'x-user-role'

/**
 * Resolve the caller's tenant identity from a request.
 *
 * - `dev` mode: reads `x-tenant-id`, `x-user-id`, `x-user-role`. Any missing or
 *   malformed claim is rejected — there are no defaults, so a partial header set
 *   never widens scope (§13.2).
 * - `jwt` mode: verifies the `Authorization: Bearer` token against
 *   `SUPABASE_JWKS_URL` and derives claims from the verified payload only;
 *   browser `x-tenant-*` headers are ignored entirely, since in `jwt` mode they
 *   are attacker-controlled. Fails closed if `SUPABASE_JWKS_URL` is unset.
 *
 * In both modes the derived object is validated through
 * `TenantRequestContextSchema` before it is returned, so the schema stays the
 * single authority on what a valid context is.
 */
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
    // Never surface why verification failed (expired, bad signature, unknown
    // kid) to the caller; a generic rejection is enough and avoids oracle leaks.
    throw new IdentityError('token-verification-failed', 'The bearer token could not be verified.')
  }

  // Claims are taken ONLY from the verified token. A token that omits a required
  // claim fails schema validation below rather than defaulting.
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

/**
 * The default jose-backed verifier. JWKS is remote-fetched and cached by jose;
 * we memoize the set per URL so repeated requests do not rebuild it. Signature,
 * `exp`, and algorithm are all enforced by `jwtVerify`.
 */
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

/**
 * Map a verified Supabase JWT payload onto CRUM's identity claims.
 *
 * - `userId` is the authenticated subject (`sub`).
 * - `tenantId` is the Supabase custom claim `tenant_id`, promoted into
 *   `app_metadata.tenant_id` by the auth hook.
 * - `userRole` is `app_metadata.role`.
 *
 * Absent claims are returned as `undefined` so `validateContext` rejects them —
 * this function never substitutes a default (§13.2, fail-closed identity).
 */
export function claimsFromSupabasePayload(payload: Record<string, unknown>): VerifiedClaims {
  const appMeta = (payload.app_metadata ?? {}) as Record<string, unknown>
  return {
    tenantId: payload.tenant_id ?? appMeta.tenant_id,
    userId: payload.sub,
    userRole: payload.user_role ?? appMeta.role,
  }
}
