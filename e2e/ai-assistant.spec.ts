import path from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { ADMIN, expect, loginAsAdmin, test } from './fixtures'

/**
 * The assistant's run stream through the REAL proxy (proxy.ts, its CSRF and
 * admin gate) on the standalone production build scripts/ai-e2e.sh starts,
 * with tests/helpers/fake-llm.mjs as an ordinary Custom provider (design
 * §7.7, §14 M4: "SSE through the real proxy in a local build"). The browser
 * reads the stream the way the admin will: a same-origin fetch whose body is
 * read as it arrives. Stage M4's UI adds its own flows next to these.
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
