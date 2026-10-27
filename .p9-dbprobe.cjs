const { Pool } = require('pg')

const QUERIES = [
  'select id, title, "createdAt", "updatedAt" from public.mastra_threads order by "createdAt" desc limit 4',
  'select thread_id, count(*)::int as n from public.mastra_messages group by thread_id order by max("createdAt") desc limit 4',
  'select role, left(content::text, 300) as c from public.mastra_messages where thread_id = (select id from public.mastra_threads order by "createdAt" desc limit 1) order by "createdAt"',
]

;(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  const sslModes = [false]
  for (const ssl of sslModes) {
    const label = ssl === false ? 'NO-TLS' : 'TLS-VERIFY'
    const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 1, connectionTimeoutMillis: 10000 })
    console.log(`\n===== ${label} =====`)
    try {
      for (const q of QUERIES) {
        try {
          const r = await p.query(q)
          console.log(`-- ${q.slice(0, 70)}`)
          console.log(JSON.stringify(r.rows.slice(0, 6)))
        } catch (err) {
          console.log(`-- ${q.slice(0, 70)}\n   ERR ${err.code || ''} ${String(err.message).slice(0, 90)}`)
        }
      }
    } finally {
      await p.end().catch(() => {})
    }
  }
  await pool.end().catch(() => {})
})()
