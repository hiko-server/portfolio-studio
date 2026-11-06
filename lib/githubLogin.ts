/**
 * GitHub account names (users and organizations), pure and client-safe:
 * the home document's validation (lib/homeShape), the admin editor and the
 * server loaders (lib/github, lib/githubData) share one rule.
 */

/** GitHub's login rule: 1–39 alphanumerics or single hyphens, not leading/trailing. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** A valid GitHub user or organization login (safe to put into an API path as it is). */
export function isGithubLogin(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_RE.test(value)
}

/**
 * Pull the GitHub login from a profile URL like `https://github.com/<user>`.
 * Anything that is not a valid login (an org path, a query, garbage) yields
 * null, so a login can be put into API paths without further escaping.
 */
export function extractGithubUser(url?: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return isGithubLogin(parts[0]) ? parts[0] : null
  } catch {
    return null
  }
}
