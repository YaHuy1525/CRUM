import type { CrumEnv } from '../config/env'

/**
 * The two model ids every CRUM agent uses (§4.3.1).
 *
 * Only OPENROUTER is configured with credentials, so the defaults are the two
 * verified OpenRouter ids that need no other provider key. They are intentionally
 * provider-prefixed (`openrouter/...`) and independent of any secret: a laptop
 * with just `OPENROUTER_API_KEY` boots the whole stack.
 *
 * `CRUM_MAIN_MODEL` drives the conversational agent and its goal judge;
 * `CRUM_LIGHT_MODEL` drives the short, structured subagents (parser). A stronger
 * or cheaper model is selected with `CRUM_MODEL_MAIN` / `CRUM_MODEL_LIGHT`.
 */
export const DEFAULT_MAIN_MODEL = 'openrouter/openrouter/free'
export const DEFAULT_LIGHT_MODEL = 'openrouter/xingchen-agi/xing4.0-29b-a4b:free'

/**
 * Pure resolver used wherever an env object is already in hand (createCrumMastra,
 * tests). Empty-string and whitespace are treated as unset, matching the
 * `optionalString` transform in `config/env.ts`.
 */
export function resolveModelIds(env: CrumEnv): { main: string; light: string } {
  return {
    main: clean(env.CRUM_MODEL_MAIN) ?? DEFAULT_MAIN_MODEL,
    light: clean(env.CRUM_MODEL_LIGHT) ?? DEFAULT_LIGHT_MODEL,
  }
}

/**
 * Module-load defaults for `agent.ts`, which constructs its `Agent` and
 * subagent definitions at import time before any parsed env is threaded in.
 * Reading the raw process variables here (rather than calling `parseEnv`) keeps
 * this module free of schema-validation side effects, so importing the agent in
 * a test never throws on an unrelated malformed variable.
 */
function fromProcess(): { main: string; light: string } {
  return {
    main: clean(process.env.CRUM_MODEL_MAIN) ?? DEFAULT_MAIN_MODEL,
    light: clean(process.env.CRUM_MODEL_LIGHT) ?? DEFAULT_LIGHT_MODEL,
  }
}

const processModels = fromProcess()

/** Model id for the main agent, its goal judge, and any write/approval path. */
export const CRUM_MAIN_MODEL: string = processModels.main
/** Model id for the lightweight, single-step subagents. */
export const CRUM_LIGHT_MODEL: string = processModels.light

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
