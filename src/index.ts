// src/index.ts
import { mastra } from './mastra'

/**
 * Compatibility re-export of the process singleton, kept because Phase 1 named
 * this file the entry point (`docs/superpowers/plans/2026-10-23-phase-1-harness.md`
 * task 1) and a reader landing here should find the same instance the server uses.
 *
 * It is not what `mastra dev` or `mastra build` run. Those resolve
 * `src/mastra/index.ts` as the entry file (the CLI's default `--dir`), so the
 * boot side effects — the digest schedule and the `/api` REST plane — live in
 * that module and in `src/mastra/boot.ts`. Anything added here would be silently
 * skipped by the server the framework starts; that is the whole reason this file
 * is a re-export rather than sixty lines of boot code.
 *
 * Importing it does construct the singleton and, outside `test`, boot the
 * process, because that happens in the module being re-exported. What it does
 * *not* do is start the Mastra HTTP server itself — no CLI, no chat lane. Use
 * `npm run dev` for that.
 */
export { mastra }

export default mastra
