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

/** Characters of a repository name (GitHub's limit). */
export const REPO_NAME_MAX = 100

/** A repository name: 1–REPO_NAME_MAX letters, digits, `_`, `.` or `-`. */
const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * A featured repository as the home document stores it: a plain name (the
 * personal account's repository of that name) or "owner/name" (how the
 * picker stores an organization's). The two parts are checked on their own:
 * the owner is a GitHub login (up to 39 characters), the name up to
 * REPO_NAME_MAX — so a long name under an organization is as valid as on
 * GitHub.
 */
export function isRepoRef(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const slash = value.indexOf('/')
  if (slash < 0) return REPO_NAME_RE.test(value)
  return isGithubLogin(value.slice(0, slash)) && REPO_NAME_RE.test(value.slice(slash + 1))
}
