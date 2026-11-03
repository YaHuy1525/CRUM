import type { PoolClient } from 'pg'

export const CHANGE_SOURCES = ['extraction', 'manual_correction', 're-parse', 'import', 'system'] as const

export interface AuditContext {
  userId: string | null
  changeSource: (typeof CHANGE_SOURCES)[number]
}

/**
 * The third argument to set_config is the transaction-local flag. A session-scoped
 * setting survives client.release() and is still set when the pool hands that
 * physical connection to a later request, which attributes that request's writes to
 * this actor. The caller must already be inside a transaction.
 */
export async function setAuditContext(client: PoolClient, context: AuditContext): Promise<void> {
  if (context.userId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', context.userId])
  }
  await client.query('SELECT set_config($1, $2, true)', ['app.change_source', context.changeSource])
}
