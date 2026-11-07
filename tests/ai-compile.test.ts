/**
 * M2 — compileForAi, the MDX check of every AI write, in its worker
 * (design §4.5, §12.1; THREATS on compile cost):
 *
 *   - the corpus of the design's measurements (hostile structure and real
 *     prose at the sizes a write allows) answers a pass or MDX_TOO_COMPLEX
 *     within the wall clock, and real prose passes;
 *   - the site keeps answering: a 200 ms timer keeps firing while a hostile
 *     body is checked;
 *   - a timeout and an out-of-memory worker both recover on the next call;
 *   - the check makes no request, reads no site file and opens no database;
 *   - a worker that cannot start, start in time or take another job answers
 *     CHECK_UNAVAILABLE — never a main-thread fallback — and an AI write
 *     then writes nothing.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller } from './helpers/aiTools'

const h = editorialHarness('ai-compile', 'ai-compile-secret-0123456789abcdef0123456789')
let compile: typeof import('../lib/ai/compile')

before(async () => {
  await h.setup()
  compile = await import('../lib/ai/compile')
})
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

const KB = 1024
const repeat = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)))

/** A realistic Chinese article: headings, paragraphs, a list, a link and a code block, repeated. */
function chinesePost(bytes: number): string {
  const section = [
    '## 边缘设备上的模型压缩',
    '',
    '在资源受限的设备上部署神经网络时，内存和功耗往往比准确率更早成为瓶颈。我们先测量了基线模型在目标芯片上的延迟，然后逐步尝试剪枝、量化和知识蒸馏。',
    '',
    '- 剪枝去掉了约三成的通道，延迟下降明显；',
    '- 八位量化几乎没有损失准确率；',
    '- 蒸馏让小模型学到了大模型的判断方式。',
    '',
    '更多细节见[项目页面](/work/example-project)。',
    '',
    '```ts',
    'const latency = measure(model, { runs: 100 })',
    '```',
    '',
  ].join('\n')
  return repeat(section, bytes)
}

/** The corpus of the design's measurements (§ top table): hostile structure and real prose. */
const CORPUS: Array<{ name: string; body: string; mustPass?: true }> = [
  { name: '[a]( × 64 KB', body: repeat('[a](', 64 * KB) },
  { name: '[a]( × 256 KB', body: repeat('[a](', 256 * KB) },
  { name: 'wide table 128 KB', body: `|${repeat('a|', 64 * KB)}\n|${repeat('-|', 64 * KB)}\n` },
  { name: 'table rows 128 KB', body: `|a|b|\n|-|-|\n${repeat('|x|y|\n', 128 * KB)}` },
  { name: 'headings 192 KB', body: repeat('## A heading\n\n', 192 * KB) },
  { name: 'TypeScript fence 128 KB', body: `\`\`\`ts\n${repeat('const value: number = compute(input, { depth: 3 })\n', 128 * KB)}\`\`\`\n` },
  { name: 'Chinese article 118 KB', body: chinesePost(118 * KB), mustPass: true },
]

test('the limits are the design’s: 3 s per job, 5 s to boot, 60 s idle, 256 MB of heap', () => {
  assert.deepEqual({ ...compile.COMPILE_LIMITS }, { wallMs: 3000, bootMs: 5000, idleMs: 60_000, heapMb: 256, queueMax: 16 })
})

test('the corpus: each body passes or answers MDX_TOO_COMPLEX within the wall clock, real prose passes, and a 200 ms timer keeps firing', async () => {
  const c = compile.createAiCompiler()
  try {
    // Warm the worker, so the boot is not counted against a body.
    assert.equal((await c.compile({ body: 'Warm up.' })).ok, true)
    for (const item of CORPUS) {
      const ticks: number[] = []
      const timer = setInterval(() => ticks.push(Date.now()), 200)
      const started = Date.now()
      const v = await c.compile({ body: item.body })
      const ms = Date.now() - started
      clearInterval(timer)
      assert.ok(v.ok || v.code === 'MDX_TOO_COMPLEX', `${item.name}: ${JSON.stringify(v).slice(0, 200)}`)
      if (item.mustPass) assert.equal(v.ok, true, `${item.name} is real prose and must pass`)
      // The wall clock, plus a new worker's boot after a terminated one (the next body pays it).
      assert.ok(ms < compile.COMPILE_LIMITS.wallMs + compile.COMPILE_LIMITS.bootMs, `${item.name}: ${ms} ms`)
      // The main thread was never held: the gaps between ticks stay near 200 ms.
      const gaps = ticks.slice(1).map((t, i) => t - ticks[i])
      if (ms > 1000) assert.ok(ticks.length >= Math.floor(ms / 200) - 3, `${item.name}: ${ticks.length} ticks in ${ms} ms`)
      assert.ok(gaps.every((g) => g < 1000), `${item.name}: the main loop stalled (${Math.max(...gaps)} ms)`)
    }
  } finally {
    await c.close()
  }
})

test('a timeout and an out-of-memory worker both answer MDX_TOO_COMPLEX, and the next call starts a new worker that answers', async () => {
  const c = compile.createAiCompiler({ limits: { wallMs: 1500 } })
  try {
    assert.equal((await c.compile({ body: 'First.' })).ok, true)
    const startsBefore = c.stats().starts
    const slow = await c.compile({ body: repeat('[a](', 256 * KB) })
    assert.deepEqual(slow, { ok: false, code: 'MDX_TOO_COMPLEX' })
    const after = await c.compile({ body: '## After a timeout\n\nFine.' })
    assert.equal(after.ok, true)
    assert.equal(c.stats().starts, startsBefore + 1, 'the terminated worker was replaced')

    const oom = await c.compile({ body: `|a|b|\n|-|-|\n${repeat('|x|y|\n', 256 * KB)}` })
    assert.deepEqual(oom, { ok: false, code: 'MDX_TOO_COMPLEX' })
    const again = await c.compile({ body: 'Fine again.' })
    assert.equal(again.ok, true)
    assert.equal(c.stats().starts, startsBefore + 2, 'the worker that ran out of heap was replaced')
  } finally {
    await c.close()
  }
})

test('an invalid body answers MDX_INVALID with its position; references are read the way the renderer reads them', async () => {
  const c = compile.createAiCompiler()
  try {
    const bad = await c.compile({ body: 'Fine line.\n\n<Callout>\nnever closed' })
    assert.equal(bad.ok, false)
    assert.ok(!bad.ok && bad.code === 'MDX_INVALID' && bad.line !== null && bad.reason.length > 0, JSON.stringify(bad))
    const refs = await c.compile({
      body: [
        '![inline](/uploads/a.webp) ![ref][pic]',
        '',
        '[pic]: /uploads/b.webp',
        '[link][site] and https://example.com/auto and [inline](https://example.org/x)',
        '',
        '[site]: https://example.net/ref',
        '',
        '<Figure src="/uploads/c.webp" alt="c" />',
        '<video src="/uploads/v.mp4" poster="/uploads/p.webp"></video>',
        '<img srcSet="/uploads/s1.webp 1x, /uploads/s2.webp 2x" />',
        '<YouTube id="dQw4w9WgXcQ" title="t" />',
        '<iframe src="https://player.vimeo.com/video/123"></iframe>',
      ].join('\n'),
      before: '![old](https://old.example/x.png)',
    })
    assert.ok(refs.ok, JSON.stringify(refs))
    if (!refs.ok) return
    assert.deepEqual(refs.refs.images, ['/uploads/a.webp', '/uploads/b.webp', '/uploads/c.webp', '/uploads/v.mp4', '/uploads/p.webp', '/uploads/s1.webp', '/uploads/s2.webp'])
    assert.deepEqual(refs.refs.links, ['https://example.net/ref', 'https://example.com/auto', 'https://example.org/x'])
    assert.deepEqual(refs.refs.embeds, ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://player.vimeo.com/video/123'])
    assert.deepEqual(refs.beforeRefs.images, ['https://old.example/x.png'])
  } finally {
    await c.close()
  }
})

const UPLOAD_BODY = [
  '## Pictures',
  '',
  '![A field](/uploads/field.webp)',
  '',
  '<Figure src="/uploads/figure.webp" alt="A figure" caption="Caption" />',
  '',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  '',
  '<video src="/uploads/clip.mp4" poster="/uploads/poster.webp"></video>',
].join('\n')

test('the check opens no database, reads no site file and makes no request (in-process spies on the job the worker runs)', async () => {
  const { runCompileJob } = await import('../lib/ai/compileJob')
  const Database = (await import('better-sqlite3')).default as unknown as { prototype: Record<string, (...a: unknown[]) => unknown> }
  const touched: string[] = []
  const restore: Array<() => void> = []
  const spy = (obj: Record<string, any>, key: string, label: string) => {
    const original = obj[key]
    obj[key] = function (this: unknown, ...a: unknown[]) {
      touched.push(`${label}(${String(a[0]).slice(0, 80)})`)
      return original.apply(this, a)
    }
    restore.push(() => (obj[key] = original))
  }
  for (const k of ['readFileSync', 'readFile', 'statSync', 'stat', 'existsSync', 'openSync', 'open', 'readdirSync', 'createReadStream']) spy(fs as any, k, `fs.${k}`)
  for (const k of ['readFile', 'stat', 'open', 'readdir']) spy(fs.promises as any, k, `fs.promises.${k}`)
  spy(Database.prototype, 'prepare', 'db.prepare')
  spy(Database.prototype, 'exec', 'db.exec')
  spy(http as any, 'request', 'http.request')
  spy(http as any, 'get', 'http.get')
  spy(https as any, 'request', 'https.request')
  spy(https as any, 'get', 'https.get')
  spy(globalThis as any, 'fetch', 'fetch')
  // Named imports of the built-ins (`import { readFileSync } from 'fs'`) see the spies too.
  syncBuiltinESMExports()
  try {
    const answer = await runCompileJob({ id: 1, body: UPLOAD_BODY, before: '![x](https://old.example/x.png)', lang: null })
    assert.equal(answer.ok, true, JSON.stringify(answer))
  } finally {
    for (const r of restore.reverse()) r()
    syncBuiltinESMExports()
  }
  assert.deepEqual(touched, [])
})

test('in a real worker: a remote image and a link reach no server, and nothing appears in the working directory', async () => {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits++
    res.end('x')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const original = process.cwd()
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-compile-cwd-'))
  fs.mkdirSync(path.join(empty, 'tests'))
  fs.symlinkSync(path.join(original, 'tests', 'register.mjs'), path.join(empty, 'tests', 'register.mjs'))
  const c = compile.createAiCompiler()
  try {
    process.chdir(empty)
    const v = await c.compile({ body: `${UPLOAD_BODY}\n\n![remote](http://127.0.0.1:${port}/img.png)\n\n[link](http://127.0.0.1:${port}/page)\n` })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.deepEqual(fs.readdirSync(empty), ['tests'], 'no data/ directory, no database, no file')
  } finally {
    process.chdir(original)
    await c.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(empty, { recursive: true, force: true })
  }
  assert.equal(hits, 0)
})

test('a worker that cannot start, cannot start in time or has a full queue answers CHECK_UNAVAILABLE', async () => {
  const throwing = compile.createAiCompiler({
    spawn: () => {
      throw new Error('spawn refused')
    },
  })
  assert.deepEqual(await throwing.compile({ body: 'x' }), { ok: false, code: 'CHECK_UNAVAILABLE' })

  const crashing = compile.createAiCompiler({ spawn: () => new Worker('throw new Error("cannot load")', { eval: true }) })
  assert.deepEqual(await crashing.compile({ body: 'x' }), { ok: false, code: 'CHECK_UNAVAILABLE' })

  const silent = compile.createAiCompiler({ spawn: () => new Worker('setInterval(() => {}, 1000)', { eval: true }), limits: { bootMs: 300 } })
  const t0 = Date.now()
  assert.deepEqual(await silent.compile({ body: 'x' }), { ok: false, code: 'CHECK_UNAVAILABLE' })
  assert.ok(Date.now() - t0 < 2000, 'the boot limit holds')
  assert.equal(silent.stats().running, false, 'the silent worker was terminated')

  const busy = compile.createAiCompiler({ limits: { queueMax: 1, wallMs: 800 } })
  try {
    const first = busy.compile({ body: repeat('[a](', 256 * KB) })
    const second = busy.compile({ body: 'queued' })
    assert.deepEqual(await busy.compile({ body: 'one too many' }), { ok: false, code: 'CHECK_UNAVAILABLE' })
    assert.deepEqual(await first, { ok: false, code: 'MDX_TOO_COMPLEX' })
    assert.equal((await second).ok, true)
  } finally {
    await busy.close()
  }
})

test('an idle worker is terminated, and the next job starts a new one', async () => {
  const c = compile.createAiCompiler({ limits: { idleMs: 150 } })
  try {
    assert.equal((await c.compile({ body: 'x' })).ok, true)
    assert.equal(c.stats().running, true)
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(c.stats().running, false, 'terminated after being idle')
    assert.equal((await c.compile({ body: 'y' })).ok, true)
    assert.equal(c.stats().starts, 2)
  } finally {
    await c.close()
  }
})

test('when the check is unavailable, an AI write answers CHECK_UNAVAILABLE and writes nothing', async () => {
  const g = globalThis as typeof globalThis & { __aiCompiler?: import('../lib/ai/compile').AiCompiler }
  const previous = g.__aiCompiler
  g.__aiCompiler = compile.createAiCompiler({
    spawn: () => {
      throw new Error('no worker here')
    },
  })
  try {
    const tools = await aiToolCaller()
    const out = await tools.call('create_draft', { collection: 'blog', slug: 'never-written', frontmatter: { title: 'Never', date: '2026-05-01' }, body: 'Text.' }, 'draft')
    assert.equal(out.code, 'CHECK_UNAVAILABLE', out.text)
    const { readOne } = await import('../lib/mdx-admin')
    assert.equal(readOne('blog', 'never-written'), null)
    const { getAiDb } = await import('../lib/ai/db')
    assert.equal((getAiDb().prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n, 0)
    const { getAuditDb } = await import('../lib/audit/db')
    assert.equal((getAuditDb().prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n, 0)
  } finally {
    await g.__aiCompiler?.close()
    g.__aiCompiler = previous
  }
})
