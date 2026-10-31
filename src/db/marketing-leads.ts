// src/db/marketing-leads.ts
//
// Inbound lead intake, the only write in CRUM that a stranger can trigger.
// Spec section 7. It creates rows and nothing else: no reply, no draft, no
// outbound lane. The goal text is untrusted input that a later agent may read,
// so it is stored raw and kept out of every memory-injection path.
import { getDbClient } from './client'
import { normalizeName } from '../prospects/normalize'

export interface LeadInput {
  tenantId: string
  bundleId: string
  name: string
  email: string
  country: 'AU' | 'VN'
  budgetBucket: string
  goal: string
  sourceUrl: string
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/** The bundle a published page is serving, found by its stamped credential. */
export async function bundleForLeadToken(
  token: string,
): Promise<{ tenantId: string; bundleId: string; slug: string; servingUrl: string } | null> {
  if (token.length === 0) return null
  const db = getDbClient()
  const result = await db.query<{
    tenant_id: string
    bundle_id: string
    funnel_plan: unknown
    external_id: string | null
    result: Record<string, unknown> | null
  }>(
    // The join on a succeeded action is what makes intake refuse a page that was
    // never published, and the ordering picks the live URL when a promote has
    // happened and the preview URL when it has not.
    `SELECT b.tenant_id, b.id AS bundle_id, b.funnel_plan, a.external_id, a.result
       FROM marketing_bundles b
       JOIN marketing_actions a
         ON a.bundle_id = b.id AND a.action IN ('publish_page','promote_page') AND a.status = 'succeeded'
      WHERE b.lead_token = $1
      ORDER BY a.executed_at DESC
      LIMIT 1`,
    [token],
  )
  const row = result.rows[0]
  if (!row) return null
  const funnel = row.funnel_plan as Record<string, unknown> | null
  const page = funnel?.['page'] as Record<string, unknown> | null
  const slugValue = page?.['slug']
  const urlValue = row.result?.['url']
  const slug = typeof slugValue === 'string' ? slugValue : ''
  const url = typeof urlValue === 'string' ? urlValue : ''
  if (slug === '' || url === '') return null
  return { tenantId: row.tenant_id, bundleId: row.bundle_id, slug, servingUrl: url }
}

export async function countLeadsSince(bundleId: string, sinceIso: string): Promise<number> {
  const db = getDbClient()
  const result = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM marketing_leads WHERE bundle_id = $1 AND created_at >= $2`,
    [bundleId, sinceIso],
  )
  return Number.parseInt(result.rows[0]?.n ?? '0', 10)
}

/**
 * The lead first, then the rows that hang off it. That order is the race fix:
 * 0019's key on (tenant, bundle, normalised email) lets exactly one of two
 * concurrent first submissions return a row, and the loser leaves before it can
 * create a prospect that nothing points at. A duplicate is therefore a lead
 * that already exists, and the row read back carries the winner's prospect.
 *
 * The winner resolves the prospect by the channel's own unique key, so a
 * returning email is one lead and no second prospect. `basis = 'opt_in'` is the
 * honest label: filling in a form on a page is an opt-in to be contacted about
 * that enquiry, which is what 0015's consent primitive exists for.
 */
export async function recordLead(
  lead: LeadInput,
): Promise<{ leadId: string; prospectId: string; duplicate: boolean }> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const email = normalizeEmail(lead.email)

    // Null until the prospect is resolved below; the update lands in this same
    // transaction, so a committed lead never carries a null.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO marketing_leads
         (tenant_id, bundle_id, prospect_id, email, email_normalized, country, budget_bucket, goal, source_url)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, bundle_id, email_normalized) DO NOTHING
       RETURNING id`,
      [lead.tenantId, lead.bundleId, lead.email, email, lead.country, lead.budgetBucket, lead.goal, lead.sourceUrl],
    )
    const leadId = inserted.rows[0]?.id
    if (!leadId) {
      // A repeat, or the loser of a race whose winner has committed by the time
      // the conflicting insert returns. Either way the winner wrote the lead,
      // its prospect, channel and consent, so this transaction reads them and
      // commits with nothing of its own to orphan. A lead that reached COMMIT
      // was completed by its winner, which is why the prospect is set here even
      // though the column allows null.
      const existing = await client.query<{ id: string; prospect_id: string }>(
        `SELECT id, prospect_id FROM marketing_leads
          WHERE tenant_id = $1 AND bundle_id = $2 AND email_normalized = $3`,
        [lead.tenantId, lead.bundleId, email],
      )
      const row = existing.rows[0]!
      await client.query('COMMIT')
      return { leadId: row.id, prospectId: row.prospect_id, duplicate: true }
    }

    const channel = await client.query<{ prospect_id: string }>(
      `SELECT prospect_id FROM prospect_channels
        WHERE tenant_id = $1 AND platform = 'email' AND handle_normalized = $2`,
      [lead.tenantId, email],
    )
    const prospectId = channel.rows[0]?.prospect_id ?? (
      await client.query<{ id: string }>(
        `INSERT INTO prospects (tenant_id, name, name_normalized, country, category, status)
         VALUES ($1, $2, $3, $4, 'marketing lead', 'new')
         RETURNING id`,
        [lead.tenantId, lead.name, normalizeName(lead.name), lead.country],
      )
    ).rows[0]!.id

    await client.query(
      `UPDATE marketing_leads SET prospect_id = $1 WHERE id = $2`,
      [prospectId, leadId],
    )

    await client.query(
      `INSERT INTO prospect_channels (tenant_id, prospect_id, platform, handle, handle_normalized, profile_url)
       VALUES ($1, $2, 'email', $3, $3, $4)
       ON CONFLICT (tenant_id, platform, handle_normalized) DO NOTHING
       RETURNING id`,
      [lead.tenantId, prospectId, email, lead.sourceUrl],
    )

    // Set-once, because prospect_consents keys on the prospect: a second opt-in
    // from a second page must not rewrite the reason the first one arrived.
    await client.query(
      `INSERT INTO prospect_consents (prospect_id, tenant_id, basis, source)
       VALUES ($1, $2, 'opt_in', $3)
       ON CONFLICT (prospect_id) DO NOTHING`,
      [prospectId, lead.tenantId, `bundle:${lead.bundleId}`],
    )

    await client.query('COMMIT')
    return { leadId, prospectId, duplicate: false }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
