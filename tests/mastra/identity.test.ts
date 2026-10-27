import { describe, it, expect, vi } from 'vitest'
import { parseEnv } from '../../src/config/env'
import {
  resolveIdentity,
  IdentityError,
  claimsFromSupabasePayload,
  type HeaderReader,
} from '../../src/mastra/identity'

const TENANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ADMIN = '9b2f1c3a-5d6e-4f70-8a9b-1c2d3e4f5a6b'

function headers(map: Record<string, string>): HeaderReader {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v
  return (name) => lower[name.toLowerCase()]
}

const devEnv = parseEnv({ NODE_ENV: 'test' })
const jwtEnv = parseEnv({
  NODE_ENV: 'test',
  CRUM_AUTH_MODE: 'jwt',
  SUPABASE_JWKS_URL: 'https://project.supabase.co/.well-known/jwks.json',
})

describe('resolveIdentity — dev mode', () => {
  it('builds a context from the three trusted headers', async () => {
    const id = await resolveIdentity(
      headers({ 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }),
      devEnv,
    )
    expect(id).toEqual({ tenantId: TENANT, userId: USER, userRole: 'user' })
  })

  it('accepts the admin role', async () => {
    const id = await resolveIdentity(
      headers({ 'x-tenant-id': TENANT, 'x-user-id': ADMIN, 'x-user-role': 'admin' }),
      devEnv,
    )
    expect(id.userRole).toBe('admin')
  })

  it('rejects a missing tenant claim with no default (§13.2)', async () => {
    await expect(
      resolveIdentity(headers({ 'x-user-id': USER, 'x-user-role': 'user' }), devEnv),
    ).rejects.toThrowError(IdentityError)
  })

  it('rejects a malformed UUID', async () => {
    await expect(
      resolveIdentity(
        headers({ 'x-tenant-id': 'not-a-uuid', 'x-user-id': USER, 'x-user-role': 'user' }),
        devEnv,
      ),
    ).rejects.toMatchObject({ reason: 'invalid-claim' })
  })

  it('rejects an unknown role', async () => {
    await expect(
      resolveIdentity(
        headers({ 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'superuser' }),
        devEnv,
      ),
    ).rejects.toThrowError(IdentityError)
  })
})

describe('resolveIdentity — jwt mode', () => {
  it('derives the context from the verified token, ignoring browser headers', async () => {
    const verify = vi.fn().mockResolvedValue({ tenantId: TENANT, userId: USER, userRole: 'admin' })
    const id = await resolveIdentity(
      // x-tenant-id is a different, forged value — it must NOT win over the token.
      headers({ authorization: 'Bearer signed.token.value', 'x-tenant-id': 'forged-forgery' }),
      jwtEnv,
      { verifyJwt: verify },
    )
    expect(id).toEqual({ tenantId: TENANT, userId: USER, userRole: 'admin' })
    expect(verify).toHaveBeenCalledWith('signed.token.value', jwtEnv)
  })

  it('rejects when there is no bearer token', async () => {
    await expect(
      resolveIdentity(headers({ 'x-tenant-id': TENANT }), jwtEnv, {
        verifyJwt: vi.fn(),
      }),
    ).rejects.toMatchObject({ reason: 'missing-token' })
  })

  it('fails closed when SUPABASE_JWKS_URL is unset', async () => {
    const noJwks = parseEnv({ NODE_ENV: 'test', CRUM_AUTH_MODE: 'jwt' })
    await expect(
      resolveIdentity(headers({ authorization: 'Bearer a.b.c' }), noJwks, {
        verifyJwt: vi.fn(),
      }),
    ).rejects.toMatchObject({ reason: 'jwks-unconfigured' })
  })

  it('maps a verification failure to a generic rejection without leaking the cause', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('JWSFailed: token expired at ...'))
    let thrown: unknown
    try {
      await resolveIdentity(headers({ authorization: 'Bearer a.b.c' }), jwtEnv, { verifyJwt: verify })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(IdentityError)
    const err = thrown as IdentityError
    expect(err.reason).toBe('token-verification-failed')
    expect(err.message).not.toContain('expired')
  })

  it('rejects a token whose payload omits a required claim', async () => {
    const verify = vi.fn().mockResolvedValue({ userId: USER, userRole: 'user' })
    await expect(
      resolveIdentity(headers({ authorization: 'Bearer a.b.c' }), jwtEnv, { verifyJwt: verify }),
    ).rejects.toMatchObject({ reason: 'missing-claim' })
  })
})

describe('claimsFromSupabasePayload', () => {
  it('reads top-level tenant_id, sub, and app_metadata.role', () => {
    expect(
      claimsFromSupabasePayload({
        sub: USER,
        tenant_id: TENANT,
        app_metadata: { role: 'admin' },
      }),
    ).toEqual({ tenantId: TENANT, userId: USER, userRole: 'admin' })
  })

  it('leaves absent claims undefined so validation rejects them', () => {
    expect(claimsFromSupabasePayload({ sub: USER })).toEqual({
      tenantId: undefined,
      userId: USER,
      userRole: undefined,
    })
  })
})
