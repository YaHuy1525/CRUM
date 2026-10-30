import { describe, expect, it, vi } from 'vitest'
import { analysePage } from '../../../src/prospects/enrich'

const base = { url: 'https://example.com/', platform: 'website', country: 'AU' as const }

describe('analysePage', () => {
  it('detects a funnel and an email capture on a course page', () => {
    const html = '<form><input type="email" name="email"></form><a href="/webinar">Join the free challenge</a><p>Book a call for $2,100</p>'
    const result = analysePage({ ...base, html })
    expect(result.hasEmailCapture).toBe(true)
    expect(result.hasFunnel).toBe(true)
    expect(result.priceVisible).toBe(true)
    expect(result.priceMinMinor).toBe(210000)
    expect(result.weaknessSignals).not.toContain('no_funnel')
  })

  it('flags a bare link-in-bio page as a weak funnel', () => {
    const result = analysePage({ ...base, platform: 'instagram', url: 'https://linktr.ee/someone', html: '<p>DM me to work together</p>' })
    expect(result.weaknessSignals).toContain('no_website')
    expect(result.weaknessSignals).toContain('no_lead_magnet')
    expect(result.weaknessSignals).toContain('no_email_capture')
    expect(result.weaknessSignals).toContain('no_funnel')
    expect(result.weaknessSignals).toContain('dm_only_sales')
  })

  it('detects a Vietnamese lead magnet and registration page', () => {
    const html = '<p>Tải ebook miễn phí</p><a href="/dang-ky">Đăng ký khoá học</a><span>2.900.000đ</span>'
    const result = analysePage({ ...base, country: 'VN', html, url: 'https://vidu.vn/' })
    expect(result.hasLeadMagnet).toBe(true)
    expect(result.hasFunnel).toBe(true)
    expect(result.currency).toBe('VND')
    expect(result.priceMinMinor).toBe(2900000)
  })

  it('treats a website platform as having a website', () => {
    const result = analysePage({ ...base, html: '<p>hello</p>' })
    expect(result.weaknessSignals).not.toContain('no_website')
    expect(result.hasWebsite).toBe(true)
  })

  it('counts a booking call to action as a funnel even without campaign wording', () => {
    const html = '<a href="/book-a-call">Book a free strategy call</a><p>1:1 coaching</p>'
    const result = analysePage({ ...base, html })
    expect(result.hasFunnel).toBe(true)
    expect(result.weaknessSignals).not.toContain('no_funnel')
  })

  it('does not treat a social profile as a website', () => {
    const result = analysePage({ ...base, platform: 'instagram', url: 'https://instagram.com/someone', html: '<p>Download my free guide</p>' })
    expect(result.hasWebsite).toBe(false)
    expect(result.hasLeadMagnet).toBe(true)
    expect(result.weaknessSignals).toContain('no_website')
    expect(result.weaknessSignals).not.toContain('no_lead_magnet')
  })

  it('keeps pricing hidden when only an enquiry is offered', () => {
    const result = analysePage({ ...base, html: '<p>Coaching program. Enquire for pricing.</p>' })
    expect(result.priceVisible).toBe(false)
    expect(result.priceMinMinor).toBeNull()
    expect(result.weaknessSignals).toContain('pricing_hidden')
  })

  it('keeps VND in whole dong and never scales it by 100', () => {
    const result = analysePage({ ...base, country: 'VN', html: '<p>Đầu tư 2.900.000đ cho khoá học</p>' })
    expect(result.currency).toBe('VND')
    expect(result.priceMinMinor).toBe(2900000)
    expect(result.priceMaxMinor).toBe(2900000)
    expect(result.priceMinMinor).not.toBe(290000000)
  })

  it('reads a spaced VND marker as whole dong too', () => {
    const result = analysePage({ ...base, country: 'VN', html: '<p>Học phí 2.900.000 VNĐ</p>' })
    expect(result.currency).toBe('VND')
    expect(result.priceMinMinor).toBe(2900000)
  })

  it('reads an AUD amount written with a word marker', () => {
    const result = analysePage({ ...base, html: '<p>The program costs AUD 2,100</p>' })
    expect(result.currency).toBe('AUD')
    expect(result.priceMinMinor).toBe(210000)
  })

  it('never fetches: the page is supplied as a string', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    try {
      analysePage({ ...base, html: '<p>hello</p>' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
