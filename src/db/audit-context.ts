import { getDbClient } from './client.js'

export interface AuditContext {
  userId: string | null
  changeSource: 'extraction' | 'manual_correction' | 're_parse' | 'import' | 'system'
}

export async function setAuditContext(context: AuditContext): Promise<void> {
  const client = getDbClient()
  if (context.userId) {
    await client.query('SET LOCAL app.current_user_id = $1', [context.userId])
  }
  await client.query('SET LOCAL app.change_source = $1', [context.changeSource])
}
