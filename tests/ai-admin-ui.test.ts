/**
 * Admin → AI → Connections, the parts that need no browser (stage M1b):
 * the pure helpers, the copy's promises against the real catalogue (an
 * access level is never described with a capability no tool gives), and
 * the page's boundary — everything under components/Admin/ai loads with
 * the page through dynamic(), and none of it imports the server's AI layer.
 * The browser half is e2e/ai-admin.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, localImports, reachable, rel } from './helpers/importGraph'
import { claudeCodeCommand, claudeCodeOAuthCommand, bearerHeader, codexCommands, cursorConfig, isLocalHostname, isWebRedirect, sameHost, serverName, shellRef, timeLeft, tokenEnvVar } from '../components/Admin/ai/format'
import { AI_COPY, RISK_COPY, levelName, levelSummary } from '../components/Admin/ai/copy'
import type { CatalogueTool } from '../components/Admin/ai/types'
import { AI_APPS_NOT_ENDED, aiAppsNotEndedText } from '../components/Admin/security/securityFormat'

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')

test('server name, its token variable and the Claude Code command (design §13 step 5)', () => {
  assert.equal(serverName('http://127.0.0.1:3747/mcp'), 'site-local')
  assert.equal(serverName('http://localhost:3002/mcp'), 'site-local')
  assert.equal(serverName('http://admin.localhost:3002/mcp'), 'site-local')
  assert.equal(serverName('https://www.example-site.com/mcp'), 'example-site')
  assert.equal(serverName('https://example.com/mcp'), 'example')
  assert.equal(serverName('https://203.0.113.9/mcp'), 'site', 'an address is no name')
  assert.equal(serverName(null), 'site')
  assert.equal(serverName('not a url'), 'site')
  assert.equal(tokenEnvVar('site-local'), 'SITE_LOCAL_MCP_TOKEN')
  assert.equal(tokenEnvVar('example-site'), 'EXAMPLE_SITE_MCP_TOKEN')
  assert.equal(
    claudeCodeCommand('site-local', 'http://127.0.0.1:3747/mcp', shellRef('SITE_LOCAL_MCP_TOKEN')),
    'claude mcp add --transport http --scope local site-local http://127.0.0.1:3747/mcp --header "Authorization: Bearer $SITE_LOCAL_MCP_TOKEN"',
  )
  assert.equal(bearerHeader('pst_x'), 'Authorization: Bearer pst_x')
  for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '[::1]', 'a.localhost']) assert.equal(isLocalHostname(h), true, h)
  for (const h of ['example.com', 'localhost.example.com', '192.0.2.10', '198.51.100.7']) assert.equal(isLocalHostname(h), false, h)
})

test('each access level is described from the tools that exist, never with a capability the catalogue lacks', async () => {
  const { catalogueView } = await import('../lib/ai/registry')
  const tools = catalogueView() as CatalogueTool[]
  const [one, two, three] = [1, 2, 3].map((l) => levelSummary(l, tools))
  assert.deepEqual([one.name, two.name, three.name], ['Read published', 'Read and draft', 'Read, draft and propose'])
  assert.equal(one.count, tools.filter((t) => t.level === 1).length)
  assert.equal(three.count, tools.length)
  const drafts = tools.some((t) => t.risk === 'draft')
  const proposals = tools.some((t) => t.risk === 'live' || t.risk === 'destructive')
  assert.equal(/saves drafts/.test(two.text), drafts, 'Read and draft promises drafting exactly when a draft tool exists')
  assert.equal(/Each one waits for your approval/.test(three.text), proposals, 'propose promises proposals exactly when one exists')
  assert.equal(/no proposal tools yet/.test(three.text), !proposals)
  // With such tools (a later stage's catalogue), the words follow.
  const later: CatalogueTool[] = [...tools, { name: 'edit_content', title: 'Edit', description: '', scope: 'content:draft', level: 2, risk: 'draft', cost: 'cheap' }, { name: 'propose_publishing', title: 'Publish', description: '', scope: 'content:propose', level: 3, risk: 'live', cost: 'cheap' }]
  assert.match(levelSummary(2, later).text, /saves drafts/)
  assert.match(levelSummary(3, later).text, /waits for your approval/)
  assert.equal(levelName(0), 'Read published')
  assert.equal(levelName(9), 'Read, draft and propose')
  for (const risk of ['read', 'draft', 'live', 'destructive'] as const) assert.ok(RISK_COPY[risk].title && RISK_COPY[risk].means)
})

test('the copy keeps the admin’s voice: no exclamation marks, curly quotes, nothing naming a server secret', () => {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (typeof v === 'function') {
      const out = (v as (...a: unknown[]) => unknown)(2, 2)
      if (typeof out === 'string') strings.push(out)
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(AI_COPY)
  assert.ok(strings.length > 60)
  for (const s of strings) {
    assert.doesNotMatch(s, /!(?!=)/, s)
    assert.doesNotMatch(s, /(^|\s)"|"(\s|$|[.,])/, `straight double quotes: ${s}`)
    assert.doesNotMatch(s, /AI_KEYS_SECRET|JWT_SECRET/, s)
  }
  // The localhost banner states the override of design §8.5 (no tunnel).
  assert.match(AI_COPY.connect.localBanner, /only reach this site once it is deployed/)
  assert.doesNotMatch(AI_COPY.connect.localBanner, /tunnel/i)
  assert.equal(AI_COPY.newToken.once, 'This token is shown once. Only its fingerprint is stored here.')
})

test('the page loads Connections with dynamic(); components/Admin/ai never imports the server’s AI or MCP layer', () => {
  const page = read('pages/admin/ai.tsx')
  assert.match(page, /dynamic\(\(\) => import\('\.\.\/\.\.\/components\/Admin\/ai\/ConnectionsPanel'\), \{\s*ssr: false/)
  const files = fs.readdirSync(path.join(ROOT, 'components/Admin/ai')).map((f) => path.join(ROOT, 'components/Admin/ai', f))
  const graph = reachable(files.map(rel))
  const server = Array.from(graph.entries())
    .filter(([f]) => /^lib\/(ai|mcp)\//.test(f))
    .map(([, chain]) => chain.join(' -> '))
  assert.deepEqual(server, [], 'client code reaches server modules')
  assert.ok(graph.has('components/Admin/ai/ConnectionsPanel.tsx') && graph.size > files.length, 'sanity: the graph was walked')
  for (const f of files) {
    for (const dep of localImports(f).map(rel)) assert.ok(!dep.startsWith('pages/api/'), `${rel(f)} imports ${dep}`)
  }
  // The portal links to it (the way in of design §13 step 2).
  assert.match(read('pages/admin/index.tsx'), /href: '\/admin\/ai'/)
})

test('when AI apps could not be ended, the Security page says how many may still act, from the reloaded count, and where to end them', () => {
  assert.equal(aiAppsNotEndedText({ apps: 0, reachable: true }), null, 'nothing can act: no warning')
  assert.equal(
    aiAppsNotEndedText({ apps: 2, reachable: true }),
    'The AI apps couldn’t be ended: 2 AI apps can still reach this site. Check Connections and revoke any you don’t trust.',
  )
  assert.equal(
    aiAppsNotEndedText({ apps: 1, reachable: false }),
    'The AI apps couldn’t be ended: 1 AI app is still connected and would reach this site again once AI access is open. Check Connections and revoke any you don’t trust.',
  )
  assert.match(aiAppsNotEndedText(null) ?? '', /can’t be counted right now\. Check Connections/)
  // The words of a failed revoke and of a failed copy keep the admin's voice too.
  for (const s of [AI_APPS_NOT_ENDED, aiAppsNotEndedText(null) ?? '', AI_COPY.access.endFailed, AI_COPY.copyFailed]) {
    assert.doesNotMatch(s, /!|(^|\s)"|'/, s)
    assert.ok(s.endsWith('.'), s)
  }
  assert.match(AI_COPY.access.endFailed, /revoke them under Connected apps/)
  assert.equal(AI_COPY.copyFailed, 'Couldn’t copy. The text is selected: copy it yourself.')
  // Copying falls back to the shared helper (a page that is not a secure context) and says when it failed.
  const field = read('components/Admin/ai/CopyField.tsx')
  assert.match(field, /import \{ copyText \} from '\.\.\/\.\.\/MDX\/clipboard'/)
  assert.match(field, /AI_COPY\.copyFailed/)
  assert.doesNotMatch(field, /navigator\.clipboard/, 'one copy path: the shared helper')
})

// ── Stage M5: the client tabs and the consent page ─────────────────────────

test('client setup helpers: Claude Code without a header (OAuth), Cursor’s mcp.json with and without a token, Codex’s add and login', () => {
  const server = 'https://www.example-site.com/mcp'
  assert.equal(claudeCodeOAuthCommand('example-site', server), 'claude mcp add --transport http --scope local example-site https://www.example-site.com/mcp')
  assert.doesNotMatch(claudeCodeOAuthCommand('example-site', server), /--header|Bearer/)
  assert.deepEqual(JSON.parse(cursorConfig('example-site', server)), { mcpServers: { 'example-site': { url: server } } })
  assert.deepEqual(JSON.parse(cursorConfig('example-site', server, 'EXAMPLE_SITE_MCP_TOKEN')), {
    mcpServers: { 'example-site': { url: server, headers: { Authorization: 'Bearer ${env:EXAMPLE_SITE_MCP_TOKEN}' } } },
  })
  assert.equal(codexCommands('site-local', 'http://127.0.0.1:3002/mcp'), 'codex mcp add site-local --url http://127.0.0.1:3002/mcp\ncodex mcp login site-local')
  assert.equal(timeLeft(1_000_000 + 581_000, 1_000_000), '9:41')
  assert.equal(timeLeft(1_000_000, 1_000_000 + 5_000), '0:00')
  assert.equal(timeLeft(1_000_500, 1_000_000), '0:01', 'rounds up: never 0:00 while time is left')
  for (const ok of ['http://127.0.0.1:53123/callback?code=x', 'https://app.example.com/cb']) assert.equal(isWebRedirect(ok), true, ok)
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'cursor://x', '/admin', '', 7, null]) assert.equal(isWebRedirect(bad), false, String(bad))
})

test('the typed host is compared in the browser exactly as the server compares it (lib/ai/oauth typedHostMatches)', async () => {
  const { typedHostMatches } = await import('../lib/ai/oauth')
  const cases: Array<[string, string]> = [
    ['127.0.0.1', '127.0.0.1'],
    [' 127.0.0.1. ', '127.0.0.1'],
    ['LOCALHOST', 'localhost'],
    ['[::1]', '[::1]'],
    ['::1', '[::1]'],
    ['editor.example.com', 'editor.example.com'],
    ['Editor.Example.com.', 'editor.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['editor.example.co', 'editor.example.com'],
    ['127.0.0.2', '127.0.0.1'],
    ['', 'editor.example.com'],
    ['editor.example.com/cb', 'editor.example.com'],
    ['http://editor.example.com', 'editor.example.com'],
  ]
  for (const [typed, host] of cases) assert.equal(sameHost(typed, host), typedHostMatches(typed, host), `${typed} vs ${host}`)
  assert.equal(sameHost('bücher.example', 'xn--bcher-kva.example'), true, 'an IDN typed in Unicode matches its punycode')
  assert.equal(sameHost('editor.example.co', 'editor.example.com'), false)
})

test('the client tabs and the consent say only what is true: every app signs in during a window; Claude and ChatGPT need the public address; no plan claim', () => {
  const tabs = read('components/Admin/ai/ClientSetupTabs.tsx')
  for (const app of ['claude', 'chatgpt', 'claude-code', 'cursor', 'vscode', 'codex', 'other']) {
    assert.ok(AI_COPY.clients[app as keyof typeof AI_COPY.clients], app)
    assert.match(tabs, new RegExp(`key: '${app}'`), app)
  }
  assert.match(tabs, /\{ key: 'claude', cloud: true, token: false \}/)
  assert.match(tabs, /\{ key: 'chatgpt', cloud: true, token: false \}/)
  assert.match(AI_COPY.clients.cloudOnly('Claude'), /only at its public address, once it is deployed/)
  assert.doesNotMatch(JSON.stringify(AI_COPY.clients), /tunnel|Plus|Pro plan|Business|Enterprise/i)
  assert.equal(AI_COPY.consent.unverified('Example Editor'), 'This app named itself “Example Editor”. We can’t verify that. Continue only if you started this from the app yourself.')
  assert.equal(AI_COPY.consent.manyRequests(3), '3 connection requests arrived in this window. If you started one, cancel and try again.')
  assert.equal(AI_COPY.consent.closed, 'This site is not expecting a new connection. Open Admin → AI → Connections, allow a new connection, then try again.')
  assert.match(AI_COPY.consent.lasts, /90 days at most, and ends after 30 days without use/)
})

test('the consent page loads its card with dynamic(), reads its parameters as they came, and follows only a web redirect, by location.assign, never a form', () => {
  const page = read('pages/admin/ai/connect.tsx')
  assert.match(page, /dynamic\(\(\) => import\('\.\.\/\.\.\/\.\.\/components\/Admin\/ai\/ConsentCard'\), \{\s*ssr: false/)
  assert.match(page, /window\.location\.search/)
  const graph = reachable(['pages/admin/ai/connect.tsx'])
  assert.deepEqual(Array.from(graph.keys()).filter((f) => /^lib\/(ai|mcp)\//.test(f)), [], 'the page reaches no server AI module')
  const card = read('components/Admin/ai/ConsentCard.tsx')
  assert.doesNotMatch(card, /<form|as="form"|\.submit\(/, 'no form: CSP form-action never meets the app’s redirect')
  assert.match(card, /window\.location\.assign\(redirect\)/)
  assert.match(card, /if \(!isWebRedirect\(redirect\)\)/)
  assert.match(card, /freshWithinMs: FRESH_MS/)
  assert.match(card, /FRESH_MS = 120_000/)
  assert.match(card, /useArmedAction/)
  assert.match(card, /isDisabled=\{!armed \|\| !hostOk/)
  // The card never takes the focus when it appears (arming counts focus inside it as intent).
  assert.doesNotMatch(card, /autoFocus|\.focus\(\)/)
})
