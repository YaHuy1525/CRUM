// Scratch harness with per-part timing. Not part of the build.
// Usage: node .p10-turn2.cjs <bodyFile> <outBase>
const { randomUUID } = require('node:crypto')

const [bodyFile, outBase] = process.argv.slice(2)
const origin = process.env.CRUM_VERIFY_ORIGIN ?? 'http://127.0.0.1:4211'
const threadId = randomUUID()

const run = async () => {
  const fs = require('node:fs')
  const body = fs.readFileSync(bodyFile, 'utf8')
  const t0 = Date.now()
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7)
  const res = await fetch(`${origin}/chat/crm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-thread-id': threadId,
      'x-tenant-id': '4fc9d503-7095-38fb-8bc9-f01dbdffe5f2',
      'x-user-id': '97fb4fe1-83ed-311b-9c66-80dd388fff3b',
      'x-user-role': 'admin',
    },
    body,
  })
  console.log(`thread=${threadId} status=${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let textChars = 0
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') {
        if (payload === '[DONE]') console.log(`${stamp()} DONE`)
        continue
      }
      let evt
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      events.push(evt.type)
      if (evt.type === 'text-delta') textChars += (evt.delta ?? '').length
      if (evt.type !== 'text-delta' || events.length % 200 === 0) {
        console.log(`${stamp()} ${evt.type}${evt.toolName ? ' ' + evt.toolName : ''}${evt.finishReason ? ' ' + evt.finishReason : ''}`)
      }
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const tally = {}
  for (const e of events) tally[e] = (tally[e] ?? 0) + 1
  const summary = `secs=${secs} textChars=${textChars} ` + Object.entries(tally)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  fs.writeFileSync(`${outBase}.timing.txt`, summary + '\n')
  console.log(summary)
}

run().catch((err) => {
  console.log(`thread=${threadId} ERR ${err.message}`)
  process.exitCode = 1
})
