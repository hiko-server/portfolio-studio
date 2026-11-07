import path from 'node:path'
import Database from 'better-sqlite3'
import type { Locator, Page } from '@playwright/test'
import { ADMIN, expect, loginAsAdmin, seriousA11yViolations, settle, test, undersizedTargets } from './fixtures'

/**
 * The AI admin flows, on the standalone server scripts/ai-e2e.sh starts. Stage
 * P0 holds the harness check; the stages that build each flow add theirs here,
 * and M2 puts a draft write first (design §12.4: it proves the MDX worker chunk
 * is in the standalone output).
 */
const FAKE = process.env.E2E_FAKE_LLM_URL

// ── Drafts over /mcp (stage M2): first, because a draft write proves the MDX worker chunk is in the standalone output ──

/** tools/call in the modern era with a bearer token; the tool's JSON answer and whether it is an error. */
async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: any }> {
  const res = await post('/mcp', {
    token,
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': name, accept: 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'e2e drafts', version: '1' } } },
    },
  })
  expect(res.status, res.text).toBe(200)
  const result = JSON.parse(res.text).result as { isError?: boolean; content: Array<{ text: string }> }
  return { isError: result.isError === true, json: JSON.parse(result.content[0].text) }
}

test.describe('@ai drafts', () => {
  test('a Read and draft token writes a draft and unpublished changes through /mcp on the standalone server; the public pages stay as they were', async ({ page }) => {
    test.setTimeout(90_000)
    closeEverything()
    const db = authDb()
    try {
      db.prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
    } finally {
      db.close()
    }
    try {
      await loginAsAdmin(page, { fresh: true })
      const [readToken, draftToken] = await page.evaluate(async () => {
        const make = async (level: number) => {
          const res = await fetch('/api/admin/ai/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `e2e drafts ${level}`, level, days: 7 }) })
          return ((await res.json()) as { token: string }).token
        }
        return [await make(1), await make(2)]
      })
      expect(draftToken).toMatch(/^pst_/)

      // A new draft: the body passes the real compile in the worker, which must be in the standalone output.
      const body = '## Notes from the field\n\nA first paragraph with [a source](https://example.com/source).\n\n```ts\nconst answer: number = 42\n```\n'
      const created = await callTool(draftToken, 'create_draft', { collection: 'blog', slug: 'e2e-ai-draft', frontmatter: { title: 'An AI draft', date: '2026-06-01', description: 'Written over MCP' }, body })
      expect(created.isError, JSON.stringify(created.json)).toBe(false)
      expect(created.json.saved_as).toBe('draft')
      expect(created.json.change_id).toMatch(/^ch_[a-z2-7]{16}$/)
      const change = await callTool(draftToken, 'get_change', { change_id: created.json.change_id })
      expect([change.json.state, change.json.version]).toEqual(['applied', created.json.version])

      // Invisible to visitors and to a Read published token.
      expect((await fetch(`${BASE}/blog/e2e-ai-draft`)).status).toBe(404)
      expect((await callTool(readToken, 'get_content', { collection: 'blog', ref: 'e2e-ai-draft' })).json.error.code).toBe('NOT_FOUND')
      const index = await (await fetch(`${BASE}/blog`)).text()
      expect(index).not.toContain('e2e-ai-draft')
      expect(index).not.toContain('An AI draft')

      // A published post: the change is its unpublished changes; the public page keeps the published text.
      const live = await callTool(draftToken, 'get_content', { collection: 'blog', ref: 'example-field-notes' })
      expect(live.json.status).toBe('live')
      const text = String(live.json.body)
      // A word that occurs once, so the edit matches exactly one place.
      const firstWords = text.split(/[^A-Za-z]+/).find((w: string) => w.length >= 6 && text.split(w).length === 2) as string
      expect(firstWords).toBeTruthy()
      expect(await (await fetch(`${BASE}/blog/example-field-notes`)).text()).toContain(firstWords)
      const edited = await callTool(draftToken, 'edit_content', { collection: 'blog', slug: 'example-field-notes', edits: [{ find: firstWords, replace: 'Zanzibarian' }], base_version: live.json.version })
      expect(edited.isError, JSON.stringify(edited.json)).toBe(false)
      expect(edited.json.saved_as).toBe('unpublished_changes')
      const pageAfter = await (await fetch(`${BASE}/blog/example-field-notes`)).text()
      expect(pageAfter).not.toContain('Zanzibarian')
      expect(pageAfter, 'visitors still read the published text').toContain(firstWords)
      expect((await callTool(draftToken, 'get_content', { collection: 'blog', ref: 'example-field-notes' })).json.body).toContain('Zanzibarian')

      // A hostile body: refused by the worker's wall clock while the site keeps answering.
      const hostile = callTool(draftToken, 'create_draft', { collection: 'blog', slug: 'e2e-hostile', frontmatter: { title: 'Hostile', date: '2026-06-01' }, body: '[a]('.repeat(60_000) })
      const t0 = Date.now()
      const home = await fetch(`${BASE}/`)
      expect(home.status).toBe(200)
      expect(Date.now() - t0, 'the site answered while the body was checked').toBeLessThan(2500)
      const refused = await hostile
      expect([refused.isError, refused.json.error.code]).toEqual([true, 'MDX_TOO_COMPLEX'])
      expect((await callTool(draftToken, 'get_content', { collection: 'blog', ref: 'e2e-hostile' })).json.error.code).toBe('NOT_FOUND')
      // And the worker recovers for the next write.
      const after = await callTool(draftToken, 'edit_content', { collection: 'blog', slug: 'e2e-ai-draft', edits: [{ find: 'A first paragraph', replace: 'An opening paragraph' }], base_version: created.json.version })
      expect(after.isError, JSON.stringify(after.json)).toBe(false)
    } finally {
      closeEverything()
    }
  })
})

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

/**
 * A dialog that fits the screen: its box lies inside the viewport; each
 * control in `scrolled` lies inside that box once scrolled into view (the
 * dialog's body scrolls, the dialog itself stays put); each footer button
 * lies inside it without any scrolling, and a tap at its centre hits it, not
 * the page behind.
 */
async function fitsDialog(page: Page, dialog: Locator, scrolled: Array<[string, Locator]>, buttons: string[]): Promise<void> {
  const size = page.viewportSize() ?? { width: 0, height: 0 }
  const where = `${size.width}x${size.height}`
  const boxOf = async (what: string, el: Locator) => {
    const r = await el.boundingBox()
    expect(r, `${where}: ${what} has a box`).not.toBeNull()
    return r as NonNullable<typeof r>
  }
  const dialogBox = async () => {
    const d = await boxOf('the dialog', dialog)
    expect(d.y, `${where}: the dialog’s top is on screen`).toBeGreaterThanOrEqual(-0.5)
    expect(d.y + d.height, `${where}: the dialog’s bottom is on screen`).toBeLessThanOrEqual(size.height + 0.5)
    return d
  }
  const within = (what: string, b: { x: number; y: number; width: number; height: number }, d: typeof b) => {
    expect(b.y, `${where}: ${what} starts inside the dialog`).toBeGreaterThanOrEqual(d.y - 0.5)
    expect(b.y + b.height, `${where}: ${what} ends inside the dialog`).toBeLessThanOrEqual(d.y + d.height + 0.5)
    expect(b.x + b.width, `${where}: ${what} fits the dialog’s width`).toBeLessThanOrEqual(d.x + d.width + 0.5)
  }
  const before = await dialogBox()
  for (const name of buttons) {
    const button = dialog.getByRole('button', { name, exact: true })
    within(`“${name}”`, await boxOf(name, button), before)
    const hits = await button.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && (hit === el || el.contains(hit))
    })
    expect(hits, `${where}: a tap on “${name}” reaches it`).toBe(true)
  }
  for (const [what, el] of scrolled) {
    await el.scrollIntoViewIfNeeded()
    within(what, await boxOf(what, el), await dialogBox())
  }
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
    await page.goto('/admin/ai?view=connections')
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
    // The only copy of the token: neither Escape nor Done closes the view before the owner says it is saved.
    const doneButton = done.getByRole('button', { name: 'Done' })
    await expect(doneButton).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(done).toBeVisible()
    // Chakra's checkbox input is visually hidden: tick it where a person does, on its label.
    await done.getByText('I have saved this token somewhere safe', { exact: true }).click()
    await expect(done.getByRole('checkbox', { name: 'I have saved this token somewhere safe' })).toBeChecked()
    await doneButton.click()
    await expect(done).toBeHidden()

    // Shown once: not on the page, not in the list the page reads.
    expect(await page.content()).not.toContain(token.slice(4, 36))
    const listed = await page.evaluate(async () => (await fetch('/api/admin/ai/tokens', { cache: 'no-store' })).text())
    expect(listed).not.toContain(token.slice(4, 36))
    const row = page.locator('[data-app-id]').filter({ hasText: 'e2e laptop' })
    await expect(row).toContainText(`pst_…${token.slice(-4)}`)
    await expect(row).toContainText('Read published')
    await expect(row).toContainText('not used yet')
    await expect(row).toContainText('made just now')
    await expect(row).not.toContainText('in a moment')
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
    // Read and draft adds the change reads and the three draft-safe writes (stage M2); propose adds the ten proposals (M3).
    expect((await toolNames(more[0])).length).toBe(14)
    const level3 = await toolNames(more[1])
    expect(level3).toHaveLength(24)
    expect(level3.filter((n) => n.startsWith('propose_'))).toHaveLength(10)

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
    await page.goto('/admin/ai?view=connections')
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
    await page.goto('/admin/ai?view=connections')
    await expect(page.getByRole('heading', { name: /What apps can do/ })).toBeVisible()
    await page.getByRole('button', { name: 'New token' }).click()
    const form = page.getByRole('dialog', { name: /New personal token/ })
    await expect(form).toBeVisible()
    await settle(page)
    // The form fits the dialog on every phone: its body scrolls, Cancel and Create token stay inside and tappable.
    for (const [width, height] of [[375, 812], [375, 667], [320, 568]] as const) {
      await page.setViewportSize({ width, height })
      await settle(page)
      await fitsDialog(
        page,
        form,
        [
          ['the name field', form.getByLabel(/^Name/)],
          ['the last access level', form.getByRole('radio').last()],
          ['“Expires after”', form.getByRole('combobox', { name: 'Expires after' })],
        ],
        ['Cancel', 'Create token'],
      )
    }
    await fitsWidth(page)
    await page.setViewportSize({ width: 375, height: 812 })
    await form.getByLabel(/^Name/).fill('A phone-width name for a token')
    await form.getByRole('button', { name: 'Create token' }).click()
    const done = page.getByRole('dialog', { name: /Copy your token/ })
    await expect(done).toBeVisible()
    await settle(page)
    await fitsWidth(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    const dot = done.locator('[data-first-call="waiting"] > span').first()
    expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    // A clipboard the browser refuses (and no fallback): the token is selected and the page says to copy it by hand.
    const shown = ((await done.locator('code').first().textContent()) ?? '').trim()
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) } })
      document.execCommand = () => false
    })
    await done.getByRole('button', { name: /^Copy token/ }).click()
    await expect(done.getByRole('status').filter({ hasText: 'Couldn’t copy. The text is selected: copy it yourself.' })).toBeVisible()
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(selected === shown && shown.startsWith('pst_'), 'the token is the selection').toBe(true)
    await fitsWidth(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(done).toBeVisible()
    // Chakra's checkbox input is visually hidden: tick it where a person does, on its label.
    await done.getByText('I have saved this token somewhere safe', { exact: true }).click()
    await expect(done.getByRole('checkbox', { name: 'I have saved this token somewhere safe' })).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(done, 'once saved, Escape closes it like Done').toBeHidden()

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), scheme).toEqual([])
    }
    // WCAG 2.2 target size on a phone: every control of the page is at least 24 px or spaced like one.
    expect(await undersizedTargets(page)).toEqual([])
    // With motion allowed, the waiting dot pulses.
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
    const pageDot = page.locator('[data-first-call="waiting"] > span').first()
    expect(await pageDot.evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none')
    closeEverything()
  })

  test('when the apps can’t be revoked: the browser is signed out, the Security page warns and links to Connections; turning off says so too', async ({ page, browser }) => {
    test.setTimeout(90_000)
    closeEverything()
    const db = authDb()
    try {
      db.prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
    } finally {
      db.close()
    }
    await loginAsAdmin(page, { fresh: true })
    // Another browser, told apart by its device label, makes an app.
    const other = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' })
    let undo = () => {}
    try {
      const otherPage = await other.newPage()
      await loginAsAdmin(otherPage, { fresh: true })
      const made = await otherPage.evaluate(async () => {
        const res = await fetch('/api/admin/ai/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e other browser', level: 1, days: 7 }) })
        return res.status
      })
      expect(made).toBe(201)
      // From here every revoke fails in the server's auth.db, as a broken store would.
      const failing = authDb()
      failing.exec("CREATE TRIGGER e2e_revoke_fails BEFORE UPDATE OF revoked_at ON ai_grants BEGIN SELECT RAISE(ABORT, 'synthetic store failure'); END")
      failing.close()
      undo = () => {
        const d = authDb()
        try {
          d.exec('DROP TRIGGER IF EXISTS e2e_revoke_fails')
        } finally {
          d.close()
        }
      }

      await page.goto('/admin/security')
      await expect(page.getByText('1 AI app was created from this browser.')).toBeVisible()
      await page.getByRole('button', { name: /^Sign out Firefox on Linux/ }).click()
      await expect(page.locator('.chakra-toast[data-toast-status="warning"]')).toContainText('The AI apps couldn’t be ended, so they may still reach this site.')
      await expect(page.getByRole('button', { name: /^Sign out Firefox on Linux/ })).toHaveCount(0)
      const note = page.getByTestId('ai-apps-not-ended')
      await expect(note).toContainText('The AI apps couldn’t be ended: 1 AI app can still reach this site. Check Connections and revoke any you don’t trust.')
      await expect(note.getByRole('link', { name: 'Open Connections' })).toHaveAttribute('href', '/admin/ai?view=connections')
      await settle(page)
      expect(await seriousA11yViolations(page)).toEqual([])
      // The signed-out browser is out all the same.
      await otherPage.goto('/admin/ai')
      await expect(otherPage).toHaveURL(/\/admin\/login/)

      // Turning AI access off with "Also revoke every connected app": off, and the page says the apps weren't revoked.
      await page.goto('/admin/ai?view=connections')
      await expect(page.locator('[data-app-id]').filter({ hasText: 'e2e other browser' })).toHaveCount(1)
      await flip(page, 'ai-enabled')
      const off = page.getByRole('alertdialog', { name: 'Turn off AI access?' })
      await off.getByText('Also revoke every connected app', { exact: true }).click()
      await off.getByRole('button', { name: 'Turn off' }).click()
      await expect(page.getByRole('checkbox', { name: 'AI access' })).not.toBeChecked()
      const warned = page.locator('.chakra-toast[data-toast-status="warning"]').filter({ hasText: 'AI access is off' })
      await expect(warned).toContainText('The connected apps couldn’t be revoked.')
      await expect(page.locator('[data-app-id]').filter({ hasText: 'e2e other browser' })).toHaveCount(1)
      expect((await post('/mcp')).status, 'closed all the same').toBe(404)
    } finally {
      undo()
      await other.close()
      closeEverything()
    }
  })
})

// ── AI changes: the change card, Changes, the review page (stage M3b) ───────

/**
 * Waiting changes of earlier runs voided, as revoking their apps does in the product (closeEverything revokes in
 * the store directly), so each test counts only its own.
 */
function voidWaitingChanges(): void {
  const db = new Database(path.join(DATA_DIR, 'ai.db'), { fileMustExist: true, timeout: 5000 })
  try {
    db.prepare("UPDATE ai_changes SET state = 'voided', error_code = 'ISSUER_ENDED', decided_at = ? WHERE state = 'waiting'").run(Date.now())
  } finally {
    db.close()
  }
}

/** AI access and connected apps on, in the server's store (the Connections tests flip the switches themselves). */
function openAi(): void {
  voidWaitingChanges()
  const db = authDb()
  try {
    db.prepare('UPDATE ai_settings SET enabled = 1, mcp_enabled = 1 WHERE id = 1').run()
  } finally {
    db.close()
  }
}

/** A personal token at `level`, made by this signed-in browser (a fresh sign-in: the route asks for one). */
async function mintToken(page: Page, name: string, level = 3): Promise<string> {
  const token = await page.evaluate(
    async ({ name, level }) => {
      const res = await fetch('/api/admin/ai/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, level, days: 7 }) })
      return ((await res.json()) as { token?: string }).token ?? ''
    },
    { name, level },
  )
  expect(token).toMatch(/^pst_/)
  return token
}

/** A tool call that must succeed, its JSON answer. */
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await callTool(token, name, args)
  expect(out.isError, `${name}: ${JSON.stringify(out.json)}`).toBe(false)
  return out.json
}

/** Arm a card the way a person does (design §5.3): it has been on screen a second, then the pointer moves inside it. */
async function arm(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box, 'the card has a box').not.toBeNull()
  const b = box as NonNullable<typeof box>
  await page.mouse.move(b.x + 24, b.y + 24)
  await page.waitForTimeout(1150)
  await page.mouse.move(b.x + 40, b.y + 32)
}

/**
 * A page of another site with one link on it: served on the IPv6 loopback, http://[::1]:<port>, which is another
 * site than 127.0.0.1 (so a navigation from it to the admin is cross-site), and one address only, so nothing
 * depends on how "localhost" resolves.
 */
async function otherSite(href: string): Promise<{ url: string; close: () => Promise<void> }> {
  const http = await import('node:http')
  const html = `<!doctype html><meta charset="utf-8"><title>Another site</title><a id="go" href="${href}">Review the change</a>`
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
    res.end(html)
  })
  const port: number = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '::1', () => resolve((server.address() as { port: number }).port))
  })
  return {
    url: `http://[::1]:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

test.describe('@ai changes', () => {
  // Slugs of this run: the specs can run again against the same server.
  const run = Date.now().toString(36)
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')
  test.beforeAll(() => expect(DATA_DIR, 'E2E_SERVER_DATA_DIR (scripts/ai-e2e.sh)').toBeTruthy())
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('theme-preference', 'system')
      } catch {
        /* storage blocked: the default theme applies */
      }
    })
  })
  test.afterAll(closeEverything)

  test('a proposal over /mcp; its review URL opened from another site lands signed in, no login flash; Approve arms; Live now; Undo', async ({ page }) => {
    test.setTimeout(150_000)
    closeEverything()
    openAi()
    await loginAsAdmin(page, { fresh: true })
    const token = await mintToken(page, 'e2e reviewer')
    await tool(token, 'create_draft', { collection: 'blog', slug: `e2e-review-note-${run}`, frontmatter: { title: 'A note to review', date: '2026-06-02', description: 'A short synthetic note written over MCP for the review flow.' }, body: 'A first line.\n\nA second line.\n' })
    const version = (await tool(token, 'get_content', { collection: 'blog', ref: `e2e-review-note-${run}`, include_body: false })).version
    const proposed = await tool(token, 'propose_publishing', { collection: 'blog', slug: `e2e-review-note-${run}`, action: 'publish', base_version: version, rationale: 'Ready to go live.' })
    expect(proposed.status).toBe('waiting_for_owner')
    const id = proposed.change_id as string
    expect(proposed.review_url).toBe(`${BASE}/ai/review/${id}`)
    expect((await fetch(`${BASE}/blog/e2e-review-note-${run}`)).status).toBe(404)

    // Control: a direct link from another site to the admin page passes the sign-in page (the Strict cookie stays
    // home on a cross-site navigation), which then sends this signed-in browser on: the flash the bounce avoids.
    const navigations: string[] = []
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(new URL(r.url()).pathname)
    })
    const direct = await otherSite(`${BASE}/admin/ai/change/${id}`)
    try {
      await page.goto(direct.url)
      await expect(page.locator('#go'), `the other site’s page (${page.url()})`).toBeVisible()
      await page.locator('#go').click()
      await page.waitForURL(`${BASE}/admin/ai/change/${id}`)
      await expect(page.locator(`[data-change-id="${id}"]`)).toBeVisible()
    } finally {
      await direct.close()
    }
    expect(navigations.filter((p) => p.startsWith('/admin/login')).length, 'a direct cross-site link meets the sign-in page').toBeGreaterThan(0)
    await page.goto('about:blank')
    navigations.length = 0

    // The review URL: its bounce is a same-site navigation, so the admin opens signed in.
    const site = await otherSite(proposed.review_url)
    try {
      await page.goto(site.url)
      await expect(page.locator('#go'), `the other site’s page (${page.url()})`).toBeVisible()
      await page.locator('#go').click()
      await page.waitForURL(`${BASE}/admin/ai/change/${id}`)
    } finally {
      await site.close()
    }
    expect(navigations).toContain(`/ai/review/${id}`)
    expect(navigations.filter((p) => p.startsWith('/admin/login')), 'no login flash').toEqual([])
    await expect(page.getByRole('heading', { name: `e2e reviewer wants to publish post e2e-review-note-${run}`, level: 1 })).toBeVisible()
    const card = page.locator(`[data-change-id="${id}"]`)
    await expect(card).toBeVisible()
    await expect(card).toContainText(`Goes live at /blog/e2e-review-note-${run}`)
    await expect(card).toContainText('The model says: “Ready to go live.”')
    await expect(card).toContainText('Undo restores the site, not what readers, feeds, IndexNow or crawlers already fetched.')

    // No focus theft; Approve is off until the card is armed (a second on screen, then the pointer inside it).
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-change-id]')), 'the card never takes the focus').toBe(false)
    const approve = card.getByTestId('change-approve')
    await expect(approve).toHaveText('Approve & publish')
    await expect(approve).toBeDisabled()
    await page.mouse.move(5, 5)
    await page.waitForTimeout(1200)
    await expect(approve, 'a second on screen alone does not arm it').toBeDisabled()
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    await arm(page, card)
    await expect(approve).toBeEnabled()
    await approve.click()

    await expect(page.getByTestId('change-outcome')).toHaveText('Published. e2e reviewer will see this the next time it checks.')
    await expect(card).toHaveAttribute('data-change-state', 'applied')
    await expect(card.getByTestId('change-done')).toContainText(`Published e2e-review-note-${run}`)
    await expect(card.getByRole('link', { name: new RegExp(`/blog/e2e-review-note-${run}`) })).toBeVisible()
    expect((await fetch(`${BASE}/blog/e2e-review-note-${run}`)).status, 'live now').toBe(200)
    expect((await tool(token, 'get_change', { change_id: id })).state).toBe('applied')

    // The 8-second toast for the change just taken: its Undo puts the site back.
    const toast = page.locator('.chakra-toast').filter({ hasText: `Published e2e-review-note-${run}` })
    await expect(toast).toBeVisible()
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(card).toHaveAttribute('data-change-state', 'undone')
    await expect(card).toContainText('Undone: the site is back to how it was before this change.')
    expect((await fetch(`${BASE}/blog/e2e-review-note-${run}`)).status, 'off the site again').toBe(404)
    expect((await tool(token, 'get_change', { change_id: id })).state).toBe('undone')
    closeEverything()
  })

  test('Changes: a long diff can’t be approved until read to its end, by keyboard too; a delete asks “Confirm it’s you”; R rejects with a note the app reads', async ({ page }) => {
    test.setTimeout(180_000)
    closeEverything()
    openAi()
    await loginAsAdmin(page, { fresh: true })
    const sid = await sessionIdOf(page)
    const token = await mintToken(page, 'e2e queue')
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of a long synthetic note.`).join('\n\n')
    await tool(token, 'create_draft', { collection: 'blog', slug: `e2e-long-note-${run}`, frontmatter: { title: 'A long note', date: '2026-06-03', description: 'A long synthetic note written over MCP for the read-to-the-end rule.' }, body: long })
    const longVersion = (await tool(token, 'get_content', { collection: 'blog', ref: `e2e-long-note-${run}`, include_body: false })).version
    const pub = await tool(token, 'propose_publishing', { collection: 'blog', slug: `e2e-long-note-${run}`, action: 'publish', base_version: longVersion, rationale: 'Ready.' })
    await tool(token, 'create_draft', { collection: 'blog', slug: `e2e-doomed-${run}`, frontmatter: { title: 'Doomed', date: '2026-06-03' }, body: 'Nothing to keep.' })
    const doomedVersion = (await tool(token, 'get_content', { collection: 'blog', ref: `e2e-doomed-${run}`, include_body: false })).version
    const del = await tool(token, 'propose_delete', { target: 'post', ref: `e2e-doomed-${run}`, base_version: doomedVersion, rationale: 'A duplicate.' })
    const uses = await tool(token, 'get_content', { collection: 'page', ref: 'uses' })
    const line = String(uses.body).split('\n').find((l: string) => l.trim().length > 12) as string
    const edit = await tool(token, 'propose_page_edit', { name: 'uses', edits: [{ find: line, replace: `${line} (checked)` }], base_version: uses.version, rationale: 'Freshen it.' })

    await page.goto('/admin/ai?view=changes')
    await expect(page.getByRole('tab', { name: 'Changes (3)' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Waiting (3)' })).toHaveAttribute('aria-selected', 'true')
    const rows = page.getByTestId('ai-changes')
    await expect(rows.locator('[data-row-change]')).toHaveCount(3)
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])

    // The long one: twelve lines on the card, Approve off until the sheet has been read to its end.
    await rows.locator(`[data-row-change="${pub.change_id}"] > button`).click()
    const card = page.locator(`[data-change-id="${pub.change_id}"]`)
    const approve = card.getByTestId('change-approve')
    await expect(approve).toHaveText(/^Read all \d+ changed lines first$/)
    await arm(page, card)
    await expect(approve, 'armed, but not read').toBeDisabled()
    await card.getByRole('button', { name: /^Review all/ }).last().click()
    const sheet = page.getByTestId('change-sheet')
    await expect(sheet).toBeVisible()
    const sheetApprove = sheet.getByTestId('sheet-approve')
    await expect(sheetApprove).toBeDisabled()
    await expect(sheet).toContainText('Scroll to the end of the change to approve it.')
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    // The keyboard reads the sheet to its end from the Changes view too: the list under the open row leaves the
    // sheet's keys alone (React bubbles a portal's keys up to the list). Enter and j in the body are the sheet's,
    // ArrowDown scrolls it, End reaches its end.
    const sheetBody = sheet.getByLabel('The whole change', { exact: true })
    const pubRow = rows.locator(`[data-row-change="${pub.change_id}"] > button`)
    const scrollTop = () => sheetBody.evaluate((el) => el.scrollTop)
    const scrollMax = await sheetBody.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(scrollMax, 'the long change scrolls inside the sheet').toBeGreaterThan(100)
    await sheetBody.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('j')
    await expect(sheet, 'Enter and j in the sheet’s body leave it open').toBeVisible()
    await expect(pubRow, 'and the row expanded').toHaveAttribute('aria-expanded', 'true')
    await expect(sheetBody, 'and the focus where it was').toBeFocused()
    expect(await scrollTop()).toBe(0)
    await page.keyboard.press('ArrowDown')
    await expect.poll(scrollTop, { message: 'ArrowDown scrolls the sheet' }).toBeGreaterThan(0)
    await expect(sheet).toContainText('Scroll to the end of the change to approve it.')
    await page.keyboard.press('End')
    // Measured live: the footer's words change once the end is read, and the body's height with them.
    const atEnd = () => sheetBody.evaluate((el) => el.scrollTop > 0 && el.scrollTop >= el.scrollHeight - el.clientHeight - 1)
    await expect.poll(atEnd, { message: 'End reaches the end of the change' }).toBe(true)
    await expect(sheet).toContainText('You’ve read the whole change.')
    await expect(pubRow).toHaveAttribute('aria-expanded', 'true')
    await arm(page, sheet)
    await expect(sheetApprove).toHaveText('Approve & publish')
    await expect(sheetApprove).toBeEnabled()
    // The Preview tab draws the proposed text with the site's renderer.
    await sheet.getByRole('tab', { name: 'Preview' }).click()
    await expect(sheet.getByTestId('change-preview')).toContainText('Paragraph 30 of a long synthetic note.')
    await sheetApprove.click()
    await expect(sheet).toBeHidden()
    await expect(card).toHaveAttribute('data-change-state', 'applied')
    await expect(rows.locator(`[data-row-change="${pub.change_id}"] [data-state="applied"]`)).toBeVisible()
    expect((await fetch(`${BASE}/blog/e2e-long-note-${run}`)).status).toBe(200)

    // A delete: destructive, so "Confirm it's you" once the sign-in is older than the recent window.
    verifiedAgo(sid, 15 * 60_000)
    await rows.locator(`[data-row-change="${del.change_id}"] > button`).click()
    const delCard = page.locator(`[data-change-id="${del.change_id}"]`)
    const delApprove = delCard.getByTestId('change-approve')
    await expect(delApprove).toHaveText('Approve & delete')
    await expect(delCard).toContainText('Deletes the draft. Visitors never saw it.')
    await expect(delCard, 'a draft reached no reader: nothing to have fetched').not.toContainText('already fetched')
    await arm(page, delCard)
    await expect(delApprove).toBeEnabled()
    await delApprove.click()
    await confirmWithPassword(page, `Deleting “e2e-doomed-${run}” takes it off the site.`)
    await expect(delCard).toHaveAttribute('data-change-state', 'applied')
    expect((await callTool(token, 'get_content', { collection: 'blog', ref: `e2e-doomed-${run}` })).json.error.code).toBe('NOT_FOUND')

    // J / K move between rows, Enter opens one; R inside the open card asks why; the app reads the note.
    await page.locator('body').click({ position: { x: 2, y: 400 } })
    await page.keyboard.press('j')
    await page.keyboard.press('j')
    await page.keyboard.press('j')
    await expect(rows.locator(`[data-row-change="${edit.change_id}"] > button`)).toBeFocused()
    await page.keyboard.press('Enter')
    const editCard = page.locator(`[data-change-id="${edit.change_id}"]`)
    await expect(editCard).toBeVisible()
    await editCard.getByRole('button', { name: /^Review all/ }).focus()
    await page.keyboard.press('r')
    const note = editCard.getByLabel('Tell it why (optional)')
    await expect(note).toBeFocused()
    await note.fill('Keep the page as it is.')
    await editCard.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(editCard).toHaveAttribute('data-change-state', 'rejected')
    await expect(editCard).toContainText('You said: “Keep the page as it is.”')
    const told = await tool(token, 'get_change', { change_id: edit.change_id })
    expect([told.state, told.owner_note]).toEqual(['rejected', 'Keep the page as it is.'])
    await expect(page.getByRole('tab', { name: 'Changes' })).toBeVisible()

    // Done lists this test's three decisions among every decided change of the run (the other tests' too), so they
    // are found by id and state, not counted. Waiting's request is held back past the moment Done is chosen and
    // then let through: the page has aborted it by then (it is not the list on screen), and an answer that still
    // came would be dropped. Either way the Waiting rows never show under Done.
    const waitingList = /\/api\/admin\/ai\/changes\?(?:.*&)?state=waiting(?:&|$)/
    let released: () => void = () => {}
    const heldBack = new Promise<void>((resolve) => (released = resolve))
    await page.route(waitingList, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      // Throws when the page has aborted the request meanwhile: that is the point.
      await route.continue().catch(() => {})
      released()
    })
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Done' })).toBeVisible()
    const doneAnswer = page.waitForResponse((r) => /\/api\/admin\/ai\/changes\?(?:.*&)?state=done(?:&|$)/.test(r.url()))
    await page.getByRole('tab', { name: 'Done' }).click()
    await expect(page.getByRole('tab', { name: 'Done' })).toHaveAttribute('aria-selected', 'true')
    await doneAnswer
    await heldBack
    await page.unroute(waitingList)
    // Long enough for an answer let through to reach the page and be drawn, if the page still took it.
    await page.waitForTimeout(1000)
    for (const [change, state] of [[pub.change_id, 'applied'], [del.change_id, 'applied'], [edit.change_id, 'rejected']] as const) {
      await expect(rows.locator(`[data-row-change="${change}"] [data-state="${state}"]`), `${change} under Done`).toBeVisible()
    }
    await expect(rows.locator('[data-state="waiting"]'), 'no waiting change under Done').toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Done' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: 'All calls' }).click()
    const calls = page.getByTestId('ai-calls')
    await expect(calls).toContainText('Propose publishing')
    await expect(calls).toContainText(`e2e-long-note-${run}`)
    expect(await calls.textContent()).not.toContain('Paragraph 1 of a long synthetic note')
    closeEverything()
  })

  test('approving after the page was edited in another tab: conflict, nothing written; the app sees it', async ({ browser, baseURL, extraHTTPHeaders }) => {
    test.setTimeout(120_000)
    closeEverything()
    openAi()
    // Its own browser, so the one console error this test means to cause can be told apart: the approve's 409.
    const context = await browser.newContext({ baseURL, extraHTTPHeaders })
    const page = await context.newPage()
    const problems: string[] = []
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      if (/Failed to load resource: the server responded with a status of 409/.test(m.text()) && /\/api\/admin\/ai\/changes\/ch_[a-z2-7]{16}\/approve$/.test(m.location().url)) return
      problems.push(m.text())
    })
    page.on('pageerror', (e) => problems.push(e.message))
    try {
      await loginAsAdmin(page, { fresh: true })
      const token = await mintToken(page, 'e2e conflict')
      const now = await tool(token, 'get_content', { collection: 'page', ref: 'now' })
      const line = String(now.body).split('\n').find((l: string) => l.trim().length > 12) as string
      const proposed = await tool(token, 'propose_page_edit', { name: 'now', edits: [{ find: line, replace: `${line} (proposed)` }], base_version: now.version, rationale: 'A small edit.' })
      const id = proposed.change_id as string

      await page.goto(`/admin/ai/change/${id}`)
      const card = page.locator(`[data-change-id="${id}"]`)
      await expect(card).toBeVisible()
      // The owner edits /now in another tab meanwhile.
      const other = await context.newPage()
      await other.goto('/admin')
      const saved = await other.evaluate(async () => {
        const read = await (await fetch('/api/admin/page?name=now', { cache: 'no-store' })).json()
        const res = await fetch('/api/admin/page', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'now', frontmatter: read.frontmatter, body: `${read.body}\n\nThe owner’s own line.` }) })
        return res.status
      })
      expect(saved).toBe(200)
      await other.close()

      await arm(page, card)
      await card.getByTestId('change-approve').click()
      await expect(card).toHaveAttribute('data-change-state', 'conflict')
      await expect(card).toContainText('This changed after it was proposed.')
      await expect(card).toContainText('Nothing was written. e2e conflict sees this the next time it checks')
      const live = await (await fetch(`${BASE}/now`)).text()
      expect(live).toContain('The owner’s own line.')
      expect(live).not.toContain('(proposed)')
      expect((await tool(token, 'get_change', { change_id: id })).state).toBe('conflict')
      expect(problems).toEqual([])
    } finally {
      await context.close()
      closeEverything()
    }
  })

  test('a publish a check blocks: armed and read to its end, Approve stays off, the card and the sheet say why; nothing goes live', async ({ page }) => {
    test.setTimeout(90_000)
    closeEverything()
    openAi()
    await loginAsAdmin(page, { fresh: true })
    const token = await mintToken(page, 'e2e blocked')
    const slug = `e2e-untitled-${run}`
    // The AI can't write a title of only spaces any more…
    const refused = await callTool(token, 'create_draft', { collection: 'blog', slug, frontmatter: { title: '   ', date: '2026-06-05' }, body: 'Words.' })
    expect([refused.isError, refused.json.error.code]).toEqual([true, 'INVALID_INPUT'])
    // …but the owner's own save still can, and an app may then propose publishing that draft.
    const saved = await page.evaluate(async (slug) => {
      const res = await fetch('/api/admin/posts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, frontmatter: { title: '   ', date: '2026-06-05', draft: true }, body: 'Words.', create: true }) })
      return res.status
    }, slug)
    expect(saved).toBe(200)
    const version = (await tool(token, 'get_content', { collection: 'blog', ref: slug, include_body: false })).version
    const proposed = await tool(token, 'propose_publishing', { collection: 'blog', slug, action: 'publish', base_version: version, rationale: 'Ready.' })
    const id = proposed.change_id as string

    await page.goto(`/admin/ai/change/${id}`)
    const card = page.locator(`[data-change-id="${id}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByRole('list', { name: 'Publish checks' })).toContainText('Add a title')
    const blockedLine = 'A publish check blocks this: “Add a title”. Reject it and say why, so it can be fixed and proposed again.'
    await expect(card.getByTestId('change-blocked')).toHaveText(blockedLine)
    const approve = card.getByTestId('change-approve')
    await expect(approve).toHaveText('Approve & publish')
    await expect(approve).toHaveAccessibleDescription(blockedLine)
    await arm(page, card)
    await expect(approve).toHaveAttribute('data-armed', 'true')
    await expect(approve, 'armed, and still off').toBeDisabled()
    // A inside the card does nothing either.
    await card.getByRole('button', { name: /^Review all/ }).focus()
    await page.keyboard.press('a')
    await page.waitForTimeout(300)
    await expect(card).toHaveAttribute('data-change-state', 'waiting')

    // The sheet: read to its end (a short change is read as soon as it opens), armed, and its Approve off, saying why.
    await card.getByRole('button', { name: /^Review all/ }).click()
    const sheet = page.getByTestId('change-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId('sheet-status')).toHaveText(blockedLine)
    await arm(page, sheet)
    const sheetApprove = sheet.getByTestId('sheet-approve')
    await expect(sheetApprove).toHaveAttribute('data-armed', 'true')
    await expect(sheetApprove).toHaveText('Approve & publish')
    await expect(sheetApprove).toBeDisabled()
    await settle(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()

    expect((await fetch(`${BASE}/blog/${slug}`)).status, 'nothing went live').toBe(404)
    expect((await tool(token, 'get_change', { change_id: id })).state).toBe('waiting')
    // Reject stays open to the owner, with the reason for the app.
    await card.getByRole('button', { name: 'Reject', exact: true }).click()
    await card.getByLabel('Tell it why (optional)').fill('Give it a title first.')
    await card.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(card).toHaveAttribute('data-change-state', 'rejected')
    const told = await tool(token, 'get_change', { change_id: id })
    expect([told.state, told.owner_note]).toEqual(['rejected', 'Give it a title first.'])
    closeEverything()
  })

  test('phone width, reduced motion and dark mode: the Changes view, an open card, a flagged card, the sheet and the review page hold up; axe stays clean', async ({ page }) => {
    test.setTimeout(150_000)
    closeEverything()
    openAi()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
    await loginAsAdmin(page, { fresh: true })
    const token = await mintToken(page, 'e2e phone')
    const home = await tool(token, 'get_home', {})
    const proposed = await tool(token, 'propose_home_edit', { ops: [{ path: 'hero.tagline', value_json: JSON.stringify('A tagline proposed from a phone-width test.') }], base_version: home.version, rationale: 'Shorter.' })
    const id = proposed.change_id as string
    // A card with flags: AI wrote this draft (its link to that change sits in running text) and a new link with a query.
    const flaggedSlug = `e2e-flagged-note-${run}`
    await tool(token, 'create_draft', { collection: 'blog', slug: flaggedSlug, frontmatter: { title: 'A flagged note', date: '2026-06-04', description: 'A synthetic note with a new link, written over MCP for the dark-mode check.' }, body: 'A line with [a source](https://example.com/source?ref=e2e).\n' })
    const flaggedVersion = (await tool(token, 'get_content', { collection: 'blog', ref: flaggedSlug, include_body: false })).version
    const flagged = (await tool(token, 'propose_publishing', { collection: 'blog', slug: flaggedSlug, action: 'publish', base_version: flaggedVersion, rationale: 'Ready.' })).change_id as string

    await page.goto('/admin/ai?view=changes')
    const rows = page.getByTestId('ai-changes')
    await rows.locator(`[data-row-change="${id}"] > button`).click()
    const card = page.locator(`[data-change-id="${id}"]`)
    await expect(card).toContainText('hero.tagline')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), scheme).toEqual([])
    }
    expect(await undersizedTargets(page)).toEqual([])
    // Approve first and Reject second, full width, 44 px on a phone.
    const approve = card.getByTestId('change-approve')
    const reject = card.getByRole('button', { name: 'Reject', exact: true })
    const [a, r] = [await approve.boundingBox(), await reject.boundingBox()]
    expect(a && r && a.y < r.y && a.height >= 44 && r.height >= 44 && a.width > 300).toBe(true)

    await card.getByRole('button', { name: /^Review all/ }).last().click()
    const sheet = page.getByTestId('change-sheet')
    await expect(sheet).toBeVisible()
    await settle(page)
    await fitsWidth(page)
    expect(await seriousA11yViolations(page)).toEqual([])
    const box = await sheet.boundingBox()
    expect(box && box.y > 0 && box.y + box.height <= 812.5, 'a bottom sheet on the screen').toBe(true)
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()

    // The flagged card, open in Changes: its links inside text read as links in both themes (not by colour alone).
    await rows.locator(`[data-row-change="${flagged}"] > button`).click()
    const flaggedCard = page.locator(`[data-change-id="${flagged}"]`)
    const flags = flaggedCard.getByTestId('change-flags')
    await expect(flags).toContainText('AI wrote to this before.')
    await expect(flags.getByRole('link', { name: 'Open that change' })).toBeVisible()
    await expect(flags).toContainText('https://example.com/source?ref=e2e')
    await expect(flags).toContainText('⚑ query string')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), `Changes, flagged card, ${scheme}`).toEqual([])
    }

    for (const change of [id, flagged]) {
      await page.goto(`/admin/ai/change/${change}`)
      await expect(page.locator(`[data-change-id="${change}"]`)).toBeVisible()
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
        await settle(page)
        await fitsWidth(page)
        expect(await seriousA11yViolations(page), `review page ${change === id ? 'home edit' : 'flagged publish'}, ${scheme}`).toEqual([])
      }
      expect(await undersizedTargets(page)).toEqual([])
    }
    closeEverything()
  })
})
