/**
 * The Meta Ads lane: its config read and its registration in this process.
 *
 * Two scripts need this, and they need the same answer. The analyst cron
 * (`scripts/analyst-cron.ts`) stages a status change whose executability guard asks
 * whether the current process can run the action at all, and the publisher
 * (`scripts/publish-drain.ts`) is the process that runs the queued Meta actions the
 * approvals produce. The adapter map is per process (`src/marketing/outbox.ts:70`,
 * read by `isExecutable` at `:81` and by the drainer's own lookup at `:91`), so a
 * deployment whose two entrypoints parse the same settings differently yields
 * refusals that cannot be reproduced from the host's environment. That is the whole
 * reason one module holds both halves.
 *
 * Boot is deliberately not a caller. `src/mastra/index.ts:158` keeps its own inline
 * parse because it interleaves a once-per-change log, and
 * `tests/mastra/marketing-boot.test.ts:54` pins the parse warning that log emits, so
 * folding boot in here would move a pinned message without moving the thing the test
 * is actually about. The third copy is real duplication and is parked for the final
 * review rather than papered over by a helper with two callers.
 */

import { makeCreateCampaignAdapter, makeSetCampaignStatusAdapter, type MetaAdsConfig } from './meta-ads'
import { registerActionAdapter } from './outbox'

/**
 * The two settings the lane reads, declared as a subset so a caller can hand over
 * the whole parsed environment without the module claiming the rest of it.
 */
export interface MetaLaneEnv {
  CRUM_META_ADS_ACCESS_TOKEN?: string | undefined
  CRUM_META_AD_ACCOUNTS?: string | undefined
}

/**
 * Read the Meta Ads lane, or answer null when it is not configured.
 *
 * Both halves or neither: a token with no ad account list would produce an adapter
 * that refuses every campaign it is handed, which is a worse outcome than not
 * registering an adapter and letting the executability guard say so honestly. An
 * empty list is treated the same way, because `[]` parses cleanly and still admits
 * no account.
 *
 * A missing half is silence, and a broken half is a warning naming the key and the
 * caller: "not configured" is a normal state for a host that does not run this lane,
 * while "configured badly" is a defect someone has to find. `label` exists so the
 * publisher and the cron can be told apart in a shared log.
 */
export function metaAdsConfigFromEnv(env: MetaLaneEnv, label: string): MetaAdsConfig | null {
  const accessToken = env.CRUM_META_ADS_ACCESS_TOKEN
  const raw = env.CRUM_META_AD_ACCOUNTS
  if (!accessToken || !raw) return null

  let adAccounts: string[]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((account) => typeof account === 'string')) {
      throw new Error('CRUM_META_AD_ACCOUNTS must be a JSON array of strings')
    }
    adAccounts = parsed
  } catch (err) {
    console.warn(
      `[${label}] Failed to parse CRUM_META_AD_ACCOUNTS:`,
      err instanceof Error ? err.message : String(err),
    )
    return null
  }

  return adAccounts.length > 0 ? { accessToken, adAccounts } : null
}

/**
 * Register the lane's two adapters in this process, and return the closures that
 * undo exactly that.
 *
 * Both together, not one each: boot maps the pair (`src/mastra/index.ts:174-175`),
 * and a drainer that could run a status change but not a campaign creation would
 * leave `create_campaign` rows queued behind status rows it had already drained,
 * which reads to an owner as a lane that works sometimes.
 *
 * The return is a list rather than a boolean because `registerActionAdapter` hands
 * back an unregister function precisely so a caller can put the map back as it found
 * it (`src/marketing/outbox.ts:74-79`), and a caller that discards them cannot. An
 * empty list means nothing was registered, which is what a caller tests to decide
 * whether to warn.
 */
export function registerMetaLane(env: MetaLaneEnv, label: string): Array<() => void> {
  const config = metaAdsConfigFromEnv(env, label)
  if (!config) return []
  return [
    registerActionAdapter(makeCreateCampaignAdapter(config)),
    registerActionAdapter(makeSetCampaignStatusAdapter(config)),
  ]
}
