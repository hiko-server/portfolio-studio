/**
 * Which links in a model's reply may be live (design §8.3, non-negotiable).
 *
 * A reply is text a model produced, and a model reads what visitors and tool
 * results put in front of it: a link in it is attacker-chosen. A click on a
 * same-site link sends the admin's Strict cookie, and several admin GETs act
 * when opened (/api/admin/draft, /api/admin/orcid/connect, exports), so only
 * these pages can be live: public pages, the change pages and the editors.
 * Never /api/, /oauth/ or /ai/review/. Everything else — every other path,
 * every absolute URL, other schemes — renders as inert text.
 *
 * Pure, so tests/ai-render checks it without a browser.
 */

/** Exact paths (a query or fragment may follow). */
const EXACT = new Set([
  '/now',
  '/uses',
  '/about',
  '/zh',
  '/cv',
  '/cv/zh',
  '/publications',
  '/admin/blog/edit',
  '/admin/work/edit',
  '/admin/now',
  '/admin/uses',
  '/admin/about',
  '/admin/home',
  '/admin/dashboard',
  '/admin/media',
])

/** Paths with exactly one segment after the prefix. */
const ONE_SEGMENT = [/^\/blog\/[^/]+\/?$/, /^\/work\/[^/]+\/?$/, /^\/zh\/(?:about|blog|work|contact)\/?$/, /^\/admin\/ai\/change\/ch_[a-z2-7]{16}$/]

/** Never live, whatever else matches (belt and braces: none of the rules above can produce them). */
const NEVER = [/^\/api(?:\/|$)/i, /^\/oauth(?:\/|$)/i, /^\/ai\/review(?:\/|$)/i, /^\/\.well-known(?:\/|$)/i, /^\/mcp(?:\/|$)/i]

const BASE = 'https://site.invalid'

/**
 * The href to render live for a link a model wrote, or null when it must
 * stay inert. Only a root-relative path ("/blog/x") qualifies: no scheme, no
 * host, no protocol-relative "//", no backslash, no encoded slash, backslash
 * or dot (a path the browser or the router would normalise to somewhere
 * else), no control character or space. The answer is the normalised path,
 * query and fragment, so what is clicked is exactly what was checked.
 */
export function liveHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const url = raw
  if (!url.startsWith('/') || url.startsWith('//')) return null
  if (url.length > 300) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(url)) return null
  if (/%(?:2f|5c|2e|00)/i.test(url)) return null
  let parsed: URL
  try {
    parsed = new URL(url, BASE)
  } catch {
    return null
  }
  if (parsed.origin !== BASE) return null
  const path = parsed.pathname
  // A dot segment was normalised away: what was written is not what would open.
  if (path !== url.split(/[?#]/, 1)[0]) return null
  if (NEVER.some((re) => re.test(path))) return null
  if (!EXACT.has(path.replace(/\/$/, '') || '/') && !ONE_SEGMENT.some((re) => re.test(path))) return null
  return `${path}${parsed.search}${parsed.hash}`
}

/** An absolute web address to show as text (with Copy), or null: anything else stays exactly as written. */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null
  } catch {
    return null
  }
}
