import type { NextApiResponse } from 'next'
import { withApi } from '../../../lib/apiHandler'
import { isAdminRequest } from '../../../lib/auth'
import { isGithubLogin } from '../../../lib/github'
import { ORG_CHECKS_PER_HOUR, checkGithubOrg, orgCheckIsCached } from '../../../lib/githubData'
import { rateLimit, rateLimitSite } from '../../../lib/rateLimit'

const HOUR = 60 * 60 * 1000

/** Requests per client per 10 minutes (answers from memory included): a backstop against a runaway page. */
const CLIENT_LIMIT = 60

/**
 * GET /api/admin/github-org?login=<organization> — the admin Home editor's
 * check of an organization the owner adds under Open source → Organizations
 * (lib/githubData checkGithubOrg). Admin-only (the proxy's admin gate plus
 * the session check here), read-only, never cached by the browser.
 *
 *   200 { state: 'ok', org: { login, name, publicRepos, url }, repos, reposAvailable }
 *       — it exists; `repos` are its public repositories of the owner's
 *       own work for the featured picker (full_name "org/name")
 *   200 { state: 'not-found' | 'unavailable', login }
 *   200 { state: 'rate-limited', login, retryAfter } — GitHub's rate limit
 *   400 { state: 'invalid' } — not a GitHub login (nothing is fetched)
 *   429 { state: 'rate-limited', retryAfter, by: 'site' } — this site's own
 *       budget of GitHub lookups (ORG_CHECKS_PER_HOUR for the whole site;
 *       an answer already in memory costs none), with Retry-After
 *
 * GitHub's answers are 200s: the check itself worked, its `state` is what
 * GitHub said. The only URLs fetched are https://api.github.com/orgs/<login>
 * and its repository list, with the login validated first (no SSRF).
 */
export default withApi('admin/github-org', async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!isAdminRequest(req, res)) return res.status(401).json({ error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')

  const client = rateLimit(req, CLIENT_LIMIT, 10 * 60 * 1000, 'admin-github-org')
  if (!client.allowed) return tooMany(res, client.resetAt)

  const raw = req.query.login
  const login = typeof raw === 'string' ? raw.trim() : ''
  if (!isGithubLogin(login)) {
    return res.status(400).json({ state: 'invalid', error: 'Enter a GitHub organization name: letters, digits and single hyphens, at most 39 characters.' })
  }

  if (!orgCheckIsCached(login)) {
    const site = rateLimitSite(ORG_CHECKS_PER_HOUR, HOUR, 'admin-github-org')
    if (!site.allowed) return tooMany(res, site.resetAt)
  }
  return res.status(200).json(await checkGithubOrg(login))
})

function tooMany(res: NextApiResponse, resetAt: number) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
  res.setHeader('Retry-After', String(retryAfter))
  return res.status(429).json({ state: 'rate-limited', retryAfter, by: 'site' })
}
