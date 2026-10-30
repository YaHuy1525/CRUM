import type {
  PlatformAdapter,
  DateRange,
  EarningsData,
  AudienceData,
} from './index'

/**
 * Abstract base class for platform adapters.
 *
 * Provides default implementations that throw "not implemented" so that
 * concrete subclasses only need to override the methods they support.
 * This lets us ship a partial adapter (e.g. earnings-only) without
 * implementing every method up front.
 */
export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: string

  /**
   * Revenue/audience capability defaults. Platforms that structurally cannot
   * expose monetization data through their public API (TikTok, Instagram,
   * Twitch) override `supportsRevenue` to false. The YouTube adapter inherits
   * `true` for both.
   */
  readonly supportsRevenue: boolean = true
  readonly supportsAudienceMetrics: boolean = true

  /**
   * The defaults reject rather than declare `async`: the interface returns a
   * Promise, and there is nothing to await in a method whose only statement is
   * a throw, so eslint's `require-await` flags the `async` keyword. `Promise
   * .reject(...)` gives callers the identical behaviour (awaiting it throws the
   * same Error) without the empty microtask.
   */
  fetchEarnings(_channelId: string, _dateRange: DateRange): Promise<EarningsData> {
    return Promise.reject(new Error(`[${this.platform}] fetchEarnings is not implemented`))
  }

  fetchAudienceMetrics(_channelId: string, _dateRange: DateRange): Promise<AudienceData> {
    return Promise.reject(
      new Error(`[${this.platform}] fetchAudienceMetrics is not implemented`),
    )
  }

  refreshOAuthToken(_tokenId: string): Promise<void> {
    return Promise.reject(new Error(`[${this.platform}] refreshOAuthToken is not implemented`))
  }
}
