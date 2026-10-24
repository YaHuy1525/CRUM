import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'

/**
 * Returns the decision model for CRUM's classifiers, or `undefined` when no
 * API key is configured.
 *
 * §6.5.2: returning `undefined` instead of a half-built provider is deliberate.
 * Every consumer then has to state what it does without one. A provider
 * constructed with a missing key does not fail at boot; it fails on the first
 * request, in production, during a customer's turn.
 *
 * Key resolution order: TYPESAFE_AI_API_KEY > JEV_API_KEY. The TypeSafe SDK
 * reads TYPESAFE_AI_API_KEY natively; JEV_API_KEY is the inherited variable
 * from the AllRounderAgent environment (§13.5) and is mapped explicitly.
 */
export function crumDecisionModel() {
  const apiKey = (process.env.TYPESAFE_AI_API_KEY ?? process.env.JEV_API_KEY ?? '').trim()
  if (apiKey === '') return undefined

  const baseURL = process.env.TYPESAFE_AI_BASE_URL?.trim() || undefined
  return createTypeSafeAi({ apiKey, ...(baseURL ? { baseURL } : {}) }).decisionModel('jev-latest')
}
