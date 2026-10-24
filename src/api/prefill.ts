import { Hono } from 'hono'
import { parserAgent } from '../mastra/agents/parser'
import { PREFILL_SCHEMAS, type PrefillObjectType } from '../mastra/schemas/prefill'

/**
 * POST /api/crm/prefill/:objectType — structured prefill from pasted text.
 *
 * §6.2: uses `errorStrategy: 'fallback'` so a parse failure returns the
 * fallback value with `usedFallbackValue: true`, which the console maps to
 * an empty form with a "could not parse" notice rather than a 500.
 *
 * `jsonPromptInjection: true` is required for Gemini with tools.
 */
export function createPrefillRouter(): Hono {
  const app = new Hono().basePath('/api/crm/prefill')

  app.post('/:objectType', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const objectType = c.req.param('objectType') as string
    if (!(objectType in PREFILL_SCHEMAS)) {
      return c.json({ error: `Unknown object type: ${objectType}` }, 400)
    }

    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.text !== 'string' || body.text.trim() === '') {
      return c.json({ error: 'text field required' }, 400)
    }

    const schema = PREFILL_SCHEMAS[objectType as PrefillObjectType]
    const fallbackValue = objectType === 'customer' ? { name: '', tags: [] as string[] }
      : objectType === 'contact' ? { firstName: '' }
      : objectType === 'schedule' ? { title: '', attendees: [] as string[] }
      : { title: '' }

    try {
      const result = await parserAgent.generate(body.text, {
        structuredOutput: {
          schema,
          errorStrategy: 'fallback',
          fallbackValue,
        },
        jsonPromptInjection: true,
      })

      return c.json({
        objectType,
        data: result.text,
        usedFallbackValue: result.usedFallbackValue ?? false,
      })
    } catch (err) {
      return c.json({
        objectType,
        data: fallbackValue,
        usedFallbackValue: true,
        error: 'Parse failed, please fill in manually',
      })
    }
  })

  return app
}
