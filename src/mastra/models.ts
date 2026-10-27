import type { CrumEnv } from '../config/env'

export const DEFAULT_MAIN_MODEL = 'openrouter/openrouter/free'
export const DEFAULT_LIGHT_MODEL = 'openrouter/xingchen-agi/xing4.0-29b-a4b:free'

export function resolveModelIds(env: CrumEnv): { main: string; light: string } {
  return {
    main: clean(env.CRUM_MODEL_MAIN) ?? DEFAULT_MAIN_MODEL,
    light: clean(env.CRUM_MODEL_LIGHT) ?? DEFAULT_LIGHT_MODEL,
  }
}

function fromProcess(): { main: string; light: string } {
  return {
    main: clean(process.env.CRUM_MODEL_MAIN) ?? DEFAULT_MAIN_MODEL,
    light: clean(process.env.CRUM_MODEL_LIGHT) ?? DEFAULT_LIGHT_MODEL,
  }
}

const processModels = fromProcess()

export const CRUM_MAIN_MODEL: string = processModels.main
export const CRUM_LIGHT_MODEL: string = processModels.light

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
