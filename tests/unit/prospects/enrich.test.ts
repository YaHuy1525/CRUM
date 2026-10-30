import { describe, expect, it, vi } from 'vitest'
import { analysePage } from '../../../src/prospects/enrich'

const base = {
  url: 'https://example.com/',
  platform: 'website',
  country: 'AU' as const,
  hasWebsiteChannel: true,
}

// A live page carries body copy; these fixtures are padded with neutral text so
// each test exercises the analyser rather than the unusable-page gate. The copy
// deliberately contains none of the signal vocabulary (no price, no "free", no
// funnel word, no email wording, no DM), so appending it cannot change a
// detection result.
const COPY = (
  '<p>We help small business owners build a steady client base through practical '
  + 'coaching, clear offers and long-term support for their teams.</p>'
).repeat(2)

function page(markup: string): string {
  return markup + COPY
}

describe('analysePage', () => {
  it('detects a funnel and an email capture on a course page', () => {
    const html = page('<form><input type="email" name="email"></form><a href="/webinar">Join the free challenge</a><p>Book a call for $2,100</p>')
    const result = analysePage({ ...base, html })
    expect(result.usable).toBe(true)
    expect(result.hasEmailCapture).toBe(true)
    expect(result.hasFunnel).toBe(true)
    expect(result.priceVisible).toBe(true)
    expect(result.priceMinMinor).toBe(210000)
    expect(result.weaknessSignals).not.toContain('no_funnel')
  })

  it('flags a social-only prospect as a weak funnel', () => {
    const result = analysePage({
      ...base,
      platform: 'instagram',
      url: 'https://linktr.ee/someone',
      hasWebsiteChannel: false,
      html: page('<p>DM me to work together</p>'),
    })
    expect(result.weaknessSignals).toContain('no_website')
    expect(result.weaknessSignals).toContain('no_lead_magnet')
    expect(result.weaknessSignals).toContain('no_email_capture')
    expect(result.weaknessSignals).toContain('no_funnel')
    expect(result.weaknessSignals).toContain('dm_only_sales')
  })

  it('does not treat a footer email signup as a funnel', () => {
    const html = page('<footer><form><input type="email" name="email"><button>Subscribe to our newsletter</button></form></footer><p>Coaching for designers</p>')
    const result = analysePage({ ...base, html })
    expect(result.hasEmailCapture).toBe(true)
    expect(result.hasFunnel).toBe(false)
    expect(result.weaknessSignals).toContain('no_funnel')
  })

  it('detects a Vietnamese lead magnet and course registration page', () => {
    const html = page('<p>Tải ebook miễn phí</p><a href="/webinar">Đăng ký khoá học</a><span>2.900.000đ</span>')
    const result = analysePage({ ...base, country: 'VN', html, url: 'https://vidu.vn/' })
    expect(result.hasLeadMagnet).toBe(true)
    expect(result.hasFunnel).toBe(true)
    expect(result.currency).toBe('VND')
    expect(result.priceMinMinor).toBe(2900000)
  })

  it('treats a website channel as having a website', () => {
    const result = analysePage({ ...base, html: page('<p>hello</p>') })
    expect(result.usable).toBe(true)
    expect(result.weaknessSignals).not.toContain('no_website')
    expect(result.hasWebsite).toBe(true)
  })

  it('keeps hasWebsite true for an Instagram fetch when a website channel exists', () => {
    const result = analysePage({
      ...base,
      platform: 'instagram',
      url: 'https://instagram.com/someone',
      hasWebsiteChannel: true,
      html: page('<p>DM me to work together</p>'),
    })
    expect(result.hasWebsite).toBe(true)
    expect(result.weaknessSignals).not.toContain('no_website')
    expect(result.weaknessSignals).toContain('no_funnel')
  })

  it('does not treat a booking link alone as a funnel', () => {
    const html = page('<a href="/book-a-call">Book a free strategy call</a><p>1:1 coaching</p>')
    const result = analysePage({ ...base, html })
    expect(result.hasFunnel).toBe(false)
    expect(result.weaknessSignals).toContain('no_funnel')
  })

  it('does not treat a social profile as a website', () => {
    const result = analysePage({ ...base, platform: 'instagram', url: 'https://instagram.com/someone', hasWebsiteChannel: false, html: page('<p>Download my free guide</p>') })
    expect(result.hasWebsite).toBe(false)
    expect(result.hasLeadMagnet).toBe(true)
    expect(result.weaknessSignals).toContain('no_website')
    expect(result.weaknessSignals).not.toContain('no_lead_magnet')
  })

  it('keeps pricing hidden when only an enquiry is offered', () => {
    const result = analysePage({ ...base, html: page('<p>Coaching program. Enquire for pricing.</p>') })
    expect(result.priceVisible).toBe(false)
    expect(result.priceMinMinor).toBeNull()
    expect(result.weaknessSignals).toContain('pricing_hidden')
  })

  it('expands a k suffix before parsing: $2k is 200000 cents', () => {
    const result = analysePage({ ...base, html: page('<p>The program costs $2k</p>') })
    expect(result.currency).toBe('AUD')
    expect(result.priceVisible).toBe(true)
    expect(result.priceMinMinor).toBe(200000)
  })

  it('leaves currency and prices null when the page quotes another currency', () => {
    const result = analysePage({ ...base, html: page('<p>The program costs USD 500</p>') })
    expect(result.currency).toBeNull()
    expect(result.priceMinMinor).toBeNull()
    expect(result.priceMaxMinor).toBeNull()
    expect(result.priceVisible).toBe(false)
  })

  it('keeps VND in whole dong and never scales it by 100', () => {
    const result = analysePage({ ...base, country: 'VN', html: page('<p>Đầu tư 2.900.000đ cho khoá học</p>') })
    expect(result.currency).toBe('VND')
    expect(result.priceMinMinor).toBe(2900000)
    expect(result.priceMaxMinor).toBe(2900000)
    expect(result.priceMinMinor).not.toBe(290000000)
  })

  it('reads a spaced VND marker as whole dong too', () => {
    const result = analysePage({ ...base, country: 'VN', html: page('<p>Học phí 2.900.000 VNĐ</p>') })
    expect(result.currency).toBe('VND')
    expect(result.priceMinMinor).toBe(2900000)
  })

  it('reads an AUD amount written with a word marker', () => {
    const result = analysePage({ ...base, html: page('<p>The program costs AUD 2,100</p>') })
    expect(result.currency).toBe('AUD')
    expect(result.priceMinMinor).toBe(210000)
  })

  it('takes whatTheySell from the first h1, not the merged navigation', () => {
    const html = page('<nav>Home Programs About Contact</nav><h1>Business coaching for dentists</h1><p>We coach course creators.</p>')
    const result = analysePage({ ...base, html })
    expect(result.whatTheySell).toBe('Business coaching for dentists')
  })

  it('falls back to the title and then to null for whatTheySell', () => {
    const titled = analysePage({ ...base, html: page('<title>Dental coaching | Jane</title><p>hello</p>') })
    expect(titled.whatTheySell).toBe('Dental coaching | Jane')
    const empty = analysePage({ ...base, html: page('<p>hello</p>') })
    expect(empty.whatTheySell).toBeNull()
  })

  it('never fetches: the page is supplied as a string', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    try {
      analysePage({ ...base, html: page('<p>hello</p>') })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('treats a 50-character login shell as unusable and emits no weakness signals', () => {
    const html = '<p>Log in to Instagram to continue.</p>'
    expect(html.length).toBeLessThan(50)
    const result = analysePage({
      ...base,
      platform: 'instagram',
      url: 'https://instagram.com/someone',
      hasWebsiteChannel: false,
      html,
    })
    expect(result.usable).toBe(false)
    expect(result.weaknessSignals).toEqual([])
    expect(result.hasWebsite).toBe(false)
    expect(result.hasLeadMagnet).toBe(false)
    expect(result.hasEmailCapture).toBe(false)
    expect(result.hasFunnel).toBe(false)
    expect(result.whatTheySell).toBeNull()
    expect(result.priceVisible).toBe(false)
    expect(result.priceMinMinor).toBeNull()
  })

  it('reads a 400-character page with a real funnel as usable', () => {
    const html = page(COPY + '<h1>Coaching for course creators</h1><a href="/webinar">Join the free challenge</a>')
    expect(html.length).toBeGreaterThan(400)
    const result = analysePage({ ...base, html })
    expect(result.usable).toBe(true)
    expect(result.hasFunnel).toBe(true)
    expect(result.weaknessSignals).not.toContain('no_funnel')
  })
})
