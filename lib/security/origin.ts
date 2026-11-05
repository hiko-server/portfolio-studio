/**
 * The exact origin a configured value names (`http://127.0.0.1:11434`), or
 * null when it is not one: only http(s), no credentials, no path beyond `/`,
 * no query or fragment. Used for AI_LOCAL_PROVIDER_ORIGINS, which lists
 * origins, never patterns or prefixes. Pure and dependency-free, so the
 * proxy-side settings reader and the transport share it.
 */
export function exactOrigin(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || /[?#]/.test(raw)) return null
  return u.origin
}
