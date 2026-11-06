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
  featuredGap,
  pickerRepos,
  resolveFeatured,
  sourceRepos,
  type OrgCheckState,
  type RepoChoice,
} from '../components/Admin/home/orgCheck'

const USER = 'example-person'

const choice = (fullName: string, extra: Partial<RepoChoice> = {}): RepoChoice => {
  const [owner, name] = fullName.split('/')
  return { name, fullName, org: owner === USER ? '' : owner, description: '', language: '', stars: 0, pushedAt: '2026-01-01T00:00:00Z', archived: false, fork: false, ...extra }
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
  const sources = sourceRepos(base, ['example-org', 'example-lab'], checks)
  // The home page's order: personal, then the organizations of the form in order; one removed from the form goes.
  assert.deepEqual(sources.map((r) => r.fullName), [`${USER}/tool`, 'example-org/engine', 'example-lab/tool'])
  const list = pickerRepos(sources)
  // Offered newest first.
  assert.deepEqual(list.map((r) => r.fullName), ['example-lab/tool', 'example-org/engine', `${USER}/tool`])
  const featured = [
    { _id: 'a', name: 'tool' },
    { _id: 'b', name: 'example-lab/tool' },
    { _id: 'c', name: 'example-gone/x' },
  ]
  const resolved = resolveFeatured(sources, featured)
  assert.equal(resolved.get('a')?.fullName, `${USER}/tool`)
  assert.equal(resolved.get('b')?.fullName, 'example-lab/tool')
  assert.equal(resolved.has('c'), false)
  assert.equal(featuredNameFor(list[0]), 'example-lab/tool')
  assert.equal(featuredNameFor(list[2]), 'tool')
  assert.equal(namesListedRepo(sources, 'example-org/engine'), true)
  assert.equal(namesListedRepo(sources, 'engine'), true)
  assert.equal(namesListedRepo(sources, 'nothing'), false)
  // An older server's bare list of personal repositories.
  assert.deepEqual(parseRepos([{ name: 'a' }]), {
    repos: [{ name: 'a', fullName: 'a', org: '', description: '', language: '', stars: 0, pushedAt: '', archived: false, fork: false }],
    available: true,
  })
  assert.equal(parseRepos({ repos: [], available: false }).available, false)
})

test('resolveFeatured matches the home page: a personal fork keeps its plain name; two organizations — the first in the owner’s order', () => {
  // (a) The personal "tool" is a fork and an organization has a "tool": the home page features the personal fork.
  const base = [
    choice(`${USER}/tool`, { fork: true, pushedAt: '2025-01-01T00:00:00Z' }),
    choice(`${USER}/.github`),
    choice('example-org/tool', { pushedAt: '2026-10-01T00:00:00Z' }),
  ]
  const sources = sourceRepos(base, ['example-org'], {})
  const resolved = resolveFeatured(sources, [{ _id: 'a', name: 'tool' }])
  assert.equal(resolved.get('a')?.fullName, `${USER}/tool`)
  // The picker never offers the fork or the dot-named one, and still offers the organization's "tool" by its owner.
  assert.deepEqual(pickerRepos(sources).map((r) => r.fullName), ['example-org/tool'])
  // Typing "tool" means the fork, which the list does not offer: it can be added as typed.
  assert.equal(namesListedRepo(sources, 'tool'), false)
  assert.equal(namesListedRepo(sources, 'example-org/tool'), true)

  // (b) Two organizations have "dup", the personal account has none: the first organization in the owner's order wins, however recent the other is.
  const both = [choice('example-lab/dup', { pushedAt: '2026-11-01T00:00:00Z' }), choice('example-org/dup', { pushedAt: '2020-01-01T00:00:00Z' })]
  const checks: Record<string, OrgCheckState> = {
    'example-lab': { status: 'ok', login: 'example-lab', name: null, publicRepos: 1, repos: [both[0]], reposAvailable: true },
  }
  assert.equal(resolveFeatured(sourceRepos([both[1]], ['example-org', 'example-lab'], checks), [{ _id: 'b', name: 'dup' }]).get('b')?.fullName, 'example-org/dup')
  assert.equal(resolveFeatured(sourceRepos([both[1]], ['example-lab', 'example-org'], checks), [{ _id: 'b', name: 'dup' }]).get('b')?.fullName, 'example-lab/dup')
})

test('featuredGap: an organization repository whose organization left the form, or a repository GitHub does not list', () => {
  assert.equal(featuredGap('example-org/engine', ['example-lab']), 'org')
  assert.equal(featuredGap('EXAMPLE-ORG/engine', ['example-org']), 'missing')
  assert.equal(featuredGap('engine', []), 'missing')
  assert.equal(featuredGap(`${USER}/engine`, [], USER), 'missing', 'the personal account is no organization to add')
  assert.equal(featuredGap('someone/engine', [], USER), 'org')
})
