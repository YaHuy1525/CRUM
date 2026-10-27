import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'

export function crumDecisionModel() {
  const apiKey = (process.env.TYPESAFE_AI_API_KEY ?? process.env.JEV_API_KEY ?? '').trim()
  if (apiKey === '') return undefined

  const baseURL = process.env.TYPESAFE_AI_BASE_URL?.trim() || undefined
  return createTypeSafeAi({ apiKey, ...(baseURL ? { baseURL } : {}) }).decisionModel('jev-latest')
}
