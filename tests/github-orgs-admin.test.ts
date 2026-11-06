/**
 * The Home editor's Open source section, pure parts
 * (components/Admin/home/orgCheck): the answers of GET
 * /api/admin/github-org and what the editor says about each organization,
 * what an owner may type to add one, and the repositories the featured
 * picker offers (the organizations of the form, the home page's same-name
 * rule). Synthetic names only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canRecheck,
  featuredNameFor,
  namesListedRepo,
  orgCheckText,
  orgFromInput,
  orgInputProblem,
  parseOrgCheck,
  parseRepos,
  pickerRepos,
  resolveFeatured,
  type OrgCheckState,
  type RepoChoice,
} from '../components/Admin/home/orgCheck'

const USER = 'example-person'

const choice = (fullName: string, extra: Partial<RepoChoice> = {}): RepoChoice => {
  const [owner, name] = fullName.split('/')
  return { name, fullName, org: owner === USER ? '' : owner, description: '', language: '', stars: 0, pushedAt: '2026-01-01T00:00:00Z', archived: false, ...extra }
}

test('parseOrgCheck and orgCheckText: every state says what happened', () => {
  const ok = parseOrgCheck(200, {
    state: 'ok',
    org: { login: 'example-org', name: 'Example Org', publicRepos: 1, url: 'https://github.com/example-org' },
    repos: [
      { name: 'engine', full_name: 'example-org/engine', org: 'example-org', stargazers_count: 3 },
      { name: 'stray', full_name: 'someone/stray', org: 'someone' },
    ],
    reposAvailable: true,
  })
  assert.equal(ok.status, 'ok')
  if (ok.status === 'ok') assert.deepEqual(ok.repos.map((r) => r.fullName), ['example-org/engine'], 'only that organization’s repositories')
  assert.deepEqual(orgCheckText(ok), { text: 'Example Org · 1 public repository', warn: false })
  assert.deepEqual(orgCheckText({ status: 'ok', login: 'example-org', name: null, publicRepos: 12, repos: [], reposAvailable: false }), {
    text: '12 public repositories · its repositories couldn’t be listed right now',
    warn: true,
  })
  assert.deepEqual(parseOrgCheck(200, { state: 'not-found', login: 'x' }), { status: 'not-found' })
  assert.deepEqual(parseOrgCheck(200, { state: 'rate-limited', retryAfter: 90 }), { status: 'rate-limited', retryAfter: 90, by: 'github' })
  assert.deepEqual(parseOrgCheck(200, { state: 'rate-limited', retryAfter: 90, by: 'github' }), { status: 'rate-limited', retryAfter: 90, by: 'github' })
  assert.deepEqual(parseOrgCheck(200, { state: 'rate-limited', retryAfter: 600, by: 'budget' }), { status: 'rate-limited', retryAfter: 600, by: 'budget' })
  assert.deepEqual(parseOrgCheck(429, { state: 'rate-limited', retryAfter: 1800, by: 'site' }), { status: 'rate-limited', retryAfter: 1800, by: 'site' })
  assert.deepEqual(parseOrgCheck(200, { state: 'unavailable' }), { status: 'unavailable' })
  assert.deepEqual(parseOrgCheck(200, { state: 'unavailable', retryAfter: 480 }), { status: 'unavailable', retryAfter: 480 })
  assert.deepEqual(parseOrgCheck(401, { error: 'Unauthorized' }), { status: 'session' })
  assert.deepEqual(parseOrgCheck(500, null), { status: 'error' })
  assert.deepEqual(parseOrgCheck(200, { state: 'ok', org: { login: 'not a login' } }), { status: 'error' })
  assert.match(orgCheckText({ status: 'not-found' }).text, /^GitHub has no organization with this name/)
  assert.equal(orgCheckText({ status: 'rate-limited', retryAfter: 90, by: 'github' }).text, 'GitHub’s rate limit is reached. Check again in 2 minutes; it stays in the list.')
  assert.equal(orgCheckText({ status: 'rate-limited', retryAfter: 45, by: 'site' }).text, 'Too many organization checks this hour. Check again in 45 seconds; it stays in the list.')
  assert.equal(orgCheckText({ status: 'rate-limited', retryAfter: 600, by: 'budget' }).text, 'This site has used its GitHub requests for the hour. Check again in 10 minutes; it stays in the list.')
  assert.equal(orgCheckText({ status: 'unavailable', retryAfter: 480 }).text, 'Couldn’t reach GitHub to check it. It stays in the list; check again in 8 minutes.')
  assert.equal(orgCheckText({ status: 'unavailable' }).text, 'Couldn’t reach GitHub to check it. It stays in the list; check again later.')
  assert.equal(orgCheckText({ status: 'checking' }).warn, false)
  for (const s of ['rate-limited', 'unavailable', 'error'] as const) assert.equal(canRecheck({ status: s, retryAfter: 1, by: 'github' } as OrgCheckState), true)
  for (const s of ['ok', 'not-found', 'checking', 'session'] as const) assert.equal(canRecheck({ status: s } as OrgCheckState), false)
})

test('orgFromInput / orgInputProblem: a name, @name or a GitHub link; never the personal account, a twin or an eleventh', () => {
  assert.equal(orgFromInput(' example-org '), 'example-org')
  assert.equal(orgFromInput('@example-org'), 'example-org')
  assert.equal(orgFromInput('https://github.com/example-org'), 'example-org')
  assert.equal(orgFromInput('github.com/example-org/engine'), 'example-org')
  assert.equal(orgFromInput('https://example.com/example-org'), '')
  assert.equal(orgFromInput('not an org'), '')
  assert.equal(orgInputProblem('example-org', [], USER), null)
  assert.match(orgInputProblem('', [], USER) || '', /Enter the organization/)
  assert.match(orgInputProblem('bad name', [], USER) || '', /letters, digits and single hyphens/)
  assert.match(orgInputProblem('Example-Person', [], USER) || '', /your personal account/)
  assert.match(orgInputProblem('EXAMPLE-ORG', ['example-org'], USER) || '', /already in the list/)
  assert.match(orgInputProblem('example-lab', Array.from({ length: 10 }, (_, i) => `o-${i}`), USER) || '', /Up to 10 organizations/)
})

test('pickerRepos and resolveFeatured: the organizations of the form, the same-name rule of the home page', () => {
  const base = [choice(`${USER}/tool`), choice('example-org/engine', { pushedAt: '2026-10-01T00:00:00Z' }), choice('example-gone/x')]
  const checks: Record<string, OrgCheckState> = {
    'example-lab': { status: 'ok', login: 'example-lab', name: null, publicRepos: 1, repos: [choice('example-lab/tool', { pushedAt: '2026-11-01T00:00:00Z' })], reposAvailable: true },
    'example-org': { status: 'checking' },
  }
  const list = pickerRepos(base, ['example-org', 'example-lab'], checks)
  // Newest first; the saved list's organization still in the form stays; one removed from the form goes.
  assert.deepEqual(list.map((r) => r.fullName), ['example-lab/tool', 'example-org/engine', `${USER}/tool`])
  const featured = [
    { _id: 'a', name: 'tool' },
    { _id: 'b', name: 'example-lab/tool' },
    { _id: 'c', name: 'example-gone/x' },
  ]
  const resolved = resolveFeatured(list, featured)
  assert.equal(resolved.get('a')?.fullName, `${USER}/tool`)
  assert.equal(resolved.get('b')?.fullName, 'example-lab/tool')
  assert.equal(resolved.has('c'), false)
  assert.equal(featuredNameFor(list[0]), 'example-lab/tool')
  assert.equal(featuredNameFor(list[2]), 'tool')
  assert.equal(namesListedRepo(list, 'example-org/engine'), true)
  assert.equal(namesListedRepo(list, 'engine'), true)
  assert.equal(namesListedRepo(list, 'nothing'), false)
  // An older server's bare list of personal repositories.
  assert.deepEqual(parseRepos([{ name: 'a' }]), {
    repos: [{ name: 'a', fullName: 'a', org: '', description: '', language: '', stars: 0, pushedAt: '', archived: false }],
    available: true,
  })
  assert.equal(parseRepos({ repos: [], available: false }).available, false)
})
