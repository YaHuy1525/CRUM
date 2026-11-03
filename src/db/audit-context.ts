import { getDbClient } from './client.js'

export interface AuditContext {
  userId: string | null
  changeSource: 'extraction' | 'manual_correction' | 're_parse' | 'import' | 'system'
}

export async function setAuditContext(context: AuditContext): Promise<void> {
  const client = getDbClient()
  if (context.userId) {
    await client.query('SELECT set_config($1, $2, false)', ['app.current_user_id', context.userId])
  }
  await client.query('SELECT set_config($1, $2, false)', ['app.change_source', context.changeSource])
}
