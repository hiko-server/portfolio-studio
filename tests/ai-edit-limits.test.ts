/**
 * M2 — the caps of AI edits (design §4.5, §12.1): one small call must never
 * be able to end the process. Doubling edits, a large replacement over many
 * matches, more than 1,000 matches, more than 50 edits, oversized find,
 * replace and body: each refused with its code before the oversized string
 * exists (memory grows by less than 10 MB), and nothing is written. The
 * size arithmetic is exact in UTF-8 bytes, Chinese included.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'

const h = editorialHarness('ai-edit-limits', 'ai-edit-limits-secret-0123456789abcdef0123456789')
let edits: typeof import('../lib/ai/edits')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
const KIB = 1024

before(async () => {
  await h.setup()
  edits = await import('../lib/ai/edits')
  const w = await storeWriters()
  await w.item('blog', 'small', { title: 'Small', date: '2026-05-01' }, 'a'.repeat(100))
  await w.item('blog', 'many-x', { title: 'Many x', date: '2026-05-01' }, 'x '.repeat(500))
  await w.item('blog', 'many-y', { title: 'Many y', date: '2026-05-01' }, 'y '.repeat(1001))
  tools = await aiToolCaller()
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

/** Heap and RSS growth of `fn`, in MB, after a collection when the runner exposes one. */
async function growth(fn: () => Promise<unknown> | unknown): Promise<number> {
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  const before = process.memoryUsage()
  await fn()
  gc?.()
  const after = process.memoryUsage()
  return Math.max(after.rss - before.rss, after.heapUsed - before.heapUsed) / (1024 * 1024)
}

test('applyEdits: each edit must match, once unless all; edits apply in order; nothing is applied on a refusal', () => {
  assert.deepEqual(edits.applyEdits('one two', [{ find: 'three', replace: 'x' }]), { ok: false, code: 'EDIT_NOT_FOUND', index: 0, find: 'three' })
  assert.deepEqual(edits.applyEdits('a b a', [{ find: 'a', replace: 'c' }]), { ok: false, code: 'EDIT_AMBIGUOUS', index: 0, find: 'a', matches: 2 })
  assert.deepEqual(edits.applyEdits('a b a', [{ find: 'a', replace: 'c', all: true }]), { ok: true, body: 'c b c', matches: 2 })
  assert.deepEqual(edits.applyEdits('one two', [{ find: 'one', replace: 'three' }, { find: 'three two', replace: 'done' }]), { ok: true, body: 'done', matches: 2 })
  assert.deepEqual(edits.applyEdits('aaaa', [{ find: 'aa', replace: 'b', all: true }]), { ok: true, body: 'bb', matches: 2 }, 'matches do not overlap')
  assert.equal(edits.applyEdits('x', [{ find: '\ud83d', replace: 'y' }]).ok, false, 'a lone surrogate is refused')
  assert.equal(edits.applyEdits('😀', [{ find: 'x', replace: '\ude00' }]).ok, false)
})

test('applyEdits: 40 doubling edits stop at the projected size, before the string exists; memory stays flat', async () => {
  const list = Array.from({ length: 40 }, () => ({ find: 'a', replace: 'aa', all: true }))
  let out: ReturnType<typeof edits.applyEdits> | null = null
  const mb = await growth(() => (out = edits.applyEdits('a'.repeat(100), list)))
  // 100, 200, 400 and 800 matches double the body; the fifth edit would have 1600: refused by the match count.
  assert.deepEqual(out, { ok: false, code: 'EDIT_TOO_LARGE', index: 4, reason: 'matches' })
  let sized: ReturnType<typeof edits.applyEdits> | null = null
  const mb2 = await growth(() => (sized = edits.applyEdits('a'.repeat(64 * KIB), Array.from({ length: 40 }, () => ({ find: 'a'.repeat(1024), replace: 'a'.repeat(2048), all: true })))))
  // 64 KiB, 128 KiB, 256 KiB (exactly the limit), then 512 KiB: refused by the projected size.
  assert.deepEqual(sized, { ok: false, code: 'EDIT_TOO_LARGE', index: 2, reason: 'size' })
  assert.ok(mb < 10 && mb2 < 10, `${mb.toFixed(1)} MB, ${mb2.toFixed(1)} MB`)
})

test('applyEdits: a 64 KiB replacement over 500 matches is refused by arithmetic (32 MB never built)', async () => {
  let out: ReturnType<typeof edits.applyEdits> | null = null
  const mb = await growth(() => (out = edits.applyEdits('x '.repeat(500), [{ find: 'x', replace: 'z'.repeat(64 * KIB - 1), all: true }])))
  assert.deepEqual(out, { ok: false, code: 'EDIT_TOO_LARGE', index: 0, reason: 'size' })
  assert.ok(mb < 10, `${mb.toFixed(1)} MB`)
})

test('applyEdits: exactly 1,000 matches pass, 1,001 are refused', () => {
  assert.equal(edits.applyEdits('y '.repeat(1000), [{ find: 'y', replace: 'z', all: true }]).ok, true)
  assert.deepEqual(edits.applyEdits('y '.repeat(1001), [{ find: 'y', replace: 'z', all: true }]), { ok: false, code: 'EDIT_TOO_LARGE', index: 0, reason: 'matches' })
})

test('applyEdits: the size limit is exact in UTF-8 bytes, Chinese included', () => {
  const limit = edits.EDIT_LIMITS.bodyBytes
  // 1000 Chinese characters (3 bytes each) and one "b", filled with ASCII to 3 bytes under the limit.
  const head = '中'.repeat(1000) + 'b'
  const body = head + 'a'.repeat(limit - 3 - Buffer.byteLength(head))
  assert.equal(Buffer.byteLength(body), limit - 3)
  const fits = edits.applyEdits(body, [{ find: 'b', replace: '中' }])
  assert.ok(fits.ok && Buffer.byteLength(fits.body) === limit - 1, '+2 bytes fits')
  assert.deepEqual(edits.applyEdits(body, [{ find: 'b', replace: '中中' }]), { ok: false, code: 'EDIT_TOO_LARGE', index: 0, reason: 'size' }, '+5 bytes does not')
  assert.deepEqual(edits.applyEdits(body, [{ find: '中', replace: '中中', all: true }]), { ok: false, code: 'EDIT_TOO_LARGE', index: 0, reason: 'size' }, '+3000 bytes does not')
})

const version = async (slug: string) => (await tools.data('get_content', { collection: 'blog', ref: slug }, 'draft')).version as string

test('through edit_content: 40 doubling edits, a large replacement, 1,001 matches: refused, nothing written, memory flat', async () => {
  const { readOne } = await import('../lib/mdx-admin')
  const small = readOne('blog', 'small')
  let codes: Array<string | null> = []
  const mb = await growth(async () => {
    const doubling = await tools.call('edit_content', { collection: 'blog', slug: 'small', edits: Array.from({ length: 40 }, () => ({ find: 'a', replace: 'aa', all: true })), base_version: await version('small') }, 'draft')
    tools.nextMinute()
    const large = await tools.call('edit_content', { collection: 'blog', slug: 'many-x', edits: [{ find: 'x', replace: 'z'.repeat(64 * KIB - 1), all: true }], base_version: await version('many-x') }, 'draft')
    tools.nextMinute()
    const many = await tools.call('edit_content', { collection: 'blog', slug: 'many-y', edits: [{ find: 'y', replace: 'z', all: true }], base_version: await version('many-y') }, 'draft')
    codes = [doubling.code, large.code, many.code]
  })
  assert.deepEqual(codes, ['EDIT_TOO_LARGE', 'EDIT_TOO_LARGE', 'EDIT_TOO_LARGE'])
  assert.ok(mb < 10, `${mb.toFixed(1)} MB`)
  assert.deepEqual(readOne('blog', 'small'), small, 'nothing written')
  const { getAiDb } = await import('../lib/ai/db')
  assert.equal((getAiDb().prepare('SELECT count(*) AS n FROM ai_changes').get() as { n: number }).n, 0)
})

test('through the tools: 51 edits, a find over 16 KiB, a replace over 64 KiB, a body over 256 KiB are INVALID_INPUT naming the field', async () => {
  const base = await version('small')
  const fifty1 = await tools.call('edit_content', { collection: 'blog', slug: 'small', edits: Array.from({ length: 51 }, (_, i) => ({ find: `f${i}`, replace: 'r' })), base_version: base }, 'draft')
  assert.deepEqual([fifty1.code, fifty1.json.error.field], ['INVALID_INPUT', 'edits'])
  const find = await tools.call('edit_content', { collection: 'blog', slug: 'small', edits: [{ find: 'a'.repeat(16 * KIB + 1), replace: 'r' }], base_version: base }, 'draft')
  assert.deepEqual([find.code, find.json.error.field], ['INVALID_INPUT', 'edits[0].find'])
  const findCjk = await tools.call('edit_content', { collection: 'blog', slug: 'small', edits: [{ find: '中'.repeat(5462), replace: 'r' }], base_version: base }, 'draft')
  assert.equal(findCjk.code, 'INVALID_INPUT', 'the cap counts bytes: 5462 Chinese characters are 16386 bytes')
  const replace = await tools.call('edit_content', { collection: 'blog', slug: 'small', edits: [{ find: 'a', replace: 'r'.repeat(64 * KIB + 1) }], base_version: base }, 'draft')
  assert.deepEqual([replace.code, replace.json.error.field], ['INVALID_INPUT', 'edits[0].replace'])
  tools.nextMinute()
  const body = await tools.call('edit_content', { collection: 'blog', slug: 'small', body: 'b'.repeat(256 * KIB + 1), base_version: base }, 'draft')
  assert.deepEqual([body.code, body.json.error.field], ['INVALID_INPUT', 'body'])
  const created = await tools.call('create_draft', { collection: 'blog', slug: 'too-big', frontmatter: { title: 'Too big', date: '2026-05-01' }, body: '中'.repeat(87382) }, 'draft')
  assert.deepEqual([created.code, created.json.error.field], ['INVALID_INPUT', 'body'])
  const both = await tools.call('edit_content', { collection: 'blog', slug: 'small', body: 'x', edits: [{ find: 'a', replace: 'b' }], base_version: base }, 'draft')
  assert.equal(both.code, 'INVALID_INPUT')
  const nothing = await tools.call('edit_content', { collection: 'blog', slug: 'small', base_version: base }, 'draft')
  assert.equal(nothing.code, 'INVALID_INPUT')
})
