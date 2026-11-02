// src/marketing/pixel-injection.ts
// Slice 3 spec section 6: injects the Meta pixel base code into HTML at
// publish time, so every published page carries tracking without the
// funnel-builder having to paste the snippet by hand.

import { encodeSiteText, sha256OfText, siteTextOf, type SiteFile } from './site'

const PIXEL_SNIPPET = `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '{{PIXEL_ID}}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id={{PIXEL_ID}}&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->`

export function buildPixelSnippet(pixelId: string): string {
  return PIXEL_SNIPPET.replaceAll('{{PIXEL_ID}}', pixelId)
}

/**
 * Finds the last occurrence of a closing tag, case-insensitively. Returns -1
 * when the tag is absent.
 */
function lastIndexOfTag(html: string, tag: string): number {
  const lower = html.toLowerCase()
  return lower.lastIndexOf(tag.toLowerCase())
}

/**
 * The three injection sites, tried in order: before </head>, before </body>,
 * or prepended. A case-insensitive match keeps the injection working against
 * HTML that a funnel-builder emitted with uppercase tags.
 */
export function injectPixel(html: string, pixelId: string): string {
  const snippet = buildPixelSnippet(pixelId)
  const headClose = lastIndexOfTag(html, '</head>')
  if (headClose !== -1) {
    return html.slice(0, headClose) + snippet + '\n' + html.slice(headClose)
  }
  const bodyClose = lastIndexOfTag(html, '</body>')
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + snippet + '\n' + html.slice(bodyClose)
  }
  return snippet + '\n' + html
}

export interface PixelInjectionResult {
  files: SiteFile[]
  injected: boolean
}

/**
 * Walks the site files and injects the pixel into every HTML file. Non-HTML
 * files pass through untouched. When the pixel ID is absent the files are
 * returned as-is and a warning is logged, so the missing configuration is
 * visible in the publish drain output rather than silent.
 */
export function injectPixelIntoFiles(
  files: readonly SiteFile[],
  pixelId: string | undefined,
  logger: { warn: (msg: string) => void } = console,
): PixelInjectionResult {
  if (!pixelId || pixelId.trim() === '') {
    logger.warn('Meta pixel ID not configured; page published without tracking')
    return { files: [...files], injected: false }
  }
  const patched = files.map((file) => {
    // The `.html` test is what keeps this module from ever touching a picture:
    // an asset's bytes go through the resolver, not through a string rewrite.
    if (!file.path.endsWith('.html')) return file
    const injected = injectPixel(siteTextOf(file), pixelId)
    // Recomputed, because after Task 6 the same field describes a PNG's bytes in
    // a manifest Cloudflare checks. This does not weaken the approval invariant:
    // readSiteFiles compares the approved hash BEFORE injecting, so the receipt
    // still covers the bytes the reviewer saw, and the pixel stays the documented
    // deviation from them (spec section 2).
    return { ...file, content: encodeSiteText(injected), sha256: sha256OfText(injected) }
  })
  return { files: patched, injected: true }
}
