/**
 * M3 — the review link a proposal returns, /ai/review/<id> (design §6.1,
 * §12.1 ai-review-url): a same-site bounce to the change's admin page, with
 * no data, granting nothing. The id must be a change id before any bounce —
 * the bounce page only checks the leading slash, so a traversal such as
 * `../../../api/admin/orcid/connect` would otherwise become a same-site GET
 * of an admin route that acts when opened. While AI access is closed it
 * answers like an unknown path.
 */
import { createRequire } from 'node:module'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness, type Handler } from './editorialHarness'

const require = createRequire(import.meta.url)
const h = editorialHarness('ai-review-url', 'ai-review-url-secret-0123456789abcdef0123456789ab')
let open: Handler

before(async () => {
  await h.setup()
  open = (await import('../pages/api/oauth/open')).default as Handler
})
after(() => {
  delete process.env.SITE_URL
  h.teardown()
})

async function setOpen(on: boolean) {
  const { getAuthDb } = await import('../lib/adminAuth/db')
  getAuthDb().prepare('UPDATE ai_settings SET enabled = ?, mcp_enabled = ? WHERE id = 1').run(on ? 1 : 0, on ? 1 : 0)
  if (on) process.env.SITE_URL = 'https://site.example'
  else delete process.env.SITE_URL
}

const ID = 'ch_abcdefghijklmnop'

test('closed: a valid id answers a bare 404, like an unknown path', async () => {
  await setOpen(false)
  const out = await h.call(open, { query: { id: ID }, auth: false })
  assert.equal(out.statusCode, 404)
  assert.equal(out.body, undefined)
})

test('open: a change id bounces to its admin page — 200, no script, no referrer, never cached, no data', async () => {
  await setOpen(true)
  for (const auth of [false, true]) {
    const out = await h.call(open, { query: { id: ID }, auth })
    assert.equal(out.statusCode, 200)
    assert.match(out.headers['content-type'], /^text\/html/)
    assert.equal(out.headers['referrer-policy'], 'no-referrer')
    assert.equal(out.headers['cache-control'], 'no-store')
    const html = String(out.body)
    assert.match(html, /<meta http-equiv="refresh" content="0; url=\/admin\/ai\/change\/ch_abcdefghijklmnop">/)
    assert.match(html, /<a href="\/admin\/ai\/change\/ch_abcdefghijklmnop">Continue<\/a>/)
    assert.doesNotMatch(html, /<script/i)
    assert.match(html, /<title>AI change<\/title>/)
  }
  // Whether the change exists is the admin page's to say, behind the session: the bounce is the same for any id.
  const unknown = await h.call(open, { query: { id: 'ch_zzzzzzzzzzzzzzzz' }, auth: false })
  assert.equal(unknown.statusCode, 200)
})

test('anything but a change id answers 404 with no bounce, traversals included', async () => {
  await setOpen(true)
  const bad = [
    '../../../api/admin/orcid/connect',
    '..%2F..%2F..%2Fapi%2Fadmin%2Forcid%2Fconnect',
    'ch_abcdefghijklmnop/../../api/admin/export',
    'ch_ABCDEFGHIJKLMNOP',
    'ch_abcdefghijklmno',
    'ch_abcdefghijklmnopq',
    'ch_abcdefghijklmn01',
    '//evil.example',
    'https://evil.example/x',
    '',
    ' ch_abcdefghijklmnop',
  ]
  for (const id of bad) {
    const out = await h.call(open, { query: { id }, auth: false })
    assert.equal(out.statusCode, 404, JSON.stringify(id))
    assert.equal(out.body, undefined, `${JSON.stringify(id)}: no bounce`)
  }
  const twice = await h.call(open, { query: { id: [ID, ID] }, auth: false })
  assert.equal(twice.statusCode, 404, 'a repeated parameter is not an id')
  assert.equal((await h.call(open, { method: 'POST', query: { id: ID }, auth: false })).statusCode, 405)
})

test('the public address reaches the route only as one path segment; whatever it captures is checked as above', async () => {
  const { buildCustomRoute } = require('next/dist/server/lib/router-utils/filesystem.js') as {
    buildCustomRoute: (type: 'rewrite', item: object, basePath: string, caseSensitive?: boolean) => { match: (p: string) => false | Record<string, string | string[]> }
  }
  const { prepareDestination } = require('next/dist/shared/lib/router/utils/prepare-destination.js') as {
    prepareDestination: (args: { appendParamsToQuery: boolean; destination: string; params: object; query: object }) => { parsedDestination: { pathname: string; query: Record<string, unknown> } }
  }
  const { aiPublicRewrites } = require('../lib/aiPublicRoutes.js') as typeof import('../lib/aiPublicRoutes.js')
  const rule = aiPublicRewrites().find((r) => r.source === '/ai/review/:id')
  assert.ok(rule, 'the rewrite exists')
  assert.deepEqual(rule.has, [{ type: 'header', key: 'x-ai-open', value: '1' }], 'only while the proxy marked the request open')
  const route = buildCustomRoute('rewrite', rule, '')
  const params = route.match(`/ai/review/${ID}`)
  assert.ok(params)
  const { parsedDestination } = prepareDestination({ appendParamsToQuery: true, destination: rule.destination, params, query: {} })
  assert.equal(parsedDestination.pathname, '/api/oauth/open')
  assert.equal(parsedDestination.query.id, ID)
  // More than one segment never matches; an encoded slash stays inside the one segment, which the route refuses.
  assert.equal(route.match('/ai/review/ch_abcdefghijklmnop/x'), false)
  const encoded = route.match('/ai/review/..%2F..%2Fapi%2Fadmin%2Forcid%2Fconnect')
  if (encoded) {
    const d = prepareDestination({ appendParamsToQuery: true, destination: rule.destination, params: encoded, query: {} }).parsedDestination
    await setOpen(true)
    const out = await h.call(open, { query: { id: d.query.id }, auth: false })
    assert.equal(out.statusCode, 404)
  }
})

test('one bounce page for three routes: the review link, the OAuth authorize bounce and ORCID’s return each pass their own words to bounceHtml, escaped; the page is otherwise the same', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { bounceHtml } = await import('../lib/orcid/connectRoute')
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
  // Each route imports the one helper (no copy of the page anywhere) and names its own title and line.
  for (const route of ['pages/api/oauth/open.ts', 'pages/api/oauth/authorize.ts']) {
    assert.match(read(route), /import \{ bounceHtml \} from '\.\.\/\.\.\/\.\.\/lib\/orcid\/connectRoute'/, route)
    assert.doesNotMatch(read(route), /http-equiv="refresh"/, `${route}: no page of its own`)
  }
  assert.match(read('pages/api/oauth/authorize.ts'), /const PAGE = \{ title: 'Connecting an app', line: 'Opening the connection page…' \}/)
  // ORCID's return keeps its words by default.
  assert.match(bounceHtml('/admin/dashboard?tab=cv'), /<title>Back to CV Studio<\/title>[\s\S]*<p>Returning to CV Studio… <a/)
  // The words are text, never markup.
  const hostile = bounceHtml('/admin/ai/change/ch_abcdefghijklmnop', { title: '</title><script>x()</script>', line: '<img src=x>' })
  assert.doesNotMatch(hostile, /<script|<img/)
  assert.match(hostile, /<title>&lt;\/title&gt;&lt;script&gt;x\(\)&lt;\/script&gt;<\/title>/)
  // Apart from the target and the words, the review bounce is ORCID's page byte for byte.
  const review = String((await h.call(open, { query: { id: ID }, auth: false })).body)
  const orcid = bounceHtml('/admin/ai/change/ch_abcdefghijklmnop')
  assert.equal(review.replace('<title>AI change</title>', '').replace('Opening the change…', ''), orcid.replace('<title>Back to CV Studio</title>', '').replace('Returning to CV Studio…', ''))
})
