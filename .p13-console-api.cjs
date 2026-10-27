// Scratch: exercise the console's chat API routes over HTTP (client-hydrated transcript).
// Usage: node .p13-console-api.cjs <threadId>
const base = 'http://127.0.0.1:3100'
const threadId = process.argv[2]

const get = async (path) => {
  try {
    const res = await fetch(base + path)
    const text = await res.text()
    console.log(`${path} -> ${res.status} ${text.slice(0, 240).replace(/\s+/g, ' ')}`)
    return { status: res.status, text }
  } catch (err) {
    console.log(`${path} -> ERR ${err.message}`)
    return { status: 0, text: '' }
  }
}

;(async () => {
  await get('/api/agent/threads')
  await get(`/api/agent/threads/${threadId}`)
  await get(`/api/agent/threads/${threadId}/messages?page=1&perPage=50`)
})()
