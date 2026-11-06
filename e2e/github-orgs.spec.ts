import AxeBuilder from '@axe-core/playwright'
import type { Page, Route } from '@playwright/test'
import { test, expect, ADMIN, loginAsAdmin } from './fixtures'

/**
 * The owner's GitHub organizations (home.openSource.orgs) in Admin → Home →
 * Open source: adding one checks it (GET /api/admin/github-org), its
 * repositories join the featured-repo picker as "org / name", and both are
 * saved. GitHub is never contacted: the browser's calls to the check and
 * to the picker's list are answered here with synthetic data, and the real
 * check endpoint is only asked what it refuses before any fetch (no
 * session, a name that is not a GitHub login).
 */

/** Same-origin fetch from the page (the session cookie is Secure: the browser sends it to 127.0.0.1, Playwright's request client does not). */
function adminFetch(page: Page, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(
    async ([m, u, b, h]) => {
      const res = await fetch(u as string, {
        method: m as string,
        headers: { 'Content-Type': 'application/json', ...(h as Record<string, string>) },
        body: b === undefined ? undefined : JSON.stringify(b),
      })
      return { status: res.status, etag: res.headers.get('ETag'), text: await res.text() }
    },
    [method, url, body, headers] as const,
  )
}

const ifMatch = (etag: string | null): Record<string, string> => (etag ? { 'If-Match': etag } : {})

/** A picker row as the server sends it. */
const choice = (owner: string, name: string, stars: number, org = false, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `${owner}/${name}`,
  ...(org ? { org: owner } : {}),
  description: `${name}, a synthetic repository`,
  language: 'TypeScript',
  stargazers_count: stars,
  pushed_at: '2026-10-20T00:00:00Z',
  ...extra,
})

/** The browser's GitHub-backed calls, answered with synthetic data; returns the logins checked. */
async function fakeGithub(page: Page): Promise<string[]> {
  const checked: string[] = []
  await page.route(
    (url) => url.pathname === '/api/github/top-repos' && url.searchParams.get('all') === '1',
    (route: Route) => route.fulfill({ json: { available: true, repos: [choice('example-person', 'site', 5), choice('example-person', 'tool', 2)] } }),
  )
  await page.route(
    (url) => url.pathname === '/api/admin/github-org',
    (route: Route) => {
      const login = new URL(route.request().url()).searchParams.get('login') || ''
      checked.push(login)
      if (login.toLowerCase() === 'example-org') {
        return route.fulfill({
          json: {
            state: 'ok',
            org: { login: 'example-org', name: 'Example Org', publicRepos: 2, url: 'https://github.com/example-org' },
            reposAvailable: true,
            repos: [choice('example-org', 'engine', 30, true), choice('example-org', 'tool', 9, true)],
          },
        })
      }
      if (login === 'example-busy') return route.fulfill({ json: { state: 'rate-limited', login, retryAfter: 120 } })
      return route.fulfill({ json: { state: 'not-found', login } })
    },
  )
  return checked
}

test('the organization check needs a session; the picker list is never cached', async ({ request }) => {
  const anon = await request.get('/api/admin/github-org?login=example-org')
  expect(anon.status()).toBe(401)
  const all = await request.get('/api/github/top-repos?all=1')
  expect(all.status()).toBe(200)
  expect(all.headers()['cache-control']).toBe('no-store')
  const body = (await all.json()) as { repos: unknown[]; available: boolean }
  expect(Array.isArray(body.repos)).toBe(true)
})

test.describe('Open source → Organizations', { tag: '@admin' }, () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')

  test('an added organization is checked, its repositories join the picker as "org / name", and both are saved', async ({ page }) => {
    await loginAsAdmin(page)
    const original = await adminFetch(page, 'GET', '/api/admin/home')
    expect(original.status).toBe(200)

    // The real endpoint refuses a name that is not a GitHub login before fetching anything.
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
    const invalid = await page.request.get('/api/admin/github-org?login=not%20an%20org', { headers: { cookie } })
    expect(invalid.status()).toBe(400)
    expect(((await invalid.json()) as { state: string }).state).toBe('invalid')

    const checked = await fakeGithub(page)
    try {
      await page.goto('/admin/dashboard?tab=home')
      const orgs = page.getByTestId('open-source-orgs')
      await orgs.scrollIntoViewIfNeeded()
      await expect(orgs.getByRole('heading', { name: 'Organizations' })).toBeVisible()
      await expect(orgs).toContainText('Add only organizations whose work is your own')
      const input = orgs.getByLabel('Add an organization')

      // Not a GitHub name: said at the field, nothing added, nothing asked.
      await input.fill('not valid!')
      await orgs.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(orgs.getByText(/letters, digits and single hyphens/)).toBeVisible()
      await expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(checked).toEqual([])

      // A link to the organization works; its check is announced once.
      await input.fill('https://github.com/example-org')
      await input.press('Enter')
      const row = orgs.locator('[data-org="example-org"]')
      await expect(row).toContainText('Example Org · 2 public repositories')
      await expect(orgs.getByRole('status')).toHaveText('example-org: Example Org · 2 public repositories')
      await expect(input).toHaveValue('')

      // GitHub's honest answers: not found, rate-limited (with a way to ask again).
      await input.fill('example-gone')
      await input.press('Enter')
      await expect(orgs.locator('[data-org="example-gone"]')).toContainText('GitHub has no organization with this name')
      await input.fill('example-busy')
      await input.press('Enter')
      const busy = orgs.locator('[data-org="example-busy"]')
      await expect(busy).toContainText('GitHub’s rate limit is reached. Check again in 2 minutes')
      // Check again from the keyboard: the button keeps focus while it checks, and the new answer is announced once.
      await busy.getByRole('button', { name: 'Check again: example-busy' }).focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => checked.filter((c) => c === 'example-busy').length).toBe(2)
      await expect(busy.getByRole('button', { name: 'Check again: example-busy' })).toBeFocused()
      await expect(orgs.getByRole('status')).toHaveText('example-busy: GitHub’s rate limit is reached. Check again in 2 minutes; it stays in the list.')
      await input.fill('EXAMPLE-ORG')
      await input.press('Enter')
      await expect(orgs.getByText('EXAMPLE-ORG is already in the list.')).toBeVisible()

      const violations = await new AxeBuilder({ page }).include('[data-testid="open-source-orgs"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      expect(violations.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])

      // The picker offers the organization's repositories by their owner, next to the personal "tool".
      await expect(page.getByText('4 public repositories (2 from your organizations).')).toBeVisible()
      const search = page.getByLabel('Add a repository')
      await search.fill('tool')
      const matches = page.getByRole('list', { name: 'Matching repositories' })
      await expect(matches.getByRole('button')).toHaveCount(2)
      await expect(matches.getByRole('button', { name: /^example-org \/ tool/ })).toBeVisible()
      await search.fill('engine')
      await matches.getByRole('button', { name: /^example-org \/ engine/ }).click()
      const featured = page.getByRole('list', { name: 'Featured repositories, in display order' })
      await expect(featured).toContainText('example-org / engine')

      // Up to ten: the field says why it is off, and the tenth row is scrolled into view with its answer.
      for (let i = 1; i <= 7; i++) {
        await input.fill(`example-c${i}`)
        await input.press('Enter')
      }
      await expect(orgs.locator('[data-org]')).toHaveCount(10)
      await expect(orgs.locator('[data-org="example-c7"]')).toBeInViewport()
      await expect(input).toBeDisabled()
      await expect(orgs.getByText('Up to 10 organizations — remove one to add another.')).toBeVisible()
      await expect(input).toHaveAccessibleDescription(/Up to 10 organizations — remove one to add another\./)
      // (By keyboard from here on: the Undo toasts at the bottom may cover what a pointer would click.)
      const press = async (name: string) => {
        await orgs.getByRole('button', { name, exact: true }).focus()
        await page.keyboard.press('Enter')
      }
      for (let i = 7; i >= 1; i--) {
        await press(`Remove example-c${i}`)
        await expect(orgs.locator(`[data-org="example-c${i}"]`)).toHaveCount(0)
      }
      await expect(input).toBeEnabled()

      // Removing one: focus moves to the next row's Remove; Undo puts it back where it was, check and all.
      await press('Remove example-gone')
      await expect(orgs.getByRole('button', { name: 'Remove example-busy' })).toBeFocused()
      await page.locator('.chakra-toast').filter({ hasText: 'Removed example-gone' }).getByRole('button', { name: 'Undo' }).click()
      await expect(orgs.locator('[data-org]')).toHaveCount(3)
      await expect(orgs.locator('[data-org]').nth(1)).toHaveAttribute('data-org', 'example-gone')
      await expect(orgs.locator('[data-org="example-gone"]')).toContainText('GitHub has no organization with this name')
      expect(checked.filter((c) => c === 'example-gone').length, 'put back with its answer, not checked again').toBe(1)

      // A featured repository of an organization taken out of the list says so (not "not on GitHub").
      await press('Remove example-org')
      await expect(featured).toContainText('example-org isn’t in Organizations above, so the home page doesn’t show it.')
      await page.locator('.chakra-toast').filter({ hasText: 'Removed example-org' }).getByRole('button', { name: 'Undo' }).click()
      await expect(featured).not.toContainText('isn’t in Organizations above')

      // Removed organizations are no longer kept; the rest is saved. The last row's removal moves focus to the one before it.
      await press('Remove example-gone')
      await press('Remove example-busy')
      await expect(orgs.getByRole('button', { name: 'Remove example-org' })).toBeFocused()
      await expect(orgs.locator('[data-org]')).toHaveCount(1)

      const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/home' && r.request().method() === 'PUT')
      await page.getByRole('button', { name: 'Save changes' }).focus()
      await page.keyboard.press('Enter')
      expect((await saved).status()).toBe(200)
      const stored = JSON.parse((await adminFetch(page, 'GET', '/api/admin/home')).text) as { openSource?: { orgs?: string[]; featured?: Array<{ name: string }> } }
      expect(stored.openSource?.orgs).toEqual(['example-org'])
      expect(stored.openSource?.featured?.map((f) => f.name)).toContain('example-org/engine')
      // Public by design: the public home document carries the organization names.
      const pub = JSON.parse((await adminFetch(page, 'GET', '/api/home')).text) as { openSource?: { orgs?: string[] } }
      expect(pub.openSource?.orgs).toEqual(['example-org'])

      // Opening the editor again checks the saved organization and shows it.
      const before = checked.length
      await page.reload()
      const again = page.getByTestId('open-source-orgs')
      await again.scrollIntoViewIfNeeded()
      await expect(again.locator('[data-org="example-org"]')).toContainText('Example Org · 2 public repositories')
      expect(checked.slice(before)).toEqual(['example-org'])
      await expect(page.getByRole('list', { name: 'Featured repositories, in display order' })).toContainText('example-org / engine')
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      const current = await adminFetch(page, 'GET', '/api/admin/home')
      const restored = await adminFetch(page, 'PUT', '/api/home', JSON.parse(original.text), ifMatch(current.etag))
      expect(restored.status, restored.text).toBe(200)
    }
  })
})
