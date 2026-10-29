import { z } from 'zod'

/**
 * Typed extraction targets for the Phase 4 sponsorship scanner. Mirrors the
 * documents extract schemas: every field is optional (the model returns only
 * what is literally present), money and dates stay strings so the model never
 * has to commit to a numeric/temporal parse, and `confidence` is the model's
 * own 0..1 self-report that the intake workflow blends with field coverage.
 */
export const sponsorshipExtractSchema = z.object({
  brandName: z.string().optional(),
  brandEmail: z.string().optional(),
  dealType: z.enum(['flat', 'cpm', 'rev_share', 'gift', 'affiliate', 'other']).optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  dealDate: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  channelHint: z.string().optional(),
  platform: z.enum(['youtube', 'tiktok', 'instagram', 'twitch']).optional(),
  notes: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export type SponsorshipExtract = z.infer<typeof sponsorshipExtractSchema>

/**
 * The weak/ambiguous branch of the detect step: when the keyword heuristic is
 * not decisive, a single agent call answers whether the message is sponsorship
 * at all before we pay for a full extraction.
 */
export const sponsorshipDetectSchema = z.object({
  isSponsorship: z.boolean(),
  confidence: z.number().min(0).max(1),
})

export type SponsorshipDetect = z.infer<typeof sponsorshipDetectSchema>
