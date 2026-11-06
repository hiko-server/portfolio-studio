import path from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { ADMIN, expect, loginAsAdmin, seriousA11yViolations, settle, test } from './fixtures'

/**
 * The AI admin flows, on the standalone server scripts/ai-e2e.sh starts. Stage
 * P0 holds the harness check; the stages that build each flow add theirs here,
 * and M2 puts a draft write first (design §12.4: it proves the MDX worker chunk
 * is in the standalone output).
 */
const FAKE = process.env.E2E_FAKE_LLM_URL

test.describe('@ai harness', () => {
  test('the server on loopback serves the synthetic fixture store', async ({ page, baseURL }) => {
    expect(new URL(baseURL ?? '').hostname).toBe('127.0.0.1')
    await page.goto('/')
    await expect(page.getByText('Example Person').first()).toBeVisible()
    await page.goto('/blog')
    await expect(page.locator('a[href="/blog/example-field-notes"]').first()).toBeVisible()
  })

  test('the fake provider answers next to it, on loopback, in the three wires', async () => {
    // The AI projects exist only when scripts/ai-e2e.sh sets it (e2e/playwright.config.ts).
    expect(FAKE, 'E2E_FAKE_LLM_URL').toBeTruthy()
    const origin = new URL(FAKE ?? '')
    expect(origin.hostname).toBe('127.0.0.1')
    const headers = { 'content-type': 'application/json', authorization: 'Bearer e2e-test-key' }

    const health = await fetch(`${FAKE}/__fake/health`)
    expect(health.status).toBe(200)

    const models = await (await fetch(`${FAKE}/v1/models`, { headers })).json()
    expect(models.data.map((m: { id: string }) => m.id)).toContain('fake-model')

    const say = '/say Harness check.'
    const chat = await (await fetch(`${FAKE}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: say }] }) })).json()
    expect(chat.choices[0].message.content).toBe('Harness check.')

    const responses = await (await fetch(`${FAKE}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'fake-model', input: say }) })).json()
    expect(responses.status).toBe('completed')

    const claude = await (await fetch(`${FAKE}/v1/messages`, { method: 'POST', headers: { ...headers, 'anthropic-version': '2026-10-21' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1024, messages: [{ role: 'user', content: say }] }) })).json()
    expect(claude.content.at(-1).text).toBe('Harness check.')
  })
})

// ── Admin → AI → Connections (stage M1b) ────────────────────────────────────

const DATA_DIR = process.env.E2E_SERVER_DATA_DIR || ''
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000'
const MODERN = '2026-07-28'

/** The server's auth.db (the standalone server's cwd is .next/standalone; scripts/ai-e2e.sh names its data/). */
function authDb(): Database.Database {
  return new Database(path.join(DATA_DIR, 'auth.db'), { fileMustExist: true, timeout: 5000 })
}

/** This browser's session id, from the session cookie's claims. */
async function sessionIdOf(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'cv_admin_token')
  const payload = JSON.parse(Buffer.from((cookie?.value ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { sid?: string }
  expect(payload.sid, 'a session cookie with a session id').toBeTruthy()
  return payload.sid as string
}

/** Make this browser's last verification `ms` older than now, as if the owner had signed in that long ago. */
function verifiedAgo(sid: string, ms: number): void {
  const db = authDb()
  try {
    db.prepare('UPDATE auth_sessions SET verified_at = ? WHERE id = ?').run(Date.now() - ms, sid)
  } finally {
    db.close()
  }
}

/** A POST from outside the browser, as an MCP client sends it (never a cookie). */
async function post(pathname: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(opts.body ?? { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() }
}

/** tools/list in the modern era, as a client that names itself. */
async function toolNames(token: string): Promise<string[]> {
  const res = await post('/mcp', {
    token,
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list', accept: 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'e2e client', version: '1' } } },
    },
  })
  expect(res.status, res.text).toBe(200)
  return (JSON.parse(res.text).result.tools as Array<{ name: string }>).map((t) => t.name)
}

/** Answer the "Confirm it's you" dialog with the password. */
async function confirmWithPassword(page: Page, reason: string): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: /Confirm it’s you/ })
  await expect(stepUp).toBeVisible()
  await expect(stepUp).toContainText(reason)
  await stepUp.getByLabel(/^Password/).fill(ADMIN.password)
  await stepUp.getByRole('button', { name: 'Confirm with password' }).click()
  await expect(stepUp).toBeHidden()
}

/** Back to the default: AI access and connected apps off, every app revoked (the next specs expect closed). */
function closeEverything(): void {
  if (!DATA_DIR) return
  const db = authDb()
  try {
    db.prepare('UPDATE ai_settings SET enabled = 0, mcp_enabled = 0 WHERE id = 1').run()
    db.prepare("UPDATE ai_grants SET revoked_at = ?, revoke_reason = 'e2e clean-up' WHERE revoked_at IS NULL").run(Date.now())
  } finally {
    db.close()
  }
}

/** Click a switch where a person does: its visible track (the input itself is visually hidden). */
async function flip(page: Page, id: string): Promise<void> {
  await page.locator(`label.chakra-switch:has(#${id})`).click()
}

/** No horizontal scroll: nothing is wider than the viewport. */
async function fitsWidth(page: Page): Promise<void> {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  expect(scroll, 'no horizontal scroll').toBeLessThanOrEqual(inner)
}

test.describe('@ai connections', () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')
  test.beforeAll(() => expect(DATA_DIR, 'E2E_SERVER_DATA_DIR (scripts/ai-e2e.sh)').toBeTruthy())
  test.beforeEach(async ({ context }) => {
    // The site's theme follows the system colour scheme on these pages (the tests switch it).
    await context.addInitScript(() => {
      try {
        localStorage.setItem('theme-preference', 'system')
      } catch {
        /* storage blocked: the default theme applies */
      }
    })
  })
  test.afterAll(closeEverything)

  test('turn on with a step-up; /mcp 404 before and 401 after; a token shown once; tools/list by level; Connected after its first call', async ({ page }) => {
    test.setTimeout(150_000)
    closeEverything()
    // Closed: /mcp answers exactly what an unknown path answers.
    const closed = await post('/mcp')
    const unknown = await post('/zz-mcp')
    expect([closed.status, closed.headers['content-type']]).toEqual([404, unknown.headers['content-type']])
    expect(closed.text).toBe(unknown.text)

    await loginAsAdmin(page, { fresh: true })
    const sid = await sessionIdOf(page)
    verifiedAgo(sid, 15 * 60_000) // past the 10-minute recent window: turning on must ask
    await page.goto('/admin/ai')
    await expect(page.getByRole('heading', { name: 'AI', level: 1 })).toBeVisible()
    const strip = page.getByRole('region', { name: 'AI status' })
    await expect(strip).toContainText('Off')
    await expect(page.getByRole('button', { name: 'New token' })).toBeDisabled()
    await expect(page.getByText('This server is only reachable from this computer.')).toBeVisible()
    await expect(page.getByRole('heading', { name: /What apps can do/ })).toBeVisible()
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])

    // On: asks first.
    await flip(page, 'ai-enabled')
    await confirmWithPassword(page, 'Turning on AI access lets connected apps reach your content.')
    await expect(page.getByRole('checkbox', { name: 'AI access' })).toBeChecked()
    await expect(strip).toContainText('connected apps aren’t allowed')
    expect((await post('/mcp')).status, 'still closed until connected apps are allowed').toBe(404)
    // Just verified: allowing connected apps does not ask again.
    await flip(page, 'ai-apps-allowed')
    await expect(page.getByRole('checkbox', { name: 'Allow connected apps' })).toBeChecked()
    await expect(page.getByRole('dialog', { name: /Confirm it’s you/ })).toHaveCount(0)
    const open = await post('/mcp')
    expect(open.status).toBe(401)
    expect(open.headers['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`)
    await expect(strip).toContainText('connected apps can read the site')

    // A token: a verification 3 minutes old is recent, but not fresh enough to make one.
    verifiedAgo(sid, 3 * 60_000)
    await page.getByRole('button', { name: 'New token' }).click()
    const form = page.getByRole('dialog', { name: /New personal token/ })
    await expect(form).toBeVisible()
    await expect(form.getByRole('radio', { name: /^Read and draft/ })).toBeChecked()
    await expect(form.getByRole('combobox', { name: 'Expires after' })).toHaveValue('90')
    await form.getByLabel(/^Name/).fill('e2e laptop')
    await form.getByRole('radio', { name: /^Read published/ }).check()
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    await form.getByRole('button', { name: 'Create token' }).click()
    await confirmWithPassword(page, 'A new token is a new way into the admin.')
    const done = page.getByRole('dialog', { name: /Copy your token/ })
    await expect(done).toBeVisible()
    await expect(done).toContainText('This token is shown once. Only its fingerprint is stored here.')
    const token = ((await done.locator('code').first().textContent()) ?? '').trim()
    expect(token).toMatch(/^pst_[A-Za-z0-9_-]{43}$/)
    await expect(done.locator('code').nth(1)).toHaveText(`claude mcp add --transport http --scope local site-local ${BASE}/mcp --header "Authorization: Bearer ${token}"`)
    await expect(done.locator('[data-first-call="waiting"]')).toContainText('Waiting for the first call from “e2e laptop”…')
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    await done.getByRole('button', { name: 'Done' }).click()
    await expect(done).toBeHidden()

    // Shown once: not on the page, not in the list the page reads.
    expect(await page.content()).not.toContain(token.slice(4, 36))
    const listed = await page.evaluate(async () => (await fetch('/api/admin/ai/tokens', { cache: 'no-store' })).text())
    expect(listed).not.toContain(token.slice(4, 36))
    const row = page.locator('[data-app-id]').filter({ hasText: 'e2e laptop' })
    await expect(row).toContainText(`pst_…${token.slice(-4)}`)
    await expect(row).toContainText('Read published')
    await expect(row).toContainText('not used yet')
    await expect(page.locator('[data-first-call="waiting"]')).toBeVisible()

    // tools/list by level: 8 at Read published; the other levels through the same route (verified just now).
    const read = await toolNames(token)
    expect(read).toHaveLength(8)
    expect(read).not.toContain('get_change')
    const more = await page.evaluate(async () => {
      const make = async (level: number) => {
        const res = await fetch('/api/admin/ai/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `e2e level ${level}`, level, days: 7 }) })
        return ((await res.json()) as { token: string }).token
      }
      return [await make(2), await make(3)]
    })
    expect((await toolNames(more[0])).length).toBe(11)
    expect((await toolNames(more[1])).length).toBe(11)

    // Connected: the page's 5-second poll sees the first call.
    await expect(page.locator('[data-first-call="connected"]')).toContainText('Connected.', { timeout: 15_000 })
    await expect(page.locator('[data-first-call="connected"]')).toContainText('It says it is “e2e client”.')
    await expect(row).toContainText('says it is “e2e client”')
    await expect(row).toContainText('last used')
    await expect(strip).toContainText('3')

    // The Security page counts them, per browser.
    await page.goto('/admin/security')
    await expect(page.getByText('3 AI apps can also reach this site.')).toBeVisible()
    await expect(page.getByText('3 AI apps were created from this browser.')).toBeVisible()

    // Revoking: no step-up, effective on the next request.
    await page.goto('/admin/ai')
    await row.getByRole('button', { name: 'Revoke e2e laptop' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveCount(0)
    const after = await post('/mcp', { token })
    expect(after.status).toBe(401)
    expect(after.headers['www-authenticate']).toContain('error="invalid_token"')

    // Off: instant, no step-up; the endpoint is gone again, and the remaining apps are revoked too when asked.
    await flip(page, 'ai-enabled')
    const off = page.getByRole('alertdialog', { name: 'Turn off AI access?' })
    await off.getByText('Also revoke every connected app', { exact: true }).click()
    await expect(off.getByRole('checkbox', { name: 'Also revoke every connected app' })).toBeChecked()
    await off.getByRole('button', { name: 'Turn off' }).click()
    await expect(page.getByRole('checkbox', { name: 'AI access' })).not.toBeChecked()
    await expect(page.getByRole('dialog', { name: /Confirm it’s you/ })).toHaveCount(0)
    expect((await post('/mcp', { token: more[0] })).status).toBe(404)
    await expect(page.locator('[data-app-id]')).toHaveCount(0)
  })

  test('phone width, reduced motion and dark mode: nothing overflows, the waiting dot stands still, axe stays clean', async ({ page }) => {
    test.setTimeout(90_000)
    closeEverything()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
    await loginAsAdmin(page, { fresh: true })
    const db = authDb()
    try {
      db.prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
    } finally {
      db.close()
    }
    await page.goto('/admin/ai')
    await expect(page.getByRole('heading', { name: /What apps can do/ })).toBeVisible()
    await page.getByRole('button', { name: 'New token' }).click()
    const form = page.getByRole('dialog', { name: /New personal token/ })
    await form.getByLabel(/^Name/).fill('A phone-width name for a token')
    await form.getByRole('button', { name: 'Create token' }).click()
    const done = page.getByRole('dialog', { name: /Copy your token/ })
    await expect(done).toBeVisible()
    await settle(page)
    await fitsWidth(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    const dot = done.locator('[data-first-call="waiting"] > span').first()
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await done.getByRole('button', { name: 'Done' }).click()

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), scheme).toEqual([])
    }
    // With motion allowed, the waiting dot pulses.
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
    const pageDot = page.locator('[data-first-call="waiting"] > span').first()
    expect(await pageDot.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none')
    closeEverything()
  })
})
