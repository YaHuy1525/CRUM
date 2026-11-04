import type { TenantRequestContext } from '../mastra/tenant-context'

/**
 * The one document-visibility rule, as a leaf module (ruling R62).
 *
 * `src/db/documents.ts:3` imports `Q` from `./validation`, so `validation.ts` cannot
 * import a value back out of `documents.ts` without closing the cycle R57 refused for
 * the same reason. The rule is needed on both sides — every document read in
 * `documents.ts` and the review-queue membership SQL — so it lives here, with no
 * runtime dependency on either storage module.
 *
 * A `user` sees their own documents, documents linked to no customer at all, and
 * documents whose customer they own or share. An `admin` sees the whole tenant. The
 * params align with the `$1`/`$2` placeholders the callers use: `$1` is the tenant in
 * both branches, so a caller may keep literal `$1` references in its own SQL and bind
 * everything else by derivation from `params.length`.
 */
export function docVisibility(context: TenantRequestContext): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'd.tenant_id = $1', params: [context.tenantId] }
  }
  return {
    sql: `d.tenant_id = $1 AND (
            d.owner_id = $2
            OR d.customer_id IS NULL
            OR d.customer_id IN (
              SELECT id FROM customers
               WHERE tenant_id = $1 AND deleted_at IS NULL
                 AND (owner_id = $2 OR $2 = ANY(team_member_ids))
            )
          )`,
    params: [context.tenantId, context.userId],
  }
}
