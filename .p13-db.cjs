// Scratch: per-thread message roles for the turns just run. Not part of the build.
const { Pool } = require('pg')

const THREADS = ['19e768b6-0a6c-477b-8845-af6d56886930', 'aee33009-c221-4d97-a1e5-0e719429e20d', '83efeb1a-9499-4a5d-ba82-1babc8ee4d5f']

;(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  for (const t of THREADS) {
    const r = await p.query(
      'select role, length(content::text) as bytes, left(content::text, 0) as z ' +
        'from public.mastra_messages where thread_id = $1 order by "createdAt"',
      [t],
    )
    console.log(`${t} -> ${JSON.stringify(r.rows)}`)
    const u = await p.query(
      'select resourceid, threadid, count(*)::int as n from public.mastra_messages where thread_id = $1 group by 1,2',
      [t],
    ).catch((e) => ({ rows: [{ err: String(e.message).slice(0, 80) }] }))
    console.log(`   scope ${JSON.stringify(u.rows)}`)
  }
  await p.end()
})()
