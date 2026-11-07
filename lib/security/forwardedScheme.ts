/**
 * The scheme the visitor used, as reported by the proxy in front of us:
 * Cloudflare's `cf-visitor` ({"scheme":"https"}), else the first value of
 * `x-forwarded-proto`; lower-case, or '' when neither says.
 *
 * Pure. proxy.ts uses it for the plain-HTTP redirect (and re-exports it);
 * API routes, which see Node's incoming header record instead of a fetch
 * `Headers`, can pass theirs.
 */

export type HeaderSource = Headers | Readonly<Record<string, string | string[] | undefined>>

function headerOf(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
  const value = (headers as Readonly<Record<string, string | string[] | undefined>>)[name]
  return Array.isArray(value) ? value.join(', ') : (value ?? null)
}

export function forwardedScheme(headers: HeaderSource): string {
  const visitor = headerOf(headers, 'cf-visitor')
  if (visitor) {
    try {
      const scheme = (JSON.parse(visitor) as { scheme?: unknown }).scheme
      if (typeof scheme === 'string' && scheme) return scheme.toLowerCase()
    } catch {
      /* malformed: fall through to x-forwarded-proto */
    }
  }
  return (headerOf(headers, 'x-forwarded-proto') || '').split(',')[0].trim().toLowerCase()
}
