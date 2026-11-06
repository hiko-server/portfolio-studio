/**
 * M1 — the AI tool layer's boundary, read from the source (design §2
 * properties 1, 3, 5; §12.1; THREATS F9, F17):
 *
 *   - what the tool layer and the MCP wiring load never reaches visitor
 *     data, logs, backups, mail or CV share links — the inbox, analytics and
 *     error reports are unreachable from any tool, which is what lets the
 *     site state it as fact (/colophon, design §10);
 *   - a tool imports no public writer and no module that holds one (the
 *     approval path's lib/ai/apply, the live content services, review links,
 *     R2, ORCID): a tool physically cannot publish;
 *   - no tool mints a session or calls /api/internal/*; the MCP route never
 *     reads the admin cookie;
 *   - the registry is a subset of the design's catalogue, and no tool exists
 *     for any capability the design rules out.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, localImports, reachable, rel, valueImports } from './helpers/importGraph'

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [rel(p)] : []
  })
}

const TOOLS = walk(path.join(ROOT, 'lib/ai/tools'))
const PLANS = walk(path.join(ROOT, 'lib/ai/plans'))
const MCP = walk(path.join(ROOT, 'lib/mcp'))
/** The seeds of design §12.1: every tool and plan, the executor, the registry, the MCP wiring. */
const SEEDS = [...TOOLS, ...PLANS, 'lib/ai/execute.ts', 'lib/ai/registry.ts', ...MCP]

/** The design's catalogue (§4.2): 8 + 3 read, 3 draft-safe writes, 10 proposals. */
const CATALOGUE = [
  'get_site_overview',
  'search_content',
  'get_content',
  'get_home',
  'get_cv',
  'list_media',
  'get_content_health',
  'get_authoring_guide',
  'list_versions',
  'get_change',
  'list_my_changes',
  'create_draft',
  'edit_content',
  'set_media_text',
  'propose_publishing',
  'propose_page_edit',
  'propose_home_edit',
  'propose_cv_edit',
  'propose_tag_change',
  'propose_restore',
  'propose_content_fix',
  'propose_apply_alt',
  'propose_media_import',
  'propose_delete',
]

test('the seeds exist: every tool module, the executor, the registry and the MCP wiring', () => {
  assert.ok(TOOLS.length >= 8, TOOLS.join(', '))
  for (const f of SEEDS) assert.ok(fs.existsSync(path.join(ROOT, f)), f)
})

test('what the tool layer loads, transitively, never reaches visitor data, logs, backups, mail or CV share links', () => {
  const forbidden = /^lib\/(inbox|analytics\/|errors\/|logBuffer|backup|mailer|cvShare\/)/
  const all = reachable(SEEDS)
  const hits = Array.from(all.entries())
    .filter(([f]) => forbidden.test(f))
    .map(([, chain]) => chain.join(' -> '))
  assert.deepEqual(hits, [])
  // Sanity: the walk reaches the stores the tools read.
  for (const f of ['lib/contentStore.ts', 'lib/cvdata.ts', 'lib/home.ts', 'lib/ai/access.ts', 'lib/ai/db.ts']) assert.ok(all.has(f), f)
  // The owner's mail goes through lib/ai/alerts, which only routes import.
  assert.ok(!all.has('lib/ai/alerts.ts'), 'lib/ai/alerts is outside the tool layer')
})

/** Named value imports of a module, per specifier. */
function namedImports(file: string): Array<{ spec: string; names: string[] }> {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: Array<{ spec: string; names: string[] }> = []
  for (const m of src.matchAll(/(?:^|[;\n])\s*import\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue
    const list = /\{([^}]*)\}/.exec(m[2])
    const names = list ? list[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type ')).map((s) => s.split(/\s+as\s+/)[0].trim()) : []
    out.push({ spec: m[3], names })
  }
  return out
}

test('a tool or plan imports no public writer and no module that holds one: it cannot publish', () => {
  const bannedFiles = [
    /^lib\/ai\/apply\.ts$/,
    /^lib\/contentOps\/(items|pages|home|cv|versions)\.ts$/,
    /^lib\/review\//,
    /^lib\/r2\.ts$/,
    /^lib\/orcid\//,
  ]
  const bannedNames = new Set(['writeHome', 'writeCvData', 'writePage', 'deleteOne', 'renameSlug', 'applyTagChange', 'applyFixes', 'moveToTrash', 'purgeFromTrash', 'writeOne', 'putItem', 'putPage', 'putKv', 'removeItem'])
  const problems: string[] = []
  for (const file of [...TOOLS, ...PLANS]) {
    for (const dep of localImports(path.join(ROOT, file)).map(rel)) {
      if (bannedFiles.some((re) => re.test(dep))) problems.push(`${file} imports ${dep}`)
    }
    for (const { spec, names } of namedImports(file)) for (const n of names) if (bannedNames.has(n)) problems.push(`${file} imports ${n} from ${spec}`)
  }
  assert.deepEqual(problems, [])
})

test('no tool mints a session or a cookie, or calls /api/internal/*; the tool layer never names a writer of links or redirects', () => {
  const code = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const file of [...TOOLS, ...PLANS, 'lib/ai/execute.ts', 'lib/ai/registry.ts', 'lib/ai/views.ts', 'lib/ai/publicMedia.ts', 'lib/ai/healthView.ts', ...MCP]) {
    const src = code(file)
    for (const name of ['signAdminToken', 'startAdminSession', 'createSession', 'setCookie', 'triggerInternalJob', '/api/internal', 'revokeLinksAt', 'revokeItemLinks', 'createReviewLink', 'forgetRedirectFrom', 'removeRedirect', 'rebuildUsage', 'scanLocalAssets', 'syncLocalAssetRows']) {
      assert.ok(!src.includes(name), `${file} names ${name}`)
    }
  }
  // lib/internalJobs is loaded by the modules that own the server's jobs (the publish scheduler, which lib/mdx-admin
  // imports; the link checker's status; the activity log's check that a request is the server calling itself),
  // never by the AI layer itself, and no AI module names it.
  for (const [file] of Array.from(reachable(SEEDS).entries())) {
    if (!localImports(path.join(ROOT, file)).map(rel).includes('lib/internalJobs.ts')) continue
    assert.ok(['lib/schedule/scheduler.ts', 'lib/contentHealth/schedule.ts', 'lib/audit/record.ts'].includes(file), `${file} loads lib/internalJobs`)
  }
})

test('the MCP route never reads the admin cookie, and reaches the mailer only through lib/ai/alerts', async () => {
  // withApi loads the activity log's browser capture (which reads the session cookie) only for a route the log
  // describes; /mcp is not one. The route itself never touches a cookie.
  const { AUDITED_ROUTES } = await import('../lib/audit/describe')
  assert.equal(AUDITED_ROUTES.has('mcp'), false)
  const src = fs.readFileSync(path.join(ROOT, 'pages/api/mcp.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(src, /req\.cookies|headers\.cookie|getCookie|readAdmin(Context|Claims)|isAdminRequest/)
  assert.ok(!/cookie/i.test(valueImports(src).join(' ')))
  // Every path from the route to the mailer passes lib/ai/alerts.
  const direct = localImports(path.join(ROOT, 'pages/api/mcp.ts')).map(rel).filter((f) => f !== 'lib/ai/alerts.ts')
  const withoutAlerts = reachable(direct)
  assert.ok(!withoutAlerts.has('lib/mailer.ts'), withoutAlerts.get('lib/mailer.ts')?.join(' -> '))
  assert.ok(reachable(['pages/api/mcp.ts']).has('lib/mailer.ts'), 'sanity: alerts do mail')
})

test('lib/ai/access reports events through a callback: it never reaches the mailer itself', () => {
  const all = reachable(['lib/ai/access.ts'])
  assert.ok(!all.has('lib/mailer.ts'), all.get('lib/mailer.ts')?.join(' -> '))
})

test('the registry is the design’s catalogue, reads and draft-safe writes for now, and every capability the design rules out is absent', async () => {
  const { TOOLS: registered } = await import('../lib/ai/registry')
  const names = registered.map((t) => t.name)
  for (const n of names) assert.ok(CATALOGUE.includes(n), `${n} is not in the design's catalogue`)
  assert.deepEqual(names, [...names].sort(), 'sorted by name')
  // Stage M2: the eleven reads and the three draft-safe writes (stage M3 adds the proposals).
  const WRITES = ['create_draft', 'edit_content', 'set_media_text']
  assert.deepEqual(
    [...names].sort(),
    [...WRITES, 'get_authoring_guide', 'get_change', 'get_content', 'get_content_health', 'get_cv', 'get_home', 'get_site_overview', 'list_media', 'list_my_changes', 'list_versions', 'search_content'].sort(),
  )
  for (const t of registered) {
    assert.equal(t.risk, WRITES.includes(t.name) ? 'draft' : 'read', t.name)
    if (WRITES.includes(t.name)) {
      assert.equal(t.scope, 'content:draft', t.name)
      assert.equal('plan' in t && !('read' in t), true, `${t.name} is a plan, not a read`)
      assert.equal(t.annotations.readOnlyHint, false, t.name)
      assert.equal(t.tags.publicEffect, false, `${t.name} has no public effect`)
    }
  }
  // No tool for identity, credentials, settings, outward sharing, last-copy destruction or visitor data (§1).
  const never = /token|key|secret|setting|session|passw|passkey|approv|grant|inbox|message|contact|analytic|visitor|error|log\b|backup|restore_drill|mongo|orcid|share|review_link|export|purge|mail|security|storage/
  for (const n of names) assert.doesNotMatch(n, never, n)
})
