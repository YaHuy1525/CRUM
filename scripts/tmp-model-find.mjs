// Find a model the current OpenRouter key can actually call.
import 'dotenv/config'
const KEY = process.env.OPENROUTER_API_KEY

const candidates = [
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-chat-v3-0324',
  'openrouter/auto',
]

for (const model of candidates) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 10 }),
    })
    const j = await res.json()
    if (res.ok) console.log(`OK   ${model} -> "${(j.choices?.[0]?.message?.content ?? '').slice(0, 40)}"`)
    else console.log(`FAIL ${model} -> ${res.status} ${JSON.stringify(j.error ?? j).slice(0, 140)}`)
  } catch (e) { console.log(`ERR  ${model} -> ${e.message}`) }
}
