/**
 * Two details of the home page's lists, in server markup from synthetic
 * props:
 *
 *  - a repository card (components/GitHub/TopRepos) prints its description
 *    as plain text — Markdown written in a GitHub description used to show
 *    its asterisks — and shows a star or fork count only once there is one;
 *  - a row of "Writing & case studies" (components/LandingPage/LatestWriting)
 *    names the language of a piece written in another language than the
 *    page's (a Chinese-only post on the English home).
 *
 * The components are .tsx: a test-local loader transpiles them with the
 * project's TypeScript (as tests/github-orgs-render.test.ts does).
 */
import { register } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { readFileSync } from 'node:fs'
      import { fileURLToPath } from 'node:url'
      import { createRequire } from 'node:module'
      const require = createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)})
      const ts = require('typescript')
      export async function resolve(specifier, context, next) {
        // next/<entry> are CommonJS files without an exports map: add the extension.
        if (/^next\\/[a-z-]+$/.test(specifier)) return next(specifier + '.js', context)
        return next(specifier, context)
      }
      export async function load(url, context, next) {
        if (url.startsWith('file:') && url.endsWith('.tsx') && !url.includes('/node_modules/')) {
          const source = readFileSync(fileURLToPath(url), 'utf8')
          const out = ts.transpileModule(source, {
            fileName: fileURLToPath(url),
            compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
          })
          return { format: 'module', source: out.outputText, shortCircuit: true }
        }
        return next(url, context)
      }
    `),
  import.meta.url,
)

/** Static markup without Emotion's inline <style> tags. */
const html = (el: unknown) =>
  renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')

/** Text of a piece of markup (tags dropped). */
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, '')

/** A home section inside the home page's words (components/LandingPage/homeUi). */
async function inHome(el: unknown, lang: 'en' | 'zh-Hans' = 'en') {
  const [{ HomeUiContext, EN_HOME_LINKS }, { HOME_UI }] = await Promise.all([import('../components/LandingPage/homeUi'), import('../lib/uiStrings/home')])
  const value = { t: HOME_UI[lang], lang, cvLang: lang === 'en' ? 'en' : 'zh', links: lang === 'en' ? EN_HOME_LINKS : { ...EN_HOME_LINKS, blog: '/zh/blog', work: '/zh/work' } }
  return createElement(HomeUiContext.Provider, { value: value as never }, el as never)
}

// ── Repository cards ─────────────────────────────────────────────────────────

test('plainRepoText drops Markdown markers and keeps names that only look like them', async () => {
  const { plainRepoText } = await import('../components/Common/githubEvents')
  assert.equal(
    plainRepoText('An SSH terminal for servers published through **Cloudflare Tunnel** and protected by **Cloudflare Access**.'),
    'An SSH terminal for servers published through Cloudflare Tunnel and protected by Cloudflare Access.',
  )
  assert.equal(plainRepoText('**Bold** start, *italic* word, `code` span.'), 'Bold start, italic word, code span.')
  assert.equal(plainRepoText('See [the docs](https://example.com/docs "Docs") ![badge](https://example.com/b.svg) now'), 'See the docs now')
  assert.equal(plainRepoText('中文**加粗**描述'), '中文加粗描述')
  // Underscores, an asterisk inside a word or between spaces: names and arithmetic, left as written.
  assert.equal(plainRepoText('Fix __init__.py and my_var_ok'), 'Fix __init__.py and my_var_ok')
  assert.equal(plainRepoText('2*3*4 and 5 * 3 = 15'), '2*3*4 and 5 * 3 = 15')
  assert.equal(plainRepoText('  two\n\nlines  '), 'two lines')
  assert.equal(plainRepoText(null), '')
  assert.equal(plainRepoText(undefined), '')
})

const repo = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `repo-${id}`,
  html_url: `https://github.com/example-person/repo-${id}`,
  description: null as string | null,
  stargazers_count: 0,
  forks_count: 0,
  language: 'TypeScript',
  pushed_at: '2026-10-01T00:00:00Z',
  ...over,
})

async function renderRepos(repos: ReturnType<typeof repo>[]) {
  const { default: TopRepos } = await import('../components/GitHub/TopRepos')
  const out = html(await inHome(createElement(TopRepos, { limit: 3, initialData: { available: true, asOf: Date.parse('2026-11-01T00:00:00Z'), repos } })))
  return out.split('<li').slice(1)
}

test('TopRepos: a Markdown description prints as plain text; an owner blurb too', async () => {
  const items = await renderRepos([
    repo(1, { description: 'Connects through **Cloudflare Tunnel** with a `pty`.' }),
    repo(2, { description: 'GitHub words', blurb: 'The owner’s **own** words' }),
  ])
  assert.equal(items.length, 2)
  assert.match(textOf(items[0]), /Connects through Cloudflare Tunnel with a pty\./)
  assert.doesNotMatch(items[0], /\*\*|`/)
  assert.match(textOf(items[1]), /The owner’s own words/)
  assert.doesNotMatch(textOf(items[1]), /GitHub words|\*\*/)
})

test('TopRepos: a description of nothing but markers falls back to the language and the last push', async () => {
  const [item] = await renderRepos([repo(1, { description: '![logo](https://example.com/logo.png)' })])
  assert.match(textOf(item), /TypeScript · updated/)
})

test('TopRepos: star and fork counts show only once there is one', async () => {
  const [none, stars, both] = await renderRepos([
    repo(1),
    repo(2, { stargazers_count: 4 }),
    repo(3, { stargazers_count: 12, forks_count: 3 }),
  ])
  // Zero stars, zero forks: no counters at all (the language stays).
  assert.doesNotMatch(none, /data-repo-count/)
  assert.doesNotMatch(none, /stars|forks/)
  assert.match(textOf(none), /TypeScript/)
  // Stars but no forks.
  assert.match(stars, /data-repo-count="stars"/)
  assert.doesNotMatch(stars, /data-repo-count="forks"/)
  assert.match(textOf(stars), /4\s*stars/)
  // Both.
  assert.match(textOf(both), /12\s*stars/)
  assert.match(textOf(both), /3\s*forks/)
})

// ── Writing & case studies ───────────────────────────────────────────────────

const piece = (slug: string, lang: string, kind: 'post' | 'work' = 'post') => ({
  kind,
  title: `Title ${slug}`,
  href: `/${kind === 'post' ? 'blog' : 'work'}/${slug}`,
  date: '2026-05-30',
  readingMinutes: 2,
  lang,
  description: `About ${slug}`,
})

async function renderWriting(items: ReturnType<typeof piece>[], lang: 'en' | 'zh-Hans') {
  const { default: LatestWriting } = await import('../components/LandingPage/LatestWriting')
  const out = html(await inHome(createElement(LatestWriting, { items, hasPosts: true, hasWork: true }), lang))
  return out.split('<li').slice(1)
}

test('LatestWriting: on the English home a Chinese piece names its language, in Chinese; English pieces name none', async () => {
  const [english, simplified, traditional, work] = await renderWriting(
    [piece('edge-ai', 'en'), piece('car-community', 'zh-Hans'), piece('notes', 'zh-Hant'), piece('sorter', 'en', 'work')],
    'en',
  )
  assert.doesNotMatch(english, /data-writing-lang/)
  assert.doesNotMatch(work, /data-writing-lang/)
  assert.match(simplified, /<span lang="zh-Hans" data-writing-lang="zh-Hans">简体中文<\/span>/)
  assert.match(traditional, /<span lang="zh-Hant" data-writing-lang="zh-Hant">繁體中文<\/span>/)
  // The title still carries its own language, as before.
  assert.match(simplified, /lang="zh-Hans"[^>]*>Title car-community</)
})

test('LatestWriting: on the Chinese home the Chinese pieces name no language (zh, zh-Hans or zh-Hant alike)', async () => {
  const rows = await renderWriting([piece('a', 'zh-Hans'), piece('b', 'zh'), piece('c', 'zh-Hant')], 'zh-Hans')
  assert.equal(rows.length, 3)
  for (const row of rows) assert.doesNotMatch(row, /data-writing-lang/)
})
