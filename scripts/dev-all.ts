// scripts/dev-all.ts
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

/** What `stdio: ['ignore', 'pipe', 'pipe']` actually yields. */
type Spawned = ChildProcessByStdio<null, Readable, Readable>

/**
 * `npm run dev:all` — the whole local stack from one command, so the console
 * (:3000) and the two server planes are never a matter of remembering which
 * terminals to open.
 *
 * Deliberately not a dependency (`concurrently` etc.): this is a dozen lines of
 * process supervision, and a dev-only package bought for it would need pinning,
 * auditing and a lockfile entry. `npm run dev` already serves both server planes
 * from one process (`src/mastra/index.ts`, the entry the Mastra CLI bundles,
 * boots `src/mastra/boot.ts`, which binds the REST plane next to the registry —
 * that co-location is what makes the signal routes able to reach a live session),
 * so the only second thing to run here is the console.
 *
 * Exits with the first child that exits, because a stack with a dead half is
 * worse to debug than a stack that stopped: the surviving half keeps printing,
 * and the interesting error is off the top of the buffer.
 */

interface Target {
  name: string
  command: string
  args: string[]
}

const TARGETS: Target[] = [
  { name: 'server', command: 'npm', args: ['run', 'dev'] },
  { name: 'console', command: 'npm', args: ['run', 'dev:console'] },
]

const children: { child: Spawned; target: Target }[] = []
let shuttingDown = false

/**
 * Stop one target and everything it spawned.
 *
 * `child.kill()` is not enough on Windows: the child is `cmd.exe` running
 * `npm run …`, so signalling it leaves `mastra dev` and `next dev` alive as
 * orphans holding :4111 and :3000 — observed as a stack that would not die.
 * `taskkill /T` walks the tree. If it is unavailable, say so rather than
 * pretending the stop happened.
 */
function stopTree(child: Spawned, name: string): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    if (killed.status === 0) return
    process.stderr.write(`[dev:all] taskkill failed for ${name} (pid ${child.pid}); falling back to a direct signal\n`)
  }
  child.kill('SIGTERM')
}

function stopAll(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child, target } of children) stopTree(child, target.name)
  // Exits rather than only setting `process.exitCode`: the pipes this process
  // holds open to its children keep the event loop running after they are
  // killed, which is exactly how a first run of this script hung.
  process.exit(code)
}

/** Prefix every line so interleaved output is still attributable. */
function forward(child: Spawned, target: Target): void {
  const write = (chunk: unknown): void => {
    const text = String(chunk).replace(/\r?\n$/, '')
    for (const line of text.split(/\r?\n/)) process.stdout.write(`[${target.name}] ${line}\n`)
  }
  const writeErr = (chunk: unknown): void => {
    const text = String(chunk).replace(/\r?\n$/, '')
    for (const line of text.split(/\r?\n/)) process.stderr.write(`[${target.name}] ${line}\n`)
  }
  child.stdout.on('data', write)
  child.stderr.on('data', writeErr)
}

for (const target of TARGETS) {
  // No explicit type argument: the stdio tuple below selects the `spawn` overload
  // that already returns `ChildProcessByStdio<null, Readable, Readable>`.
  const child = spawn(target.command, target.args, {
    // A shell is needed on Windows because `npm` is `npm.cmd`; the npm scripts
    // themselves stay portable.
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  children.push({ child, target })
  forward(child, target)

  // A failed spawn (npm not on PATH, say) never reaches `exit`, so without this
  // the stack would look alive with one half missing.
  child.on('error', (err: Error) => {
    process.stderr.write(`[${target.name}] failed to start: ${err.message}\n`)
    stopAll(1)
  })

  child.on('exit', (code: number | null) => {
    if (code === 0 && !shuttingDown) return
    stopAll(code ?? 1)
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stopAll(0))
}

console.log(`[dev:all] starting ${TARGETS.map((t) => t.name).join(' + ')} — Ctrl-C stops both`)
