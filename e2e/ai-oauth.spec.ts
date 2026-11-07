import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { ADMIN, expect, loginAsAdmin, seriousA11yViolations, settle, test, undersizedTargets } from './fixtures'

/**
 * The OAuth gate of design §12.4, unattended, in Chromium (ai-admin) and
 * Firefox (ai-consent-firefox), on the standalone server scripts/ai-e2e.sh
 * starts. A Node OAuth client with PKCE runs here, on loopback: it discovers
 * the server from /mcp's 401, gets its identity from a client document this
 * spec serves (CIMD, from the port the script lists in
 * AI_LOCAL_PROVIDER_ORIGINS) or registers (DCR), and waits for the browser on
 * its own loopback callback. Playwright signs in, opens the pairing window in
 * Connections with a step-up, and follows the connection link from a page on
 * a different site (http://localhost:<stub>, while the server is
 * http://127.0.0.1) — the cross-site navigation the SameSite=Strict cookie is
 * not sent on, which the 200 bounce of /oauth/authorize turns into a
 * same-site one. Then the consent, its arming and its 2-minute verification,
 * the redirect with code, state and iss, the code exchange, a tool call with
 * the access token, and the refresh rotation. Every page fails on a CSP
 * violation (the fixtures), and the server's error store gains none.
 *
 * Synthetic only: owner@example.test, documentation addresses, loopback.
 */

const DATA_DIR = process.env.E2E_SERVER_DATA_DIR || ''
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000'
const STUB_PORT = Number(process.env.E2E_OAUTH_STUB_PORT || 0)
const RESOURCE = `${BASE}/mcp`
const MODERN = '2026-07-28'
/** The stub's own address (what the server fetches) and the different site the owner clicks from. */
const STUB = `http://127.0.0.1:${STUB_PORT}`
const ELSEWHERE = `http://localhost:${STUB_PORT}`

test.describe.configure({ mode: 'serial' })

function authDb(): Database.Database {
  return new Database(path.join(DATA_DIR, 'auth.db'), { fileMustExist: true, timeout: 5000 })
}

/** The browser's session id, from the session cookie's claims. */
async function sessionIdOf(page: Page): Promise<string> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'cv_admin_token')
  const payload = JSON.parse(Buffer.from((cookie?.value ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { sid?: string }
  expect(payload.sid, 'a session cookie with a session id').toBeTruthy()
  return payload.sid as string
}

/** Make this browser's last verification `ms` old, as if the owner had signed in that long ago. */
function verifiedAgo(sid: string, ms: number): void {
  const db = authDb()
  try {
    db.prepare('UPDATE auth_sessions SET verified_at = ? WHERE id = ?').run(Date.now() - ms, sid)
  } finally {
    db.close()
  }
}

function setSwitches(on: boolean): void {
  const db = authDb()
  try {
    db.prepare('UPDATE ai_settings SET enabled = ?, mcp_enabled = ?, pairing_id = NULL, pairing_app = NULL, pairing_opened_at = NULL, pairing_expires_at = NULL WHERE id = 1').run(on ? 1 : 0, on ? 1 : 0)
    if (!on) db.prepare("UPDATE ai_grants SET revoked_at = ?, revoke_reason = 'e2e clean-up' WHERE revoked_at IS NULL").run(Date.now())
  } finally {
    db.close()
  }
}

/** Enforced CSP violations the server's error store holds (reports reach /api/e; Trusted Types reports are report-only). */
function storedCspViolations(): number {
  const file = path.join(DATA_DIR, 'analytics.db')
  if (!fs.existsSync(file)) return 0
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 })
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'errors'").get()
    if (!has) return 0
    return Number((db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM errors WHERE source = 'csp' AND kind = 'csp'").get() as { n: number }).n)
  } finally {
    db.close()
  }
}

/**
 * The fixtures' page guard for a page a test opens itself (the consent tab):
 * enforced CSP violations, console errors and page errors of the site's own
 * origin are collected and must be none. The stub's and the app's callback
 * pages are not this site's.
 */
async function guard(p: Page): Promise<() => string[]> {
  const problems: string[] = []
  await p.exposeFunction('__e2eOauthCsp', (line: string) => problems.push(`CSP violation: ${line}`))
  await p.addInitScript(() => {
    const w = window as unknown as { __e2eOauthCsp?: (line: string) => void }
    document.addEventListener('securitypolicyviolation', (e) => {
      if (e.disposition === 'report') return
      w.__e2eOauthCsp?.(`${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || location.href}:${e.lineNumber}`)
    })
  })
  p.on('console', (msg) => {
    if (msg.type() === 'error' && new URL(msg.location().url || p.url()).origin === BASE) problems.push(`console.error: ${msg.text()}`)
  })
  p.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  return () => problems
}

async function confirmWithPassword(page: Page, reason: string): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: /Confirm it’s you/ })
  await expect(stepUp).toBeVisible()
  await expect(stepUp).toContainText(reason)
  await stepUp.getByLabel(/^Password/).fill(ADMIN.password)
  await stepUp.getByRole('button', { name: 'Confirm with password' }).click()
  await expect(stepUp).toBeHidden()
}

// ── The stub: client documents, and the page on another site the owner clicks from ──

let stub: http.Server[] = []
const documents = new Map<string, unknown>()

function startStub(): Promise<void> {
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url || '/', STUB)
    const doc = documents.get(url.pathname)
    if (doc) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(doc))
    }
    if (url.pathname === '/start') {
      // A page of another site (an app's own sign-in page, an e-mail, a chat): one link to the authorize URL.
      const to = url.searchParams.get('to') || ''
      const href = to.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example app</title></head><body><main><h1>Example app</h1><p><a id="connect" href="${href}">Connect your site</a></p></main></body></html>`)
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not here')
  }
  // Both loopback families: a browser may resolve localhost to either.
  const listen = (host: string) =>
    new Promise<http.Server | null>((resolve) => {
      const s = http.createServer(handler)
      s.once('error', () => resolve(null))
      s.listen(STUB_PORT, host, () => resolve(s))
    })
  return Promise.all([listen('127.0.0.1'), listen('::1')]).then((servers) => {
    stub = servers.filter((s): s is http.Server => s !== null)
    expect(stub.length, `the stub listens on ${STUB}`).toBeGreaterThan(0)
  })
}

// ── The Node OAuth client (PKCE, loopback callback) ─────────────────────────

type Callback = { query: URLSearchParams }

/** A loopback callback server for one authorization response. */
async function callbackServer(): Promise<{ redirectUri: string; next: () => Promise<Callback>; close: () => Promise<void>; hits: () => number }> {
  let resolveNext: ((c: Callback) => void) | null = null
  let pending: Callback | null = null
  let hits = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      return res.end()
    }
    hits++
    const got = { query: url.searchParams }
    if (resolveNext) resolveNext(got)
    else pending = got
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example app</title></head><body><p id="app-callback">Signed in. You can return to the app.</p></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    hits: () => hits,
    next: () =>
      new Promise<Callback>((resolve) => {
        if (pending) {
          const p = pending
          pending = null
          return resolve(p)
        }
        resolveNext = resolve
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** Each client request from its own documentation address (the server believes it from loopback only), so budgets never collide. */
let clientSeq = 0
const clientAddress = () => `198.51.100.${(clientSeq++ % 200) + 20}`

/** What a client learns from /mcp's 401 and the two metadata documents (RFC 9728, RFC 8414). */
async function discover(from: string) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': from },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  expect(res.status).toBe(401)
  const challenge = res.headers.get('www-authenticate') ?? ''
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  expect(prmUrl).toBe(`${BASE}/.well-known/oauth-protected-resource/mcp`)
  const prm = await (await fetch(prmUrl as string, { headers: { 'cf-connecting-ip': from } })).json()
  expect(prm.resource).toBe(RESOURCE)
  const issuer = prm.authorization_servers[0]
  expect(issuer).toBe(BASE)
  const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`, { headers: { 'cf-connecting-ip': from } })).json()
  expect(as.issuer).toBe(issuer)
  expect(as.code_challenge_methods_supported).toEqual(['S256'])
  expect(as.authorization_response_iss_parameter_supported).toBe(true)
  expect(as.client_id_metadata_document_supported).toBe(true)
  return as as { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; revocation_endpoint: string }
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

function authorizeUrl(as: { authorization_endpoint: string }, p: { clientId: string; redirectUri: string; challenge: string; state: string; scope: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    scope: p.scope,
    state: p.state,
    resource: RESOURCE,
  })
  return `${as.authorization_endpoint}?${q}`
}

async function tokenRequest(as: { token_endpoint: string }, fields: Record<string, string>, from: string) {
  const res = await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': from }, body: new URLSearchParams(fields) })
  return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> }
}

/** tools/list in the modern era with a bearer token. */
async function toolNames(token: string, from: string): Promise<string[]> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}`, 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list', 'cf-connecting-ip': from },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'e2e OAuth client', version: '1' } } },
    }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()).result.tools as Array<{ name: string }>).map((t) => t.name)
}

/** Open the pairing window from a client's tab in Connections (with the step-up the page asks for). */
async function allowNewConnection(page: Page, tab: string): Promise<void> {
  await page.goto('/admin/ai?view=connections')
  const tabs = page.getByRole('tablist', { name: 'Apps' })
  await tabs.getByRole('tab', { name: tab, exact: true }).click()
  const panel = page.locator('#ai-client-panel')
  await panel.getByRole('button', { name: 'Allow a new connection' }).click()
}

/** From the other site's page, follow the link: authorize → the bounce → the consent page, signed in. */
async function followLinkFromElsewhere(page: Page, authorize: string): Promise<void> {
  await page.goto(`${ELSEWHERE}/start?to=${encodeURIComponent(authorize)}`)
  expect(new URL(page.url()).origin).toBe(ELSEWHERE)
  await page.locator('#connect').click()
  await page.waitForURL((u) => u.origin === BASE && u.pathname === '/admin/ai/connect')
}

test.describe('@ai oauth', () => {
  test.skip(!ADMIN.email || !ADMIN.password, 'ADMIN_EMAIL / ADMIN_PASS not set')
  test.beforeAll(async () => {
    expect(DATA_DIR, 'E2E_SERVER_DATA_DIR (scripts/ai-e2e.sh)').toBeTruthy()
    expect(STUB_PORT, 'E2E_OAUTH_STUB_PORT (scripts/ai-e2e.sh)').toBeGreaterThan(0)
    await startStub()
  })
  test.afterAll(async () => {
    setSwitches(false)
    await Promise.all(stub.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  })

  test('a phishing-shaped link with no window open bounces to the page that says nothing is expected; nothing reaches the app (§13 step 16)', async ({ page }) => {
    setSwitches(true)
    const cb = await callbackServer()
    try {
      await loginAsAdmin(page, { fresh: true })
      const as = await discover(clientAddress())
      const { challenge } = pkce()
      const evil = authorizeUrl(as, { clientId: `${STUB}/phish.json`, redirectUri: cb.redirectUri, challenge, state: 'phish', scope: 'content:read content:draft content:propose' })
      await followLinkFromElsewhere(page, evil)
      await expect(page.getByRole('heading', { name: 'No connection expected', level: 1 })).toBeVisible()
      await expect(page.locator('[data-consent-state="closed"]')).toHaveText(
        'This site is not expecting a new connection. Open Admin → AI → Connections, allow a new connection, then try again.',
      )
      await expect(page.getByRole('link', { name: 'Open Connections' })).toBeVisible()
      await settle(page)
      expect(await seriousA11yViolations(page)).toEqual([])
      expect(cb.hits(), 'no redirect to the app').toBe(0)
      expect(new URL(page.url()).origin).toBe(BASE)
    } finally {
      await cb.close()
    }
  })

  test('CIMD: pairing with a step-up, consent from a link on another site, armed Allow, the 2-minute verification, code + state + iss, exchange, a tool call, refresh rotation', async ({ page }) => {
    test.setTimeout(150_000)
    setSwitches(true)
    const cspBefore = storedCspViolations()
    const cb = await callbackServer()
    const clientId = `${STUB}/client-${test.info().project.name}.json`
    documents.set(new URL(clientId).pathname, { client_id: clientId, client_name: 'Example Stub Client', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
    const from = clientAddress()
    try {
      await loginAsAdmin(page, { fresh: true })
      const sid = await sessionIdOf(page)
      // Discovery, from /mcp's 401.
      const as = await discover(from)

      // Connections → Other → Allow a new connection: past the 10-minute window, so it asks.
      verifiedAgo(sid, 11 * 60_000)
      await allowNewConnection(page, 'Other')
      await confirmWithPassword(page, 'Connecting an app creates a new way into the admin.')
      const status = page.locator('#ai-client-panel [data-pairing="waiting"]')
      await expect(status).toContainText('Waiting for your app to connect…')
      await expect(status).toContainText(/The window closes in (9|10):\d\d\./)
      await settle(page)
      expect(await seriousA11yViolations(page)).toEqual([])

      // The app sends the owner to authorize, from its own site.
      const { verifier, challenge } = pkce()
      const state = crypto.randomBytes(12).toString('base64url')
      const authorize = authorizeUrl(as, { clientId, redirectUri: cb.redirectUri, challenge, state, scope: 'content:read content:draft offline_access' })
      const consentPage = await page.context().newPage()
      const consentProblems = await guard(consentPage)
      await followLinkFromElsewhere(consentPage, authorize)
      await consentPage.bringToFront()

      // Signed in (the Strict cookie came along) and host-first.
      const card = consentPage.locator('[data-consent-card]')
      await expect(consentPage.getByRole('heading', { level: 1 })).toHaveText(`Connect 127.0.0.1 to ${new URL(BASE).host}?`)
      await expect(consentPage.getByTestId('consent-host')).toHaveText('127.0.0.1')
      await expect(card).toContainText(cb.redirectUri)
      await expect(card).toContainText('127.0.0.1, verified by its address')
      await expect(card).toContainText('on this computer. Any program running here could be listening there')
      await expect(card).not.toContainText('connection requests arrived')
      await expect(card.getByRole('radio', { name: /^Read and draft/ })).toBeChecked()

      // Allow: disabled until armed and until the host is typed.
      const allow = card.getByRole('button', { name: 'Allow access' })
      await expect(allow).toBeDisabled()
      await card.getByRole('radio', { name: /^Read, draft and propose/ }).check()
      await card.getByLabel('Type 127.0.0.1 to allow it').fill('127.0.0.2')
      await card.getByLabel('Type 127.0.0.1 to allow it').blur()
      await expect(card).toContainText('That isn’t 127.0.0.1.')
      await card.getByLabel('Type 127.0.0.1 to allow it').fill('127.0.0.1')
      const box = await card.boundingBox()
      expect(box).not.toBeNull()
      await consentPage.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20)
      await consentPage.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 60)
      await expect(card).toHaveAttribute('data-armed', 'true', { timeout: 5000 })
      await expect(allow).toBeEnabled()
      await settle(consentPage)
      expect(await seriousA11yViolations(consentPage)).toEqual([])

      // A verification 3 minutes old is recent, but not fresh enough to connect an app.
      verifiedAgo(sid, 3 * 60_000)
      const callback = cb.next()
      await allow.click()
      await confirmWithPassword(consentPage, 'Connecting an app creates a new way into the admin.')
      const got = await callback
      expect(got.query.get('state')).toBe(state)
      expect(got.query.get('iss')).toBe(BASE)
      const code = got.query.get('code') ?? ''
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
      await consentPage.waitForURL((u) => u.href.startsWith(cb.redirectUri))
      await expect(consentPage.locator('#app-callback')).toBeVisible()

      // The exchange, with the verifier only the client holds.
      const wrong = await tokenRequest(as, { grant_type: 'authorization_code', code: 'x'.repeat(43), code_verifier: verifier, redirect_uri: cb.redirectUri, client_id: clientId, resource: RESOURCE }, from)
      expect(wrong.json.error).toBe('invalid_grant')
      const t = await tokenRequest(as, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: cb.redirectUri, client_id: clientId, resource: RESOURCE }, from)
      expect(t.status).toBe(200)
      expect(t.headers.get('cache-control')).toBe('no-store')
      expect(t.json.token_type).toBe('Bearer')
      expect(t.json.scope).toBe('content:read content:draft content:propose offline_access')
      expect(t.json.access_token).toMatch(/^pso_/)
      expect(t.json.refresh_token).toMatch(/^psr_/)
      const tools = await toolNames(t.json.access_token, from)
      expect(tools).toContain('get_site_overview')

      // Back in Connections: the tab says the app connected, and lists it as OAuth with where it returns to.
      await page.bringToFront()
      await expect(page.locator('#ai-client-panel [data-pairing="done"]')).toContainText('Connected: your app collected its access', { timeout: 15_000 })
      const row = page.locator('[data-app-id]').filter({ hasText: 'returns to 127.0.0.1' })
      await expect(row).toContainText('OAuth')
      await expect(row).toContainText('Read, draft and propose')
      await expect(row).toContainText('127.0.0.1')

      // Refresh: rotated in the same response; the old one again within 10 s is refused and ends nothing.
      const r = await tokenRequest(as, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token, client_id: clientId }, from)
      expect(r.status).toBe(200)
      expect(r.json.refresh_token).not.toBe(t.json.refresh_token)
      expect(r.json.access_token).not.toBe(t.json.access_token)
      const again = await tokenRequest(as, { grant_type: 'refresh_token', refresh_token: t.json.refresh_token, client_id: clientId }, from)
      expect(again.json.error).toBe('invalid_grant')
      expect((await toolNames(r.json.access_token, from)).length).toBe(tools.length)
      // The code is single use: presenting it again ends the grant, and its tokens stop working.
      const replay = await tokenRequest(as, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: cb.redirectUri, client_id: clientId, resource: RESOURCE }, from)
      expect(replay.json.error).toBe('invalid_grant')
      const dead = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${r.json.access_token}`, 'cf-connecting-ip': from }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
      expect(dead.status).toBe(401)
      // Connected apps no longer lists it.
      await page.reload()
      await expect(page.getByRole('heading', { name: /Connected apps/ })).toBeVisible()
      await expect(page.locator('[data-app-id]').filter({ hasText: 'returns to 127.0.0.1' })).toHaveCount(0)

      expect(consentProblems(), 'console errors, page errors or CSP violations on the consent page').toEqual([])
      expect(storedCspViolations(), 'no CSP violation reached the Errors panel').toBe(cspBefore)
    } finally {
      await cb.close()
    }
  })

  test('DCR: a registered client is shown as unverified and needs the typed host; Cancel stays on this site and keeps the window; then Allow and the exchange', async ({ page }) => {
    test.setTimeout(150_000)
    setSwitches(true)
    const cb = await callbackServer()
    const from = clientAddress()
    try {
      await loginAsAdmin(page, { fresh: true })
      const as = await discover(from)
      const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': from }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'], client_name: 'Example DCR Client', token_endpoint_auth_method: 'client_secret_basic' }) })
      expect(reg.status).toBe(201)
      const client = (await reg.json()) as { client_id: string; token_endpoint_auth_method: string }
      expect(client.token_endpoint_auth_method).toBe('none')

      await allowNewConnection(page, 'Cursor')
      await expect(page.locator('#ai-client-panel [data-pairing="waiting"]')).toContainText('Waiting for Cursor to connect…')

      const { verifier, challenge } = pkce()
      const authorize = authorizeUrl(as, { clientId: client.client_id, redirectUri: cb.redirectUri, challenge, state: 'dcr-state', scope: 'content:read' })
      const consentPage = await page.context().newPage()
      const consentProblems = await guard(consentPage)
      await followLinkFromElsewhere(consentPage, authorize)
      await consentPage.bringToFront()
      const card = consentPage.locator('[data-consent-card]')
      await expect(card).toContainText('This app named itself “Example DCR Client”. We can’t verify that. Continue only if you started this from the app yourself.')
      await expect(card.getByRole('radio', { name: /^Read published/ })).toBeChecked()
      await expect(card.getByLabel('Type 127.0.0.1 to allow it')).toBeVisible()

      // Cancel: an unknown host is never redirected to.
      await card.getByRole('button', { name: 'Cancel' }).click()
      await expect(consentPage.getByRole('status').filter({ hasText: 'Cancelled. Nothing was shared with the app.' })).toBeVisible()
      expect(new URL(consentPage.url()).origin).toBe(BASE)
      expect(cb.hits()).toBe(0)

      // The window stayed open: start again from the app, and allow.
      await followLinkFromElsewhere(consentPage, authorize)
      const again = consentPage.locator('[data-consent-card]')
      await expect(again).toContainText('2 connection requests arrived in this window. If you started one, cancel and try again.')
      await again.getByLabel('Type 127.0.0.1 to allow it').fill('127.0.0.1')
      await again.hover()
      await expect(again).toHaveAttribute('data-armed', 'true', { timeout: 5000 })
      const callback = cb.next()
      await again.getByRole('button', { name: 'Allow access' }).click()
      const got = await callback
      expect([got.query.get('state'), got.query.get('iss')]).toEqual(['dcr-state', BASE])
      const t = await tokenRequest(as, { grant_type: 'authorization_code', code: got.query.get('code') ?? '', code_verifier: verifier, redirect_uri: cb.redirectUri, client_id: client.client_id, resource: RESOURCE }, from)
      expect(t.status).toBe(200)
      expect(t.json.scope).toBe('content:read offline_access')
      expect((await toolNames(t.json.access_token, from)).length).toBe(8)

      // Listed under Connected apps by its return host, as OAuth; revoking from the app ends it (RFC 7009).
      await page.bringToFront()
      await page.goto('/admin/ai?view=connections')
      const row = page.locator('[data-app-id]').filter({ hasText: 'returns to 127.0.0.1' })
      await expect(row).toContainText('OAuth')
      await expect(row).toContainText('Read published')
      const revoked = await fetch(as.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': from }, body: new URLSearchParams({ token: t.json.refresh_token }) })
      expect(revoked.status).toBe(200)
      const dead = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t.json.access_token}`, 'cf-connecting-ip': from }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
      expect(dead.status).toBe(401)
      expect(consentProblems(), 'console errors, page errors or CSP violations on the consent page').toEqual([])
    } finally {
      await cb.close()
    }
  })

  test('signed out: the bounce sends the owner to sign in, which brings them back to the consent page with the whole authorize query, and the consent completes (§6.4)', async ({ page, browser, baseURL, extraHTTPHeaders }) => {
    test.setTimeout(150_000)
    setSwitches(true)
    const cb = await callbackServer()
    const clientId = `${STUB}/signed-out-${test.info().project.name}.json`
    documents.set(new URL(clientId).pathname, { client_id: clientId, client_name: 'Example Signed-out Client', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' })
    const from = clientAddress()
    // The owner opened the window from the browser at their desk; the app's link opens in another, signed out.
    const away = await browser.newContext({ baseURL, extraHTTPHeaders })
    try {
      await loginAsAdmin(page, { fresh: true })
      const as = await discover(from)
      await allowNewConnection(page, 'Other')
      await expect(page.locator('#ai-client-panel [data-pairing="waiting"]')).toContainText('Waiting for your app to connect…')

      const { verifier, challenge } = pkce()
      const state = crypto.randomBytes(12).toString('base64url')
      const authorize = authorizeUrl(as, { clientId, redirectUri: cb.redirectUri, challenge, state, scope: 'content:read content:draft offline_access' })
      const query = new URL(authorize).search
      const signedOut = await away.newPage()
      const problems = await guard(signedOut)
      expect((await away.cookies()).some((c) => c.name === 'cv_admin_token'), 'this browser is signed out').toBe(false)

      // The link from the app's site: authorize, the bounce, the consent page — which the proxy sends to sign in, keeping where it was going.
      await signedOut.goto(`${ELSEWHERE}/start?to=${encodeURIComponent(authorize)}`)
      await signedOut.locator('#connect').click()
      await signedOut.waitForURL((u) => u.origin === BASE && u.pathname === '/admin/login')
      expect(new URL(signedOut.url()).searchParams.get('next'), 'next is the consent page with the whole authorize query').toBe(`/admin/ai/connect${query}`)
      await expect(signedOut.locator('[data-consent-card]')).toHaveCount(0)

      // Sign in: safeNextPath sends the owner on to exactly that address.
      await signedOut.getByLabel(/^email/i).fill(ADMIN.email)
      await signedOut.getByLabel(/^password/i).fill(ADMIN.password)
      await signedOut.getByRole('button', { name: 'Sign in', exact: true }).click()
      await signedOut.waitForURL((u) => u.origin === BASE && u.pathname === '/admin/ai/connect')
      expect(new URL(signedOut.url()).search, 'the authorize query, unchanged').toBe(query)

      // The consent, for this window and this request.
      const card = signedOut.locator('[data-consent-card]')
      await expect(signedOut.getByRole('heading', { level: 1 })).toHaveText(`Connect 127.0.0.1 to ${new URL(BASE).host}?`)
      await expect(card).toContainText(cb.redirectUri)
      await expect(card.getByRole('radio', { name: /^Read and draft/ })).toBeChecked()
      await card.getByLabel('Type 127.0.0.1 to allow it').fill('127.0.0.1')
      await card.hover()
      await expect(card).toHaveAttribute('data-armed', 'true', { timeout: 5000 })
      await settle(signedOut)
      expect(await seriousA11yViolations(signedOut)).toEqual([])

      // Signed in a moment ago: a verification fresh enough to connect an app, so no step-up; the app gets its code.
      const callback = cb.next()
      await card.getByRole('button', { name: 'Allow access' }).click()
      const got = await callback
      expect([got.query.get('state'), got.query.get('iss')]).toEqual([state, BASE])
      await signedOut.waitForURL((u) => u.href.startsWith(cb.redirectUri))
      const t = await tokenRequest(as, { grant_type: 'authorization_code', code: got.query.get('code') ?? '', code_verifier: verifier, redirect_uri: cb.redirectUri, client_id: clientId, resource: RESOURCE }, from)
      expect(t.status).toBe(200)
      expect(t.json.scope).toBe('content:read content:draft offline_access')
      expect(await toolNames(t.json.access_token, from)).toContain('create_draft')

      // The desk's Connections sees the app connect.
      await expect(page.locator('#ai-client-panel [data-pairing="done"]')).toContainText('Connected: your app collected its access', { timeout: 15_000 })
      expect(problems(), 'console errors, page errors or CSP violations on the sign-in and consent pages').toEqual([])
    } finally {
      await away.close()
      await cb.close()
    }
  })

  test('on a phone, light and dark, with reduced motion: the client tabs wrap, the consent fits, axe stays clean, every target is big enough', async ({ page, context }) => {
    test.setTimeout(120_000)
    setSwitches(true)
    await context.addInitScript(() => {
      try {
        localStorage.setItem('theme-preference', 'system')
      } catch {
        /* storage blocked: the default theme applies */
      }
    })
    const from = clientAddress()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
    await loginAsAdmin(page, { fresh: true })
    const as = await discover(from)
    const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': from }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'], client_name: 'Example Phone Client' }) })
    const client = (await reg.json()) as { client_id: string }

    await allowNewConnection(page, 'Codex')
    const waiting = page.locator('#ai-client-panel [data-pairing="waiting"]')
    await expect(waiting).toContainText('Waiting for Codex to connect…')
    await expect(page.locator('#ai-client-panel code').first()).toHaveText(`codex mcp add site-local --url ${RESOURCE}\ncodex mcp login site-local`)
    // Every tab is on screen without scrolling the tab list: they wrap.
    const tabs = page.getByRole('tab')
    for (let i = 0; i < (await tabs.count()); i++) {
      const b = await tabs.nth(i).boundingBox()
      expect(b && b.x >= 0 && b.x + b.width <= 375, `tab ${i} is on screen`).toBe(true)
    }
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
      expect(scroll, `${scheme}: no horizontal scroll`).toBeLessThanOrEqual(inner)
      expect(await seriousA11yViolations(page), scheme).toEqual([])
    }
    expect(await waiting.locator('> span').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    expect(await undersizedTargets(page)).toEqual([])

    const { challenge } = pkce()
    await page.goto(authorizeUrl(as, { clientId: client.client_id, redirectUri: 'http://127.0.0.1:50999/callback', challenge, state: 'phone', scope: 'content:read content:draft content:propose' }))
    const card = page.locator('[data-consent-card]')
    await expect(card).toContainText('This app named itself “Example Phone Client”.')
    await expect(card).toContainText('The app asked for Read, draft and propose.')
    await expect(card.getByRole('radio', { name: /^Read and draft/ })).toBeChecked()
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
      await settle(page)
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
      expect(scroll, `${scheme}: no horizontal scroll on the consent page`).toBeLessThanOrEqual(inner)
      expect(await seriousA11yViolations(page), scheme).toEqual([])
    }
    expect(await undersizedTargets(page)).toEqual([])
    // A phone has no hover: arming needs no pointer there (the coarse pointer is emulated by the mobile preset only), so
    // here the keyboard arms it, as it would for a keyboard user.
    await card.getByLabel('Type 127.0.0.1 to allow it').fill('127.0.0.1')
    await expect(card).toHaveAttribute('data-armed', 'true', { timeout: 5000 })
    await card.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Cancelled. Nothing was shared with the app.' })).toBeVisible()
    setSwitches(false)
  })
})
