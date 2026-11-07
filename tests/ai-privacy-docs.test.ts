/**
 * M7 — the public AI disclosure stays word for word what design §10 says, in
 * both languages, and the tests it rests on exist (design §10, §12.1: "the
 * colophon's claim names its tests").
 *
 *   - /colophon → Privacy & analytics carries the §10.1 paragraph;
 *   - README.zh.md carries the §10.2 paragraph, README.md the English claim;
 *   - "Nothing they write goes public until I approve it" is held by
 *     ai-boundary, ai-held-edits, ai-create-draft-public and ai-editor-bridge;
 *     "no access to contact messages, visitor analytics or error reports" by
 *     ai-boundary and ai-tools-leak — each must exist and hold tests;
 *   - SECURITY.md has its "AI access" posture, CONTRIBUTING.md the boundary
 *     rule for lib/ai/tools, CHANGELOG.md an [Unreleased] entry.
 *
 * Rewording the disclosure is allowed only together with this test, and a
 * reversal (exposing visitor data) needs the whole §10 procedure first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

const EN =
  'I sometimes use AI assistants to help edit this site. They can read what is published and, when I allow it, my own drafts, and they can write drafts. Nothing they write goes public until I approve it. What they read is sent to the AI provider I chose for that task, under that provider’s terms. They have no access to contact messages, visitor analytics or error reports: the code gives them no way to read them, and a test fails if that changes.'

const ZH =
  '我有时会用 AI 助手协助编辑本站。它们可以读取已发布的内容，在我允许时也可以读取我自己的草稿，并且可以撰写草稿。它们写的内容在我批准之前不会公开。它们读取的内容会发送给我为该任务选择的 AI 服务商，并适用该服务商的条款。**它们无法访问联系留言、访客统计或错误报告：** 代码没有提供任何读取途径，一旦有变动，测试就会失败。'

/** The text of the colophon's paragraph that starts with `start`, as a reader sees it. */
function colophonParagraph(start: string): string {
  const src = read('pages/colophon.tsx')
  const paras = src.split('<Para>').slice(1).map((chunk) => chunk.split('</Para>')[0])
  const para = paras.find((p) => squash(p).startsWith(start))
  assert.ok(para, `a <Para> on /colophon starting “${start}”`)
  return squash(
    para
      .replace(/\{' '\}/g, ' ')
      .replace(/<\/?strong>/g, '')
      .replace(/&rsquo;/g, '’'),
  ).replace(/ ([:.,])/g, '$1')
}

test('/colophon → Privacy & analytics says what design §10.1 says, after the contact bullets, with the claim in bold', () => {
  assert.equal(colophonParagraph('I sometimes use AI assistants'), EN)
  const src = read('pages/colophon.tsx')
  const privacy = src.indexOf('<Section id="privacy"')
  const contact = src.indexOf('Messages sent through the')
  const ai = src.indexOf('I sometimes use AI assistants')
  const build = src.indexOf('<Section id="build"')
  assert.ok(privacy > 0 && privacy < contact && contact < ai && ai < build, 'inside Privacy & analytics, after the contact form part')
  assert.match(src, /<strong>\s*They have no access to contact messages, visitor analytics or error reports:\s*<\/strong>/)
})

test('README.zh.md carries the §10.2 paragraph word for word; README.md states the same boundary with its tests', () => {
  assert.ok(read('README.zh.md').includes(ZH), 'README.zh.md: §10.2')
  const readme = squash(read('README.md'))
  assert.match(readme, /AI assistants never see any of it/)
  assert.match(readme, /No tool reads contact messages, analytics or error reports: `tests\/ai-boundary\.test\.ts` fails/)
  assert.match(readme, /## AI: an MCP server and your own model/)
})

test('the tests the disclosure names exist and hold tests', () => {
  const named = ['ai-boundary', 'ai-held-edits', 'ai-create-draft-public', 'ai-editor-bridge', 'ai-tools-leak']
  for (const name of named) {
    const rel = `tests/${name}.test.ts`
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel)
    const tests = read(rel).match(/^test\(/gm) ?? []
    assert.ok(tests.length >= 2, `${rel} holds tests (${tests.length})`)
  }
  // The boundary test is what "a test fails if that changes" means: it must still guard the visitor-data stores.
  const forbidden = /const forbidden = \/\^lib\\\/\(([^)]*)\)\//.exec(read('tests/ai-boundary.test.ts'))
  assert.ok(forbidden, 'ai-boundary keeps its forbidden list')
  const guarded = forbidden[1].split('|').map((s) => s.replace(/\\\//g, '/'))
  for (const store of ['inbox', 'analytics/', 'errors/']) assert.ok(guarded.includes(store), `ai-boundary guards lib/${store}`)
})

test('SECURITY.md, CONTRIBUTING.md and CHANGELOG.md say what §10.3 asks of them', () => {
  const security = read('SECURITY.md')
  assert.match(security, /^### AI access$/m)
  const ai = squash(security.slice(security.indexOf('### AI access')))
  for (const point of [
    /Default off, three switches/,
    /The approval path and preview binding/,
    /Held items/,
    /stored as SHA-256 only/,
    /The honest limit:/,
    /Pairing/,
    /Sign out everywhere ends AI access/,
    /Refresh tokens at a hosted vendor/,
  ]) {
    assert.match(ai, point)
  }
  assert.match(squash(security), /The public AI addresses are \*\*deliberately outside\*\* this guard/)
  assert.match(read('CONTRIBUTING.md'), /## The AI boundary \(read this before touching `lib\/ai\/tools\/\*\*`\)/)
  const changelog = read('CHANGELOG.md')
  const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 1))
  assert.match(unreleased, /### Added[\s\S]*AI that helps edit the site, off until you turn it on/)
  assert.match(unreleased, /### Fixed/)
})
