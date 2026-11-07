/**
 * Shared harness of the admin-editorial tests: a throw-away content store
 * (temp working directory, no R2 / CDN / IndexNow), a signed-in admin
 * session, and a mock req/res pair to drive the real API routes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { offlinePublicCalendar } from './offlineCalendar'

for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CF_API_TOKEN', 'CF_ZONE_ID', 'INDEXNOW_KEY']) {
  delete process.env[k]
}

/**
 * Removes the AI feature's own settings and whatever the Anthropic SDK reads
 * from the environment (ANTHROPIC_LOG, ANTHROPIC_CUSTOM_HEADERS, ...), so a
 * developer's shell cannot change what a test sees. A test that needs one sets
 * it itself, after importing this file.
 */
export function scrubAiEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (k.startsWith('AI_') || k.startsWith('ANTHROPIC_')) delete env[k]
  }
}
scrubAiEnv()

/**
 * Loads a store module's close function. Stage F1 adds lib/ai/db.ts: before
 * that there is nothing to close (null). Once the module exists it must export
 * the function, because a store left open blocks removing the temp directory.
 * Takes a URL so the module is resolved after the harness moved the cwd.
 */
export async function loadStoreCloser(moduleUrl: URL, exportName: string): Promise<(() => void) | null> {
  if (!fs.existsSync(moduleUrl)) return null
  const close = (await import(moduleUrl.href))[exportName]
  if (typeof close !== 'function') throw new Error(`${moduleUrl.pathname} must export ${exportName}()`)
  return close as () => void
}

const AI_DB_MODULE = new URL('../lib/ai/db.ts', import.meta.url)

/**
 * A stored home document that links another GitHub profile or other
 * organizations has their lists loaded before its pages regenerate
 * (lib/githubData refreshGithubData), whoever wrote it: the editor's route,
 * a restore, or an approved AI proposal (lib/contentOps/home). Unit tests
 * never reach GitHub (tests/register.mjs refuses the network and fails the
 * file), so under this harness api.github.com answers "not found" at once
 * and the public calendar does not resolve (tests/offlineCalendar). The
 * loaders themselves are tests/github-orgs*.test.ts's subject.
 */
function offlineGithub(): () => void {
  const restoreCalendar = offlinePublicCalendar()
  const passThrough = globalThis.fetch
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname === 'api.github.com') {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    return passThrough(input as string | URL | Request, init)
  }) as typeof fetch
  globalThis.fetch = stub
  return () => {
    if (globalThis.fetch === stub) globalThis.fetch = passThrough
    restoreCalendar()
  }
}

export type Handler = (req: any, res: any) => unknown

export type CallResult = { statusCode: number; body: any; headers: Record<string, string>; revalidated: string[] }

export function editorialHarness(name: string, secret = `${name}-secret`) {
  process.env.JWT_SECRET = secret
  const originalCwd = process.cwd()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  let sessionId = ''
  let closeDb: (() => void) | null = null
  let closeAuthDb: (() => void) | null = null
  let closeAiDb: (() => void) | null = null
  let onlineGithub: (() => void) | null = null

  async function setup() {
    onlineGithub = offlineGithub()
    // A worker thread (lib/ai/compile) inherits the runner's `--import ./tests/register.mjs`, resolved against the
    // cwd at the moment it starts: the same relative path must lead to the real file from the temp directory too.
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true })
    fs.symlinkSync(path.join(originalCwd, 'tests', 'register.mjs'), path.join(tmp, 'tests', 'register.mjs'))
    process.chdir(tmp)
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
    const db = await import('../lib/db')
    // lib/db resolves data/ when it is first loaded: a test that imported it
    // (directly or through a store module) before this point would write to
    // the real data/content.db. Refuse instead.
    if (fs.realpathSync(path.dirname(db.CONTENT_DB_PATH)) !== path.join(fs.realpathSync(tmp), 'data')) {
      process.chdir(originalCwd)
      throw new Error(`lib/db was loaded before the harness moved to ${tmp}; import store modules inside tests`)
    }
    closeDb = db.closeDb
    closeAuthDb = (await import('../lib/adminAuth/db')).closeAuthDb
    closeAiDb = await loadStoreCloser(AI_DB_MODULE, 'closeAiDb')
    const { createSession } = await import('../lib/adminAuth/sessions')
    sessionId = createSession({ method: 'password', ttlMs: 3_600_000, device: null, ipPrefix: null, country: null }).id
  }

  function teardown() {
    closeDb?.()
    closeAuthDb?.()
    closeAiDb?.()
    onlineGithub?.()
    onlineGithub = null
    scrubAiEnv()
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  async function call(
    handler: Handler,
    opts: { method?: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; auth?: boolean; ip?: string } = {},
  ): Promise<CallResult> {
    const token = jwt.sign({ role: 'admin', email: 'owner@example.test', sid: sessionId }, secret, { algorithm: 'HS256' })
    const out: CallResult = { statusCode: 200, body: undefined, headers: {}, revalidated: [] }
    const res: any = {
      get statusCode() {
        return out.statusCode
      },
      set statusCode(c: number) {
        out.statusCode = c
      },
      status(c: number) {
        out.statusCode = c
        return res
      },
      setHeader(k: string, v: unknown) {
        out.headers[k.toLowerCase()] = String(v)
        return res
      },
      getHeader: (k: string) => out.headers[k.toLowerCase()],
      json(b: unknown) {
        out.body = JSON.parse(JSON.stringify(b))
        return res
      },
      send(b: unknown) {
        out.body = b
        return res
      },
      end(payload?: string) {
        if (typeof payload === 'string' && /json/.test(out.headers['content-type'] || '')) out.body = JSON.parse(payload)
        return res
      },
      async revalidate(p: string) {
        out.revalidated.push(p)
      },
    }
    const auth = opts.auth !== false
    await handler(
      {
        method: opts.method || 'GET',
        url: '/api/test',
        query: opts.query || {},
        body: opts.body,
        cookies: auth ? { cv_admin_token: token } : {},
        headers: { ...(auth ? { cookie: `cv_admin_token=${token}` } : {}), ...(opts.headers || {}) },
        // Vary `ip` to stay under the per-client write limits in long scenarios.
        socket: { remoteAddress: opts.ip || '127.0.0.41' },
      },
      res,
    )
    return out
  }

  return { tmp, setup, teardown, call }
}
