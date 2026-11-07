/**
 * M6 — keeping the AI code out of what visitors load (design §11 "Bundle
 * impact and keeping admin code out of shared chunks", §12.1):
 *
 *   - the import graph from pages/_app, the document and error pages, the
 *     site header and every public page — dynamic imports included, since a
 *     lazily loaded chunk still ships with the page — never reaches
 *     components/Admin/ai or lib/ai;
 *   - on the editors' pages, only the small Ask AI host loads with the page:
 *     the panel and everything it draws (the conversation, ChatMarkdown, the
 *     change cards, the run stream) load on first open, through dynamic();
 *   - the host itself, its contexts, copy and the editor bridge's helpers
 *     import none of the assistant's heavy modules statically;
 *   - after a build, scripts/perf-budget.mjs greps the client chunks for the
 *     server-only markers (anthropic-version, modelcontextprotocol,
 *     AI_KEYS_SECRET): that check exists and names them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, reachable, rel, resolveLocal } from './helpers/importGraph'

function walk(dir: string, skip: (relPath: string) => boolean = () => false): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    const r = rel(p)
    if (skip(r)) return []
    return e.isDirectory() ? walk(p, skip) : /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) ? [r] : []
  })
}

/** Every page a visitor can load: pages/ without the admin pages and the API routes. */
const PUBLIC_PAGES = walk(path.join(ROOT, 'pages'), (r) => r === 'pages/admin' || r === 'pages/api')
const HEADER = walk(path.join(ROOT, 'components/Header'))
const PUBLIC_SEEDS = Array.from(new Set(['pages/_app.tsx', 'pages/_document.tsx', 'pages/_error.tsx', ...HEADER, ...PUBLIC_PAGES]))

const isAi = (f: string) => f.startsWith('components/Admin/ai/') || f.startsWith('lib/ai/')

test('the seeds exist: _app, the header and the public pages', () => {
  for (const f of ['pages/_app.tsx', 'pages/index.tsx', 'pages/blog/[slug].tsx', 'pages/cv.tsx']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)) || PUBLIC_PAGES.some((p) => p.startsWith(f.replace(/\.tsx$/, ''))), f)
  }
  assert.ok(HEADER.length >= 3, HEADER.join(', '))
  assert.ok(PUBLIC_PAGES.length >= 15, `${PUBLIC_PAGES.length} public pages`)
  assert.ok(!PUBLIC_PAGES.some((p) => p.startsWith('pages/admin/') || p.startsWith('pages/api/')))
})

test('nothing a visitor loads reaches components/Admin/ai or lib/ai, dynamic imports included', () => {
  const all = reachable(PUBLIC_SEEDS)
  const hits = Array.from(all.entries())
    .filter(([f]) => isAi(f))
    .map(([, chain]) => chain.join(' -> '))
  assert.deepEqual(hits, [])
  // Sanity: the walk follows the public graph deep enough to mean something.
  for (const f of ['components/Header/Header.tsx', 'lib/ask/engine.ts']) assert.ok(all.has(f) || !fs.existsSync(path.join(ROOT, f)), f)
})

/** The files `file` loads with static imports only (import(), and so next/dynamic, left out). */
function staticImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  for (const m of src.matchAll(/(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[2]) continue
    const clause = m[3].trim()
    const list = /\{([^}]*)\}/.exec(clause)
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()
    const named = list ? list[1].split(',').map((s) => s.trim()).filter(Boolean) : []
    if (!outside && named.length && named.every((s) => s.startsWith('type '))) continue
    out.push(m[4])
  }
  for (const m of src.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out.map((s) => resolveLocal(file, s)).filter((f): f is string => !!f)
}

function staticReach(seeds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const queue: Array<[string, string[]]> = seeds.map((s) => [path.join(ROOT, s), [s]])
  while (queue.length) {
    const [file, chain] = queue.shift() as [string, string[]]
    const key = rel(file)
    if (out.has(key)) continue
    out.set(key, chain)
    for (const next of staticImports(file)) if (!out.has(rel(next))) queue.push([next, [...chain, rel(next)]])
  }
  return out
}

/** What only the open panel needs: never loaded with an editor page. */
const PANEL_ONLY = [
  'components/Admin/ai/AskPanel.tsx',
  'components/Admin/ai/MessageList.tsx',
  'components/Admin/ai/ChatMarkdown.tsx',
  'components/Admin/ai/ChatChange.tsx',
  'components/Admin/ai/ChangeCard.tsx',
  'components/Admin/ai/EditorSuggestion.tsx',
  'components/Admin/ai/Composer.tsx',
  'components/Admin/ai/ContextChips.tsx',
  'components/Admin/ai/useRun.ts',
  'components/Admin/ai/sseClient.ts',
  'components/Admin/ai/copy.ts',
]

test('the editors load only the Ask AI host with the page; the panel and the assistant load on first open', () => {
  const editors = [
    'pages/admin/blog/edit.tsx',
    'pages/admin/work/edit.tsx',
    'pages/admin/now.tsx',
    'pages/admin/uses.tsx',
    'pages/admin/about.tsx',
    'pages/admin/dashboard.tsx',
    'pages/admin/media.tsx',
    'components/Admin/system/ContentHealthPanel.tsx',
  ].filter((f) => fs.existsSync(path.join(ROOT, f)))
  assert.ok(editors.length >= 7, editors.join(', '))
  const all = staticReach(editors)
  assert.ok(all.has('components/Admin/ai/AskAi.tsx'), 'the host loads with the editors')
  const hits = PANEL_ONLY.filter((f) => all.has(f)).map((f) => all.get(f)!.join(' -> '))
  assert.deepEqual(hits, [], 'loaded by the page itself instead of on first open')
  // The host loads its panel through next/dynamic, never a static import.
  const host = fs.readFileSync(path.join(ROOT, 'components/Admin/ai/AskAi.tsx'), 'utf8')
  assert.match(host, /const AskPanel = dynamic\(\(\) => import\('\.\/AskPanel'\), \{ ssr: false \}\)/)
  // Ask AI shows nothing and binds no key until the server says AI access is on.
  assert.match(host, /if \(!ask\.available\) return null/)
  assert.match(host, /if \(!available\) return\n/)
})

test('the eager Ask AI pieces stay small: host, contexts, copy, the bridge helpers and Contains AI edits import nothing heavy', () => {
  const eager = ['components/Admin/ai/AskAi.tsx', 'components/Admin/ai/askContext.ts', 'components/Admin/ai/askCopy.ts', 'components/Admin/ai/editorBridge.ts', 'components/Admin/ai/editorBase.ts', 'components/Admin/ai/useAiTouch.ts', 'components/Admin/ai/ContainsAiEdits.tsx']
  const all = staticReach(eager)
  const aiFiles = Array.from(all.keys()).filter(isAi).sort()
  assert.deepEqual(aiFiles, [...eager].sort(), 'only these AI modules load with an editor page')
  assert.ok(!Array.from(all.keys()).some((f) => f.startsWith('lib/')) || Array.from(all.keys()).filter((f) => f.startsWith('lib/')).every((f) => !f.startsWith('lib/ai/')), 'no server AI module')
})

test('after a build, the budget script greps the client chunks for the server-only markers', () => {
  const budget = fs.readFileSync(path.join(ROOT, 'scripts/perf-budget.mjs'), 'utf8')
  assert.match(budget, /SERVER_ONLY_MARKERS = \['anthropic-version', 'modelcontextprotocol', 'AI_KEYS_SECRET'\]/)
  assert.match(budget, /server-only code in a client chunk/)
})
