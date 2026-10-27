// Scratch latency probe for the guardrail route. Not part of the build.
// Usage: node --env-file=.env .p10-lat.cjs
const models = [
  process.env.CRUM_MODEL_MAIN?.replace(/^openrouter\//, ''),
  process.env.CRUM_MODEL_LIGHT?.replace(/^openrouter\//, ''),
].filter(Boolean)

const INSTRUCTIONS =
  'You are a content moderator. Respond with JSON only: ' +
  '{"flagged": boolean, "category_scores": [{"category": string, "score": number}], "reason": string}. ' +
  'Categories: hate, harassment, violence.'

const SAMPLE =
  'Here is what is on your plate today. Acme Corp has a follow-up due this afternoon, ' +
  'Nordwind wants the renewal papers sent, and Grace asked for a call on Monday about the Q3 forecast.'

const call = async (model) => {
  const started = Date.now()
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: `${SAMPLE}\n\nClassify the text above.` },
      ],
    }),
  })
  const ms = Date.now() - started
  const text = await res.text()
  return { model, status: res.status, ms, ok: text.slice(0, 60).replace(/\s+/g, ' ') }
}

const main = async () => {
  for (const model of models) {
    for (let i = 0; i < 3; i += 1) {
      const r = await call(model)
      console.log(`${r.model} try=${i + 1} status=${r.status} ms=${r.ms}`)
      if (r.status !== 200) console.log('   body: ' + r.ok)
    }
  }
}

main().catch((err) => {
  console.log('ERR ' + err.message)
  process.exitCode = 1
})
