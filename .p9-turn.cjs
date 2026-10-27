// Scratch harness for the chat verification. Not part of the build.
// Usage: node --env-file=.env .p9-turn.cjs <bodyFile> <outBase>
const { randomUUID } = require('node:crypto')

const [bodyFile, outBase] = process.argv.slice(2)
const origin = process.env.CRUM_VERIFY_ORIGIN ?? 'http://127.0.0.1:4311'
const threadId = randomUUID()

const run = async () => {
  const fs = require('node:fs')
  const body = fs.readFileSync(bodyFile, 'utf8')
  const started = Date.now()
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
  const text = await res.text()
  const secs = Math.round((Date.now() - started) / 1000)
  fs.writeFileSync(`${outBase}.sse.txt`, text)
  const count = (re) => (text.match(re) ?? []).length
  const summary = [
    `thread=${threadId}`,
    `status=${res.status}`,
    `secs=${secs}`,
    `bytes=${text.length}`,
    `finish=${count(/"type":"finish"/g)}`,
    `deltas=${count(/text-delta/g)}`,
    `toolErr=${count(/tool-output-error/g)}`,
    `invalid=${count(/Invalid input/g)}`,
    `tripwire=${count(/write-claim|tripwire/g)}`,
    `internal=${count(/Internal Server Error/g)}`,
    `errorEvt=${count(/"type":"error"/g)}`,
  ].join(' ')
  fs.writeFileSync(`${outBase}.status.txt`, summary + '\n')
  console.log(summary)
  console.log('TAIL>>> ' + text.slice(-400).replace(/\s+/g, ' '))
}

run().catch((err) => {
  console.log(`thread=${threadId} ERR ${err.message}`)
  process.exitCode = 1
})
