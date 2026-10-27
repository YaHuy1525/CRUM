// Scratch: is a message row keyed by id alone, so a reused id moves it between threads?
const { Pool } = require('pg')

;(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  const pk = await p.query(
    "select kcu.column_name, tc.constraint_type from information_schema.table_constraints tc " +
      "join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name " +
      "where tc.table_name = 'mastra_messages'",
  )
  console.log('constraints ' + JSON.stringify(pk.rows))
  const rows = await p.query(
    "select id, thread_id, role, left(content::text, 60) as head from public.mastra_messages where id = 'msg-1'",
  )
  console.log('msg-1 rows ' + JSON.stringify(rows.rows, null, 1))
  const total = await p.query(
    'select count(*)::int as n, count(distinct id)::int as distinct_ids from public.mastra_messages',
  )
  console.log('totals ' + JSON.stringify(total.rows))
  await p.end()
})()
