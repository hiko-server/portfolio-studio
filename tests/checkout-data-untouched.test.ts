/**
 * A unit run leaves the checkout's data/ as it found it.
 *
 * The stores live in data/ under process.cwd() (lib/db, lib/adminAuth/db,
 * lib/ai/db, ...), and opening one creates and migrates it. A test that opens
 * one before moving its cwd writes to the checkout's own data/: in the main
 * checkout, the owner's live stores; in the trial's worktree, a data/auth.db
 * that makes scripts/ai-trial.mjs take the store for a server's ("foreign")
 * and serve it, empty, instead of installing the fixtures.
 * tests/ai-providers-anthropic.test.ts did this once (System health opened
 * data/auth.db and data/ai.db).
 *
 * A file that uses a harness (editorialHarness, assistantHarness, ...) or
 * moves into a temp dir checks its own store paths. Every other test file
 * that can reach a store module runs again here, all together, with its cwd
 * in a shadow of the checkout: every top-level entry is a link to the real
 * one, except data/, a fresh directory holding copies of the git seeds.
 * Afterwards that data/ must hold exactly the seeds, unchanged. When it does
 * not, each file runs alone to name the ones that wrote. Their own results
 * belong to the main run and are not read here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, reachable, rel } from './helpers/importGraph'

const SEEDS = ['home.json', 'cvdata.json']
const SELF = 'tests/checkout-data-untouched.test.ts'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(?:ts|tsx|js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

/** The lib modules that resolve a file under data/ from process.cwd(): the stores, and what opens them. */
function storeModules(): Set<string> {
  return new Set(
    sourceFiles(path.join(ROOT, 'lib'))
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf8')
        return src.includes('process.cwd()') && src.includes("'data'")
      })
      .map(rel),
  )
}

/** Test files that can reach a store and neither move their cwd nor use a harness. */
function unisolatedTests(): string[] {
  const stores = storeModules()
  return fs
    .readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/${f}`)
    .filter((f) => f !== SELF)
    .filter((f) => {
      const reached = reachable([f])
      if (![...stores].some((s) => reached.has(s))) return false
      return !/process\.chdir\(|Harness\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))
    })
    .sort()
}

type Shadow = { dir: string; seeds: Map<string, Buffer> }

/** A shadow of the checkout whose data/ holds only copies of the seeds. */
function shadow(): Shadow {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-data-'))
  for (const name of fs.readdirSync(ROOT)) if (name !== 'data') fs.symlinkSync(path.join(ROOT, name), path.join(dir, name))
  fs.mkdirSync(path.join(dir, 'data'))
  const seeds = new Map<string, Buffer>()
  for (const name of SEEDS) {
    const from = path.join(ROOT, 'data', name)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(dir, 'data', name))
    seeds.set(name, fs.readFileSync(path.join(dir, 'data', name)))
  }
  return { dir, seeds }
}

/** What a run left in the shadow's data/ beyond the untouched seeds (names only). */
function leftovers({ dir, seeds }: Shadow): string[] {
  const data = path.join(dir, 'data')
  const out: string[] = []
  for (const name of fs.readdirSync(data).sort()) {
    const before = seeds.get(name)
    if (!before) out.push(name)
    else if (!before.equals(fs.readFileSync(path.join(data, name)))) out.push(`${name} (changed)`)
  }
  for (const name of seeds.keys()) if (!fs.existsSync(path.join(data, name))) out.push(`${name} (removed)`)
  return out
}

const RUN_LIMIT_MS = 300_000

/** Runs test files the way the unit gate does, with the cwd in the shadow; resolves false if it had to be stopped. */
function runIn({ dir }: Shadow, files: string[]): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // As the gate runs them; and a nested runner must not take itself for one of this runner's children.
  for (const k of ['JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASS', 'NODE_TEST_CONTEXT']) delete env[k]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './tests/register.mjs', '--test', ...files], { cwd: dir, env, stdio: 'ignore' })
    let stopped = false
    const timer = setTimeout(() => {
      stopped = true
      child.kill('SIGKILL')
    }, RUN_LIMIT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(!stopped)
    })
  })
}

test('the shadow catches a test that opens a store from the checkout (what ai-providers-anthropic once did)', async () => {
  const s = shadow()
  try {
    const health = pathToFileURL(path.join(ROOT, 'lib', 'ai', 'health.ts')).href
    fs.writeFileSync(
      path.join(s.dir, 'canary.test.ts'),
      `import { test } from 'node:test'\ntest('System health, cwd not moved', async () => {\n  const { aiHealthWarnings } = await import(${JSON.stringify(health)})\n  aiHealthWarnings()\n})\n`,
    )
    assert.ok(await runIn(s, ['canary.test.ts']), 'the canary run finished')
    const left = leftovers(s)
    assert.ok(left.includes('auth.db') && left.includes('ai.db'), `the canary's stores are seen: ${left.join(', ')}`)
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})

test('every test file that can reach a store without moving its cwd leaves data/ as it found it', async () => {
  const files = unisolatedTests()
  assert.ok(files.length > 0, 'the selection found the files to check')
  const s = shadow()
  try {
    assert.ok(await runIn(s, files), `the run of ${files.length} files finished within ${RUN_LIMIT_MS / 1000} s`)
    const left = leftovers(s)
    if (!left.length) return
    const culprits: string[] = []
    for (const f of files) {
      const one = shadow()
      try {
        await runIn(one, [f])
        const own = leftovers(one)
        if (own.length) culprits.push(`  ${f}: ${own.join(', ')}`)
      } finally {
        fs.rmSync(one.dir, { recursive: true, force: true })
      }
    }
    assert.fail(
      [
        `A unit run wrote to the checkout's data/ (${left.join(', ')}).`,
        'Move into a temp dir before the first lib import (see tests/ai-providers-anthropic.test.ts), or use editorialHarness:',
        ...culprits,
      ].join('\n'),
    )
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true })
  }
})
