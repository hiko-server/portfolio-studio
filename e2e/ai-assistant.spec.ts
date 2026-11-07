import path from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { ADMIN, expect, loginAsAdmin, seriousA11yViolations, settle, test, undersizedTargets } from './fixtures'

/**
 * The assistant's run stream through the REAL proxy (proxy.ts, its CSRF and
 * admin gate) on the standalone production build scripts/ai-e2e.sh starts,
 * with tests/helpers/fake-llm.mjs as an ordinary Custom provider (design
 * §7.7, §14 M4: "SSE through the real proxy in a local build"). The browser
 * reads the stream the way the admin will: a same-origin fetch whose body is
 * read as it arrives. The UI's flows (stage M4b) follow in `@ai assistant ui`.
 */
const FAKE = process.env.E2E_FAKE_LLM_URL || ''
const DATA_DIR = process.env.E2E_SERVER_DATA_DIR || ''

type Frame = { event: string; id: number | null; data: Record<string, any>; t: number }
type Read = { status: number; headers: Record<string, string>; frames: Frame[]; json: unknown }

/** Script the fake's next answers (out of process: JSON, no Origin). */
async function enqueue(...turns: unknown[]): Promise<void> {
  const res = await fetch(`${FAKE}/__fake/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turns }) })
  expect(res.status).toBe(200)
}

/** A same-origin request from the page, its event stream read frame by frame with arrival times (ms since the request). */
async function inPage(page: Page, url: string, init: { method?: string; body?: unknown }, stopAfterTexts = 0): Promise<Read> {
  return page.evaluate(
    async ({ url, init, stopAfterTexts }) => {
      const started = performance.now()
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        credentials: 'same-origin',
      })
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => (headers[k] = v))
      if (!(headers['content-type'] || '').startsWith('text/event-stream')) return { status: res.status, headers, frames: [], json: await res.json().catch(() => null) }
      const frames: Frame[] = []
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let texts = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at: number
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const f: Frame = { event: 'message', id: null, data: {}, t: performance.now() - started }
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) f.event = line.slice(7)
            else if (line.startsWith('id: ')) f.id = Number(line.slice(4))
            else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6))
          }
          frames.push(f)
          if (f.event === 'text') texts++
        }
        if (stopAfterTexts && texts >= stopAfterTexts) {
          await reader.cancel()
          break
        }
      }
      return { status: res.status, headers, frames, json: null }
    },
    { url, init, stopAfterTexts },
  )
}

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

test.describe('@ai assistant stream', () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')
  // One signed-in page for the block: sign-in is rate-limited per address, and adding a key needs a fresh one.
  test.describe.configure({ mode: 'serial' })
  let page: Page

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
  })
  test.afterAll(async () => {
    setAiAccess(false)
    await page?.context().close()
  })
  test.beforeEach(async () => {
    await fetch(`${FAKE}/__fake/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  })

  test('a run streams through the proxy as it is written: SSE headers, nothing buffered or compressed', async () => {
    await enqueue({ text: 'Streaming through the proxy. '.repeat(20), textFragmentSize: 6, delayMs: 40 })
    const r = await inPage(page, '/api/admin/ai/runs', { method: 'POST', body: { message: 'Stream it.' } })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(r.headers['cache-control']).toBe('no-cache, no-transform')
    expect(r.headers['x-accel-buffering']).toBe('no')
    expect(r.headers['content-encoding'], 'compression must skip the stream').toBeUndefined()
    const names = r.frames.map((f) => f.event)
    expect(names[0]).toBe('run')
    expect(names.at(-1)).toBe('run_end')
    expect(r.frames.at(-1)!.data.state).toBe('finished')
    const texts = r.frames.filter((f) => f.event === 'text')
    expect(texts.length).toBeGreaterThan(50)
    expect(texts.map((f) => f.data.delta).join('')).toBe('Streaming through the proxy. '.repeat(20))
    // The words arrived while the model wrote them: seconds apart, not in one burst at the end.
    expect(r.frames.at(-1)!.t - texts[0].t).toBeGreaterThan(2000)
    expect(texts[Math.floor(texts.length / 2)].t - texts[0].t).toBeGreaterThan(800)
  })

  test('a reload re-attaches: the run went on without the page, and events?after= brings exactly the rest', async () => {
    const words = 'Every word arrives once. '.repeat(16)
    await enqueue({ text: words, textFragmentSize: 5, delayMs: 30 })
    const first = await inPage(page, '/api/admin/ai/runs', { method: 'POST', body: { message: 'Long one.' } }, 4)
    const runId = first.frames[0].data.runId as string
    const lastSeen = first.frames.at(-1)!.id as number
    await page.reload()
    const active = await inPage(page, '/api/admin/ai/runs', {})
    expect((active.json as { active: { id: string } | null }).active?.id, 'still running after the page went away').toBe(runId)
    const rest = await inPage(page, `/api/admin/ai/runs/${runId}/events?after=${lastSeen}`, {})
    expect(rest.status).toBe(200)
    expect(rest.frames.every((f) => (f.id as number) > lastSeen)).toBe(true)
    expect(rest.frames.at(-1)!.event).toBe('run_end')
    const all = [...first.frames, ...rest.frames].filter((f) => f.event === 'text').map((f) => f.data.delta).join('')
    expect(all).toBe(words)
  })

  test('Stop through the proxy ends the run; the stream says stopped; the partial answer is kept for the owner only', async () => {
    await enqueue({ text: 'x'.repeat(4000), textFragmentSize: 8, delayMs: 10 })
    const started = await inPage(page, '/api/admin/ai/runs', { method: 'POST', body: { message: 'Stop me.' } }, 2)
    const runId = started.frames[0].data.runId as string
    const stopped = await inPage(page, `/api/admin/ai/runs/${runId}/stop`, { method: 'POST', body: {} })
    expect(stopped.status).toBe(200)
    expect((stopped.json as { stopped: boolean }).stopped).toBe(true)
    const rest = await inPage(page, `/api/admin/ai/runs/${runId}/events?after=0`, {})
    const end = rest.frames.at(-1)!
    expect([end.event, end.data.state, end.data.reason]).toEqual(['run_end', 'stopped', 'stopped'])
    const conversation = (await inPage(page, `/api/admin/ai/conversations/${started.frames[0].data.conversationId}`, {})).json as { turns: Array<{ role: string; inHistory: boolean; display: { stopped?: boolean } }> }
    expect(conversation.turns.map((t) => [t.role, t.inHistory])).toEqual([
      ['user', true],
      ['assistant', false],
    ])
    expect(conversation.turns[1].display.stopped).toBe(true)
  })

  test('the proxy guards the stream like every admin write: a cross-site post and a form body are refused before the route', async () => {
    const base = new URL(page.url()).origin
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
    const cross = await fetch(`${base}/api/admin/ai/runs`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{"message":"x"}' })
    expect(cross.status).toBe(403)
    const form = await fetch(`${base}/api/admin/ai/runs`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'message=x' })
    expect(form.status).toBe(415)
    const bearer = await fetch(`${base}/api/admin/ai/runs`, { method: 'POST', headers: { authorization: 'Bearer pst_x', origin: base, 'content-type': 'application/json' }, body: '{"message":"x"}' })
    expect(bearer.status).toBe(401)
  })
})


// ── The assistant in a real browser (stage M4b; design §12.4) ───────────────

/** No horizontal scroll: nothing is wider than the viewport. */
async function fitsWidth(page: Page): Promise<void> {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
  expect(scroll, 'no horizontal scroll').toBeLessThanOrEqual(inner)
}

/** A fresh slate for the UI tests: AI on, no model, no conversation. */
function freshAssistant(): void {
  const auth = aiDb('auth.db')
  try {
    auth.prepare('UPDATE ai_settings SET enabled = 1, default_provider_id = NULL WHERE id = 1').run()
    auth.prepare('DELETE FROM ai_provider_keys').run()
  } finally {
    auth.close()
  }
  const ai = aiDb('ai.db')
  try {
    ai.prepare('DELETE FROM ai_conversations').run()
  } finally {
    ai.close()
  }
}

/** The run requests a page sends (POST /api/admin/ai/runs), counted from now. */
function countRuns(page: Page): () => number {
  let n = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/admin/ai/runs') n++
  })
  return () => n
}

/** Answer "Confirm it's you" when it appears (a fresh sign-in usually spares it). */
async function confirmIfAsked(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Confirm it’s you/ })
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByLabel(/^Password/).fill(ADMIN.password)
    await dialog.getByRole('button', { name: 'Confirm with password' }).click()
    await expect(dialog).toBeHidden()
  }
}

test.describe('@ai assistant ui', () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')
  test.describe.configure({ mode: 'serial' })
  let page: Page
  let conversationUrl = ''

  test.beforeAll(async ({ browser }) => {
    expect(FAKE, 'E2E_FAKE_LLM_URL (scripts/ai-e2e.sh)').toBeTruthy()
    freshAssistant()
    const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL })
    await context.addInitScript(() => {
      try {
        localStorage.setItem('theme-preference', 'system')
      } catch {
        /* storage blocked: the default theme applies */
      }
    })
    page = await context.newPage()
    await loginAsAdmin(page, { fresh: true })
  })
  test.afterAll(async () => {
    setAiAccess(false)
    await page?.context().close()
  })
  test.beforeEach(async () => {
    await fetch(`${FAKE}/__fake/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  })

  test('no model yet: the assistant says so; Models adds a Custom provider pointed at the fake, Check key lists its models, Test passes, Save', async () => {
    test.setTimeout(120_000)
    await page.goto('/admin/ai')
    await expect(page.getByText('No model connected yet.')).toBeVisible()
    await expect(page.locator('#ai-composer'), 'no message box without a model').toHaveCount(0)
    await page.getByRole('button', { name: 'Add a model' }).click()
    await expect(page).toHaveURL(/view=models/)
    const drawer = page.getByRole('dialog', { name: 'Add a model' })
    await expect(drawer).toBeVisible()
    await drawer.locator('[data-preset="custom"]').click()
    await expect(drawer.locator('[data-data-notice]')).toContainText('You are trusting whoever runs this URL with everything sent to it.')
    await drawer.getByLabel('Base URL').fill(`${FAKE}/v1`)
    await drawer.getByLabel(/^API key/).fill('e2e-test-key-000000000000')
    await drawer.getByRole('button', { name: 'Check key' }).click()
    await confirmIfAsked(page)
    await expect(drawer.getByText(/The key can use \d+ models\./)).toBeVisible()
    await drawer.getByLabel('Model', { exact: true }).fill('fake-model')
    await drawer.getByLabel('Name').fill('Test model (scripted)')
    await drawer.getByTestId('model-test').click()
    await confirmIfAsked(page)
    const result = drawer.locator('[data-probe-result]')
    await expect(result).toHaveAttribute('data-probe-result', 'ready', { timeout: 60_000 })
    for (const step of ['Reached the provider and read its model list', 'Called a tool, with the site’s whole tool list sent', 'Answered after the tool’s answer was sent back']) await expect(result).toContainText(step)
    // The Test was real: the fake received the whole catalogue plus probe_echo, then the replay.
    const requests = (await (await fetch(`${FAKE}/__fake/requests`)).json()) as { requests: Array<{ path: string; body: { tools?: Array<{ function?: { name: string } }> } }> }
    const chats = requests.requests.filter((r) => /chat\/completions$/.test(r.path))
    expect(chats.length).toBe(2)
    expect(chats[0].body.tools?.map((t) => t.function?.name)).toContain('probe_echo')
    expect(chats[0].body.tools?.length).toBeGreaterThan(20)
    await drawer.getByTestId('model-save').click()
    await confirmIfAsked(page)
    await expect(drawer).toBeHidden()
    const row = page.locator('[data-provider]')
    await expect(row).toHaveCount(1)
    await expect(row.locator('[data-model-status]').first()).toHaveAttribute('data-model-status', 'ready')
    await expect(row).toContainText('Test model (scripted)')
    await expect(row).not.toContainText('e2e-test-key-000000000000')
    expect(await page.content(), 'the key never comes back to the browser').not.toContain('e2e-test-key-000000000000')
  })

  test('chat in Chinese: an Enter that confirms an input method’s characters does not send; Enter sends; the reply is drawn by the allow-list', async () => {
    test.setTimeout(90_000)
    const runs = countRuns(page)
    await page.goto('/admin/ai')
    const box = page.locator('#ai-composer')
    await expect(box).toBeVisible()
    await expect(page.locator('[data-privacy-line]')).toContainText('Your messages and what the tools read go to Test model (scripted)')
    await box.click()
    await page.keyboard.insertText('/say 你好！这是**测试**回复，见 [文章](/blog/x)')
    // What an input method sends while the owner picks characters: the confirming Enter (isComposing), and the
    // Enter some browsers report right after compositionend (keyCode 229).
    await box.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '回复' }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(800)
    expect(runs(), 'an input method’s Enter sent nothing').toBe(0)
    await expect(box).toHaveValue(/你好！这是\*\*测试\*\*回复/)
    // Shift+Enter is a new line; Enter sends.
    await page.keyboard.press('Shift+Enter')
    expect(runs()).toBe(0)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]c=c_[A-Za-z0-9_-]+/)
    conversationUrl = page.url()
    const reply = page.locator('[data-turn="assistant"]').last()
    await expect(reply).toContainText('你好！这是测试回复')
    expect(runs()).toBe(1)
    await expect(reply.locator('strong')).toHaveText('测试')
    await expect(reply.locator('[data-chat-markdown]')).toHaveAttribute('lang', 'zh-Hans')
    await expect(page.locator('[data-turn="user"]').last().locator('[data-user-text]')).toHaveAttribute('lang', 'zh-Hans')
    await expect(reply.getByRole('link', { name: '文章' })).toHaveAttribute('href', '/blog/x')
    await expect(page.locator('[data-usage-line]')).toBeVisible()
    await expect(box, 'the box is cleared once the server took the message').toHaveValue('')
    await expect(box).toBeFocused()
  })

  test('a draft card and a proposal card appear without taking the focus; the status line offers Review, which moves it on request', async () => {
    test.setTimeout(90_000)
    await page.goto(conversationUrl)
    const box = page.locator('#ai-composer')
    await box.fill('/tool create_draft {"collection":"blog","slug":"e2e-assistant-note","frontmatter":{"title":"An assistant note","date":"2026-11-07"},"body":"Written by the scripted model.","rationale":"A first draft."}')
    await box.press('Enter')
    const draft = page.locator('[data-chat-change]').first()
    await expect(draft.locator('[data-change-state="applied"]')).toBeVisible({ timeout: 30_000 })
    await expect(box).toBeFocused()
    const id = new URL(page.url()).searchParams.get('c') as string
    const detail = (await inPage(page, `/api/admin/ai/conversations/${id}`, {})).json as { turns: Array<{ role: string; display: { results?: Array<{ name: string; result: string }> } }> }
    const version = JSON.parse(detail.turns.flatMap((t) => t.display.results ?? []).find((r) => r.name === 'create_draft')!.result).version as string
    await box.fill(`/tool propose_publishing {"collection":"blog","slug":"e2e-assistant-note","action":"publish","base_version":${JSON.stringify(version)},"rationale":"Ready to go live."}`)
    await box.press('Enter')
    const waiting = page.locator('[data-change-state="waiting"]')
    await expect(waiting).toBeVisible({ timeout: 30_000 })
    await expect(waiting).toContainText('Publish post')
    await expect(waiting.getByTestId('change-approve')).toHaveText('Approve & publish')
    await expect(box, 'no focus theft').toBeFocused()
    await expect(page.getByRole('status').filter({ hasText: 'Approval needed: Publish post e2e-assistant-note.' })).toHaveCount(1)
    await page.getByTestId('waiting-review').click()
    await expect(page.locator('[data-chat-change]').filter({ has: waiting })).toBeFocused()
    await expect(page.getByRole('tab', { name: /Changes \(\d+\)/ }), 'the Changes tab counts it').toBeVisible()
  })

  test('Stop mid-stream (Esc in the box): what arrived stays for the owner, out of the history; Retry answers again', async () => {
    test.setTimeout(90_000)
    await page.goto(conversationUrl)
    const box = page.locator('#ai-composer')
    await box.fill('/slow A long answer the owner stops.')
    await box.press('Enter')
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(page.locator('[data-turn="live"]')).toContainText('A long answer the owner stops.')
    await expect(box, 'the box stays editable while the answer is written').toBeEditable()
    await box.press('Escape')
    const end = page.locator('[data-run-end]').last()
    await expect(end).toContainText('Stopped.')
    await expect(page.locator('[data-turn="assistant"]').last()).toContainText('stopped here')
    const id = new URL(page.url()).searchParams.get('c') as string
    const detail = (await inPage(page, `/api/admin/ai/conversations/${id}`, {})).json as { turns: Array<{ role: string; inHistory: boolean; display: { stopped?: boolean } }> }
    const last = detail.turns.at(-1)!
    expect([last.role, last.inHistory, last.display.stopped]).toEqual(['assistant', false, true])
    await end.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 60_000 })
  })

  test('a reload re-attaches: the answer goes on without the page, and every word arrives once', async () => {
    test.setTimeout(120_000)
    await page.goto(conversationUrl)
    const box = page.locator('#ai-composer')
    await box.fill('/slow Every word arrives once.')
    await box.press('Enter')
    await expect(page.locator('[data-turn="live"]')).toContainText('Every word arrives once.')
    const before = (await page.locator('[data-turn="live"]').innerText()).length
    await page.reload()
    await expect(page.getByTestId('composer-stop'), 'still being written after the reload').toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await page.locator('[data-turn="live"]').innerText().catch(() => '')).length).toBeGreaterThan(before)
    await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 90_000 })
    const text = await page.locator('[data-turn="assistant"]').last().innerText()
    expect((text.match(/Every word arrives once\./g) ?? []).length, 'no word twice, none lost').toBe(40)
  })

  test('a hostile reply: no request leaves the page, no image, nothing live outside the allow-list', async () => {
    test.setTimeout(90_000)
    await page.goto(conversationUrl)
    const outbound: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (u.origin !== new URL(page.url()).origin || /\/api\/admin\/(draft|orcid|export)|\/ai\/review\//.test(u.pathname)) outbound.push(r.url())
    })
    const box = page.locator('#ai-composer')
    await box.fill('/hostile')
    await box.press('Enter')
    const reply = page.locator('[data-turn="assistant"]').last()
    await expect(reply).toContainText('Here is a hostile reply.')
    await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1000)
    await expect(reply.locator('img, script, iframe, object, svg')).toHaveCount(0)
    await expect(reply.locator('a[href]'), 'no live link: every one points at /api/, /ai/review/ or another site').toHaveCount(0)
    await expect(reply.locator('[data-image-not-loaded]').first()).toContainText('[image not loaded]')
    await expect(reply).toContainText('<img src=')
    expect(await page.evaluate(() => (window as unknown as { __owned?: boolean }).__owned)).toBeUndefined()
    expect(outbound, 'nothing was fetched from the reply').toEqual([])
    const collected = (await (await fetch(`${FAKE}/__fake/collected`)).json()) as { collected: unknown[] }
    expect(collected.collected, 'the collector the reply points at saw nothing').toEqual([])
  })

  test('phone width, reduced motion, light and dark: the conversation, History, a new chat and Models hold up; axe stays clean', async () => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 375, height: 812 })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await page.goto(conversationUrl)
      await expect(page.locator('#ai-composer')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), `${scheme}: conversation`).toEqual([])
      expect(await undersizedTargets(page), `${scheme}: conversation targets`).toEqual([])
      // The back-to-top button floats above the message box, never over Send.
      const send = await page.getByTestId('composer-send').boundingBox()
      const top = page.locator('.scroll-top')
      if (send && (await top.isVisible())) {
        const t = await top.boundingBox()
        if (t) expect(t.y + t.height <= send.y || t.x + t.width <= send.x, 'back to top clears Send').toBe(true)
      }
      await page.getByRole('button', { name: 'History' }).click()
      const history = page.getByRole('dialog', { name: 'Conversations' })
      await expect(history).toBeVisible()
      await settle(page)
      expect(await seriousA11yViolations(page), `${scheme}: history`).toEqual([])
      await history.getByRole('button', { name: 'New chat' }).click()
      await expect(history).toBeHidden()
      await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), `${scheme}: new chat`).toEqual([])
      await page.goto('/admin/ai?view=models')
      await expect(page.locator('[data-provider]')).toHaveCount(1)
      await settle(page)
      await fitsWidth(page)
      expect(await seriousA11yViolations(page), `${scheme}: models`).toEqual([])
      expect(await undersizedTargets(page), `${scheme}: models targets`).toEqual([])
      await page.getByTestId('add-model').click()
      const drawer = page.getByRole('dialog', { name: 'Add a model' })
      await expect(drawer).toBeVisible()
      await drawer.locator('[data-preset="deepseek"]').click()
      await expect(drawer.locator('[data-data-notice]')).toContainText('PRC')
      await settle(page)
      expect(await seriousA11yViolations(page), `${scheme}: add a model`).toEqual([])
      await drawer.getByRole('button', { name: 'Cancel' }).click()
      await expect(drawer).toBeHidden()
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' })
  })
})
