/**
 * G7 / CRIT-cross-engine-visual — the synthetic CI fixture store and the
 * gates that run on it.
 *
 *   - the store is owner-neutral test data (decisions.md: never open-source
 *     personal information): no owner name, contact or address, only
 *     example.com / example.org addresses, generated images without
 *     metadata, and every file it references is in it;
 *   - it can never reach production: e2e/ is outside the Docker build
 *     context, and the installer refuses a checkout with a real store;
 *   - scripts/check-fixture-gates.sh runs the gates in the Playwright image of the pinned version, and
 *     the visual baselines exist for every page × viewport × theme.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { FIXTURE_DIR, FIXTURE_TIME, install } from '../scripts/ci/fixture-store.mjs'
import { STORE_MARKER } from '../scripts/ai-trial.mjs'

const ROOT = process.cwd()

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : [p]
  })
}

const textFiles = () => files(FIXTURE_DIR).filter((f) => /\.(json|mdx?)$/.test(f))

/** CV fields that name an organisation (an employer, a school, an issuer, a venue, a contest). */
const ORG_FIELDS = new Set(['companyName', 'schoolName', 'issuingOrganization', 'organization', 'authority', 'contestName', 'publisher', 'venue'])
/** CV fields that name the owner or their work. */
const OWN_FIELDS = new Set(['firstName', 'lastName', 'nickName', 'title', 'projectLocation'])

/**
 * The owner's facts the fixture must not contain — organisations, project
 * and case-study names, the owner's names — read at test time from the real
 * content store when this checkout has one (data/ is never committed, so the
 * public repository itself names none of them: a tracked list of "what
 * identifies the owner" would disclose exactly that). Null without a store
 * (CI): that part of the check is skipped there. A store with no post, case
 * study or page is the one `next build` makes from the git seeds in a fresh
 * checkout: its CV is the fictional demo, not the owner's, so it counts as none.
 * So does a store scripts/ai-trial.mjs made from this fixture (its marker in
 * data/ says `fixture`): read as the owner's, it would hold the fixture's own
 * names, and the check would compare the fixture with itself. A store it
 * imported (`imported`) is read like any other.
 */
function ownerFactsFromStore(root = ROOT): string[] | null {
  const file = path.join(root, 'data', 'content.db')
  if (!fs.existsSync(file)) return null
  if (trialStoreKind(root) === 'fixture') return null
  const facts = new Set<string>()
  const add = (v: unknown) => {
    if (typeof v !== 'string') return
    const text = v.replace(/\s+/g, ' ').trim()
    for (const part of [text, ...Array.from(text.matchAll(/\(([^)]+)\)/g), (m) => m[1].trim())]) if (part.length >= 4) facts.add(part.toLowerCase())
  }
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) {
        if (ORG_FIELDS.has(k) || OWN_FIELDS.has(k)) add(v)
        if (v && typeof v === 'object') walk(v)
      }
  }
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const { rows } = db.prepare('SELECT (SELECT count(*) FROM collection_items) + (SELECT count(*) FROM pages) AS rows').get() as { rows: number }
    if (rows === 0) return null
    const cv = db.prepare("SELECT value FROM kv WHERE key = 'cvdata'").get() as { value: string } | undefined
    if (cv) walk(JSON.parse(cv.value))
    for (const item of db.prepare('SELECT slug, frontmatter FROM collection_items').all() as Array<{ slug: string; frontmatter: string }>) {
      add(item.slug)
      add((JSON.parse(item.frontmatter) as { title?: unknown }).title)
    }
  } finally {
    db.close()
  }
  return [...facts]
}

/** What the local trial put in this checkout's data/: 'fixture', 'imported', or null for no trial store. */
function trialStoreKind(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, 'data', STORE_MARKER), 'utf8').trim()
  } catch {
    return null
  }
}

const wholeWords = (fact: string) => new RegExp(`(?<![\\p{L}\\p{N}])${fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')

test('the fixture is owner-neutral: no owner identity, no real contact data', (t) => {
  // Only what the public site itself shows (the display name, the domain, the handle) and contact-data shapes.
  const forbidden = [/yanpei/i, /李彦霈|李彥霈|彦霈/, /\blucian\b/i, /lucian-dev/i, /hiko/i, /\+852/, /\b\d{8}\b/]
  const facts = ownerFactsFromStore()
  if (facts) forbidden.push(...facts.map(wholeWords))
  else t.diagnostic('no store of the owner\'s content in this checkout (none, the build\'s seed store, or the local trial\'s fixture store): the check against the owner\'s own facts is skipped')
  for (const file of textFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    for (const re of forbidden) assert.doesNotMatch(text, re, `${path.relative(ROOT, file)} matches ${re}`)
    for (const m of text.matchAll(/[\w.+-]+@([\w-]+\.[\w.]+)/g)) assert.match(m[1], /^example\.(com|org)$/, `${path.relative(ROOT, file)}: ${m[0]}`)
    for (const m of text.matchAll(/https?:\/\/([^/\s"')]+)/g)) assert.match(m[1], /^(www\.)?example\.(com|org)$/, `${path.relative(ROOT, file)}: ${m[0]}`)
  }
  const home = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'data/home.json'), 'utf8'))
  assert.equal(home.site.name, 'Example Person')
  assert.deepEqual(Object.values(home.socials), ['', '', '', ''], 'no social profile, so nothing is fetched from GitHub')
})

test('the local trial\'s fixture store, as the server makes it from the installed fixture, is not read as the owner\'s; an imported store is', async () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g7-trial-store-')))
  try {
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'portfolio-studio' }))
    await install(target)
    // The real content store, seeded from the installed fixture the way a build or a server seeds it.
    const seed = [
      `const store = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'contentStore.ts')).href)})`,
      "for (const c of ['blog', 'work']) store.listItems(c)",
      "for (const p of ['about', 'now', 'uses']) store.getPage(p)",
      "for (const k of ['home', 'cvdata']) store.getKv(k)",
      `const { closeDb } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lib', 'db.ts')).href)})`,
      'closeDb()',
    ].join('\n')
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(R2_|CF_|INDEXNOW_KEY$|SMTP_|MONGODB_URI$)/.test(k))) as NodeJS.ProcessEnv
    const res = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'tests', 'register.mjs')).href, '--input-type=module', '-e', seed], { cwd: target, env, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)

    // Without the trial's marker this store reads as the owner's, and the fixture would "match" its own names.
    const facts = ownerFactsFromStore(target)
    assert.ok(facts && facts.length > 0, 'a store with content is read')
    const own = facts!.map(wholeWords)
    assert.ok(
      textFiles().some((file) => own.some((re) => re.test(fs.readFileSync(file, 'utf8')))),
      'read as the owner\'s, the fixture store fails the owner-neutral check against itself',
    )

    fs.writeFileSync(path.join(target, 'data', STORE_MARKER), 'fixture\n')
    assert.equal(ownerFactsFromStore(target), null, 'scripts/ai-trial.mjs installed it from this fixture')
    fs.writeFileSync(path.join(target, 'data', STORE_MARKER), 'imported\n')
    assert.deepEqual(ownerFactsFromStore(target), facts, 'an imported store is the owner\'s content: read')
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('every upload the fixture references is in it, and every fixture image is small, synthetic and metadata-free', async () => {
  const uploads = new Set(fs.readdirSync(path.join(FIXTURE_DIR, 'uploads')))
  const referenced = new Set<string>()
  for (const file of textFiles()) for (const m of fs.readFileSync(file, 'utf8').matchAll(/\/uploads\/([A-Za-z0-9._-]+)/g)) referenced.add(m[1])
  assert.deepEqual([...referenced].filter((n) => !uploads.has(n)), [], 'missing uploads')
  assert.deepEqual([...uploads].filter((n) => !referenced.has(n)), [], 'unused uploads')
  for (const name of uploads) {
    const file = path.join(FIXTURE_DIR, 'uploads', name)
    assert.ok(fs.statSync(file).size < 100 * 1024, `${name} stays small`)
    const meta = await sharp(file).metadata()
    assert.equal(meta.exif, undefined, `${name}: no EXIF`)
    assert.equal(meta.xmp, undefined, `${name}: no XMP`)
  }
})

test('the fixture never reaches the Docker image', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim())
  assert.ok(ignore.includes('e2e'), '.dockerignore keeps e2e/ (and the fixture) out of the build context')
})

test('install(): refuses a real store and production; copies data, content and uploads with variants, dated FIXTURE_TIME', async () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g7-fixture-')))
  try {
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'not-this-site' }))
    await assert.rejects(install(target), /not a checkout of this site/)
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'portfolio-studio' }))
    fs.mkdirSync(path.join(target, 'data'))
    fs.writeFileSync(path.join(target, 'data', 'content.db'), '')
    await assert.rejects(install(target), /refusing to mix test fixtures into a real store/)
    fs.rmSync(path.join(target, 'data', 'content.db'))
    const env = process.env.NODE_ENV
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    await assert.rejects(install(target), /NODE_ENV=production/)
    ;(process.env as Record<string, string | undefined>).NODE_ENV = env

    const result = await install(target)
    assert.equal(result.uploads, fs.readdirSync(path.join(FIXTURE_DIR, 'uploads')).length)
    assert.ok(result.variants > result.uploads * 4, 'WebP + AVIF variants and placeholders')
    const home = JSON.parse(fs.readFileSync(path.join(target, 'data', 'home.json'), 'utf8'))
    assert.equal(home.site.name, 'Example Person')
    for (const rel of ['content/blog/example-field-notes.mdx', 'content/work/example-sorting-station.mdx', 'content/about.mdx', 'public/uploads/example-portrait.jpg', 'public/uploads/example-portrait.jpg.w320.avif', 'public/uploads/example-portrait.jpg.w16.webp']) {
      assert.ok(fs.existsSync(path.join(target, rel)), rel)
    }
    assert.equal(fs.statSync(path.join(target, 'content/blog/example-field-notes.mdx')).mtimeMs, FIXTURE_TIME.getTime(), 'pinned dates: stable "updated" stamps')
    const again = await install(target)
    assert.equal(again.variants, 0, 'a second install keeps the variants it made')
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('scripts/check-fixture-gates.sh runs the gates in the Playwright image of the pinned version, on the fixture store', () => {
  // The GitHub Actions workflow is gone (the owner removed CI); the gates run locally through this script.
  const script = fs.readFileSync(path.join(ROOT, 'scripts/check-fixture-gates.sh'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const version = String(pkg.devDependencies['@playwright/test']).replace(/^[^\d]*/, '')
  assert.match(script, new RegExp(`mcr\\.microsoft\\.com/playwright:v${version.replace(/\./g, '\\.')}-noble`), 'the image matches @playwright/test')
  assert.match(script, /scripts\/ci\/fixture-store\.mjs/)
  assert.match(script, /E2E_FIXTURE=1/)
  assert.match(script, /TZ=UTC/)
  assert.match(script, /--grep @cwv --workers=1/, 'the CWV gate runs alone')
  assert.match(script, /--project=webkit --project=firefox --project=visual/)
  // Never the owner's content: the live store, uploads and photos are removed from the scratch tree.
  assert.match(script, /rm -rf "\$WT\/data" "\$WT\/public\/uploads" "\$WT\/public\/images\/imageScroller"/)
  assert.equal(fs.existsSync(path.join(ROOT, '.github/workflows/ci.yml')), false)
  const config = fs.readFileSync(path.join(ROOT, 'e2e/playwright.config.ts'), 'utf8')
  for (const project of ['webkit', 'firefox', 'visual']) assert.match(config, new RegExp(`name: '${project}'`))
})

test('a visual baseline exists for every page × viewport × theme, and nothing else is stored', () => {
  const dir = path.join(ROOT, 'e2e', 'visual.spec.ts-snapshots')
  const expected: string[] = []
  for (const page of ['home', 'article', 'case-study', 'cv', 'contact']) {
    for (const viewport of ['phone', 'tablet', 'desktop']) for (const theme of ['dark', 'light']) expected.push(`${page}-${viewport}-${theme}-visual-linux.png`)
  }
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
  assert.deepEqual(present, expected.sort())
})
