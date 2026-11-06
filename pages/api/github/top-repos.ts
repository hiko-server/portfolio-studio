import { withApi } from '../../../lib/apiHandler'
import { allowRead, setGhCache } from '../../../lib/github'
import { githubContext, loadRepoChoices, loadTopRepos, noProfileSummary, type GhTopRepos } from '../../../lib/githubData'

/**
 * GET /api/github/top-repos — the owner's featured repositories first (home
 * `openSource.featured`, in their order, with blurbs), then the rest of their
 * own work by stars / recency, six in all. The owner's work is the personal
 * account's public repositories plus those of the organizations listed in
 * `openSource.orgs`; an organization's repository carries `org`.
 *
 * GET /api/github/top-repos?all=1 — every public repository as
 * `{name, full_name, org?, fork?, archived?, description, language,
 * stargazers_count, pushed_at}` for the admin featured-repo picker (it
 * offers no forks, but resolves featured names among them as the home
 * page does). Never
 * cached by browsers or the CDN: the picker must list what the saved
 * organizations hold right after a save (the server's own cache keeps
 * GitHub out of it).
 *
 * `available: false` = GitHub unreachable; `repos: []` with
 * `available: true` = genuinely none (or no profile linked).
 */
export default withApi('github/top-repos', async (req, res, ctx) => {
  if (!allowRead(req, res)) return
  const all = req.query.all === '1'
  const cache = (available: boolean, sMaxAge: number) => (all ? res.setHeader('Cache-Control', 'no-store') : setGhCache(res, available, sMaxAge))
  try {
    const { home, user } = githubContext()
    if (!user) {
      cache(true, 300)
      return res.status(200).json(all ? { repos: [], available: true } : noProfileSummary().topRepos)
    }
    const data = all ? await loadRepoChoices(user, home) : await loadTopRepos(user, home)
    cache(data.available, 600)
    return res.status(200).json(data)
  } catch (err) {
    ctx.log.warn('GitHub repositories unavailable', { err, all })
    const unavailable: GhTopRepos = { repos: [], available: false }
    cache(false, 0)
    return res.status(200).json(unavailable)
  }
})
