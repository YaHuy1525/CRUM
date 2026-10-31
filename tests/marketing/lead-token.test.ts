import { describe, expect, it } from 'vitest'
import {
  LEAD_ENDPOINT_PLACEHOLDER,
  leadEndpointUrl,
  mintLeadToken,
  stampLeadEndpoint,
} from '@/marketing/lead-token'

describe('mintLeadToken', () => {
  it('is a uuid, because gen_random_uuid() is the database default and a mint must match it', () => {
    expect(mintLeadToken()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('never repeats', () => {
    expect(mintLeadToken()).not.toBe(mintLeadToken())
  })
})

describe('stampLeadEndpoint', () => {
  const endpoint = 'https://api.example.test/api/marketing/leads?t=0f0f0f0f-0000-4000-8000-00000000000f'

  it('replaces the one placeholder with the endpoint', () => {
    const html = `<form action="${LEAD_ENDPOINT_PLACEHOLDER}" method="post"><input name="email"></form>`
    const result = stampLeadEndpoint(html, endpoint)
    expect(result.ok).toBe(true)
    expect(result.ok && result.html).toContain(endpoint)
    expect(result.ok && result.html).not.toContain(LEAD_ENDPOINT_PLACEHOLDER)
  })

  it('refuses a page that promises a form and has no placeholder', () => {
    const result = stampLeadEndpoint('<form action="/nowhere"></form>', endpoint)
    expect(result).toEqual({ ok: false, reason: 'missing_placeholder', count: 0 })
  })

  it('refuses a page with two, because one token behind two forms is a page nobody can reason about', () => {
    const html = `<a href="${LEAD_ENDPOINT_PLACEHOLDER}">x</a><form action="${LEAD_ENDPOINT_PLACEHOLDER}"></form>`
    expect(stampLeadEndpoint(html, endpoint)).toEqual({ ok: false, reason: 'multiple_placeholders', count: 2 })
  })
})

describe('leadEndpointUrl', () => {
  it('is the api origin plus the token as a query parameter', () => {
    expect(leadEndpointUrl('https://api.example.test/', 'TOKEN')).toBe(
      'https://api.example.test/api/marketing/leads?t=TOKEN',
    )
  })

  it('strips a trailing slash exactly once', () => {
    expect(leadEndpointUrl('https://api.example.test///', 'T')).toBe(
      'https://api.example.test/api/marketing/leads?t=T',
    )
  })
})
