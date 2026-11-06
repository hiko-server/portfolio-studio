/**
 * The repository cards of the open-source band (components/GitHub/TopRepos)
 * name an organization's repository "org / name" and leave a personal one
 * as it was. Server markup from the compact page props, synthetic names
 * only. The component is .tsx: a test-local loader transpiles it with the
 * project's TypeScript (as tests/home-about-isr-render.test.ts does).
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

/** A home section inside the home page's words (F3: LandingContent provides them; components/LandingPage/homeUi). */
async function inHome(el: unknown, lang: 'en' | 'zh-Hans' = 'en') {
  const [{ HomeUiContext, EN_HOME_LINKS }, { HOME_UI }] = await Promise.all([import('../components/LandingPage/homeUi'), import('../lib/uiStrings/home')])
  const value = { t: HOME_UI[lang], lang, cvLang: lang === 'en' ? 'en' : 'zh', links: lang === 'en' ? EN_HOME_LINKS : { ...EN_HOME_LINKS, cv: '/cv/zh', contact: '/zh/contact' } }
  return createElement(HomeUiContext.Provider, { value: value as never }, el as never)
}

test('TopRepos: an organization repository shows its owner; a personal one looks as before', async () => {
  const { default: TopRepos } = await import('../components/GitHub/TopRepos')
  const card = (id: number, owner: string, name: string, org?: string) => ({
    id,
    name,
    html_url: `https://github.com/${owner}/${name}`,
    description: `${name} description`,
    stargazers_count: id,
    forks_count: 0,
    language: 'TypeScript',
    pushed_at: '2026-10-01T00:00:00Z',
    ...(org ? { org } : {}),
  })
  const out = html(
    await inHome(
      createElement(TopRepos, {
        limit: 3,
        initialData: {
          available: true,
          asOf: Date.parse('2026-11-01T00:00:00Z'),
          repos: [card(3, 'example-org', 'engine', 'example-org'), card(2, 'example-person', 'site'), { ...card(1, 'example-lab', 'notebook', 'example-lab'), featured: true }],
        },
      }),
    ),
  )
  const items = out.split('<li').slice(1)
  assert.equal(items.length, 3)
  // "example-org / engine": the organization, the separator, the repository name, in that order.
  assert.match(items[0], /data-repo-org="example-org"/)
  assert.match(items[0], />example-org<\/span><span[^>]*> \/ <\/span><span[^>]*>engine<\/span>/)
  assert.match(items[0], /href="https:\/\/github.com\/example-org\/engine"/)
  // A personal repository: just its name, no owner in the text.
  assert.doesNotMatch(items[1], /data-repo-org/)
  assert.doesNotMatch(items[1], />example-person/)
  assert.match(items[1], />site<\/span>/)
  assert.match(items[2], /data-repo-org="example-lab"/)
  assert.match(items[2], /Featured/)
})

test('repoCard keeps the organization of an organization repository only (the page props stay small)', async () => {
  const { repoCard } = await import('../components/Common/githubEvents')
  const base = { id: 1, name: 'engine', full_name: 'example-org/engine', html_url: 'https://github.com/example-org/engine', description: null, stargazers_count: 0, forks_count: 0, language: null, updated_at: '', pushed_at: '' }
  assert.equal(repoCard({ ...base, org: 'example-org' }).org, 'example-org')
  const personal = repoCard({ ...base, full_name: 'example-person/engine', html_url: 'https://github.com/example-person/engine' })
  assert.equal('org' in personal, false)
  assert.equal('full_name' in personal, false)
})
