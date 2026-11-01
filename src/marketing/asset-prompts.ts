// src/marketing/asset-prompts.ts
// The asset pass reads prompts out of the stored creative-designer artifact row
// and never off an agent's arguments, so the shape of that row is a contract
// rather than a suggestion (spec sections 5 and 6 step 2). This module is the one
// place that contract is parsed, and its two refusal reasons are the difference
// between "this bundle has no creative" and "this bundle's creative arrived as
// prose" — which the owner reads as two different next actions.

export interface AssetPrompt {
  name: string
  prompt: string
  aspectRatio: string
  negativePrompt: string | null
}

export type PromptParse =
  | { ok: true; prompts: AssetPrompt[] }
  | { ok: false; reason: 'no_asset_prompts' | 'asset_prompts_unparsable'; detail: string }

function unparsable(detail: string): PromptParse {
  return { ok: false, reason: 'asset_prompts_unparsable', detail }
}

export function parseAssetPrompts(textContent: string | null | undefined): PromptParse {
  if (textContent === null || textContent === undefined || textContent.trim() === '') {
    return {
      ok: false,
      reason: 'no_asset_prompts',
      detail: 'the bundle carries no creative-designer artifact holding asset prompts',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(textContent)
  } catch (err) {
    return unparsable(
      `designer artifact is not JSON (${
        err instanceof Error ? err.message : String(err)
      }), so no money is committed against it`,
    )
  }

  const raw = (parsed as { assets?: unknown }).assets
  if (!Array.isArray(raw) || raw.length === 0) {
    return unparsable('designer artifact JSON has no non-empty "assets" array')
  }

  const prompts: AssetPrompt[] = []
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index] as Record<string, unknown> | null
    // A nameless entry is still salvageable by position; a promptless one is not a
    // payable asset, and paying for five of six because one was malformed is how a
    // bundle ends up with a half-finished media plan and no explanation.
    const name =
      typeof entry?.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : `asset-${index + 1}`
    if (typeof entry?.prompt !== 'string' || entry.prompt.trim() === '') {
      return unparsable(`asset "${name}" has no prompt`)
    }
    prompts.push({
      name,
      prompt: entry.prompt,
      // 'auto' is the model's own default and is in the accepted set, so a designer
      // that omitted the field still gets a render rather than a refusal. A
      // present-but-wrong value is refused by the adapter, which is the layer that
      // knows the set.
      aspectRatio:
        typeof entry.aspectRatio === 'string' && entry.aspectRatio.trim() !== ''
          ? entry.aspectRatio.trim()
          : 'auto',
      negativePrompt:
        typeof entry.negativePrompt === 'string' && entry.negativePrompt.trim() !== ''
          ? entry.negativePrompt.trim()
          : null,
    })
  }

  return { ok: true, prompts }
}
