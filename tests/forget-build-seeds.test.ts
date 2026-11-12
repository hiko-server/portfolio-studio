/**
 * The image holds no build-time copy of an ISR page (scripts/forget-build-seeds.mjs):
 * `next build` renders them from the git seeds, a fictional demo person, and
 * Next 16.4 answered the first request after a start with that copy (seen live
 * on 2026-11-12). Static pages keep theirs; deploy.sh refuses a live page that
 * still carries the build-render marker.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { forgetBuildSeeds, seedBase } from '../scripts/forget-build-seeds.mjs'
import { BUILD_RENDER_META, isBuildPhase } from '../lib/isr'

test('seed names: / is index, the rest drop the leading slash', () => {
  assert.equal(seedBase('/'), 'index')
  assert.equal(seedBase('/cv/zh'), 'cv/zh')
  assert.equal(seedBase('/blog/hello'), 'blog/hello')
})

test('the build copies of ISR routes go; static pages and the server code stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-seeds-'))
  try {
    const pages = path.join(dir, 'server', 'pages')
    fs.mkdirSync(path.join(pages, 'cv'), { recursive: true })
    fs.mkdirSync(path.join(pages, 'blog'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'prerender-manifest.json'),
      JSON.stringify({
        routes: {
          '/': { initialRevalidateSeconds: 1 },
          '/cv/zh': { initialRevalidateSeconds: 1 },
          '/blog/hello': { initialRevalidateSeconds: 60 },
          '/colophon': { initialRevalidateSeconds: false },
          '/../escape': { initialRevalidateSeconds: 1 },
        },
      }),
    )
    const files = ['index', 'cv/zh', 'blog/hello', 'colophon', '404'].flatMap((b) => ['.html', '.json', '.meta'].map((e) => `${b}${e}`))
    for (const f of [...files, 'index.js', 'cv/zh.js']) fs.writeFileSync(path.join(pages, f), 'x')
    fs.writeFileSync(path.join(dir, 'server', 'escape.html'), 'outside pages/')
    const removed = forgetBuildSeeds(dir).sort()
    assert.deepEqual(
      removed,
      ['blog/hello', 'cv/zh', 'index'].flatMap((b) => ['.html', '.json', '.meta'].map((e) => path.join('server', 'pages', `${b}${e}`))).sort(),
    )
    for (const keep of ['colophon.html', '404.html', 'index.js', 'cv/zh.js']) assert.ok(fs.existsSync(path.join(pages, keep)), keep)
    assert.ok(fs.existsSync(path.join(dir, 'server', 'escape.html')), 'nothing outside server/pages is touched')
    // Running again finds nothing left (missing files are fine).
    assert.deepEqual(forgetBuildSeeds(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the image build removes them and checks the home page copy is gone', () => {
  const docker = fs.readFileSync('Dockerfile', 'utf8')
  assert.match(docker, /node scripts\/forget-build-seeds\.mjs \.next\/standalone\/\.next/)
  assert.match(docker, /test ! -e \.next\/standalone\/\.next\/server\/pages\/index\.html/)
})

test('a build-time render is marked, a server render is not, and deploy.sh refuses the mark on live pages', () => {
  assert.equal(isBuildPhase({ NEXT_PHASE: 'phase-production-build' }), true)
  assert.equal(isBuildPhase({ NEXT_PHASE: 'phase-production-server' }), false)
  const doc = fs.readFileSync('pages/_document.tsx', 'utf8')
  assert.match(doc, /isBuildPhase\(\) \? <meta name=\{BUILD_RENDER_META\.name\} content=\{BUILD_RENDER_META\.content\} \/> : null/)
  const deploy = fs.readFileSync('scripts/deploy.sh', 'utf8')
  assert.ok(deploy.includes(`grep -q 'name="${BUILD_RENDER_META.name}" content="${BUILD_RENDER_META.content}"'`), 'deploy.sh greps the same marker')
  assert.match(deploy, /smoke_failed="\$smoke_failed \$path\(build-time copy\)"/)
})
