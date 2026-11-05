/**
 * scripts/ai-trial.mjs: the guards that make a local trial safe. Everything
 * here runs on throw-away git repositories and synthetic stores.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  DEFAULT_PORT,
  STORE_MARKER,
  childEnvironment,
  classifyStore,
  credentialNotice,
  ensureEnvLocal,
  exposedAddresses,
  importContent,
  isFakeIp,
  isLoopbackValue,
  mainCheckoutRefusal,
  nodeProblem,
  parseArgs,
  preflight,
  readEnvFiles,
  resetTrial,
  siteRefusal,
} from '../scripts/ai-trial.mjs'

const ROOT = process.cwd()
const SCRIPT = path.join(ROOT, 'scripts', 'ai-trial.mjs')

const asEnv = (env: Record<string, string | undefined>) => env as unknown as NodeJS.ProcessEnv
/** This process's environment without what the script reacts to, so a developer's shell cannot change a result. */
const neutralEnv = (extra: Record<string, string> = {}) =>
  asEnv({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|SITE_URL$|NEXT_PUBLIC_SITE_HOST$|ADMIN_|JWT_SECRET$|AI_KEYS_SECRET$|R2_|SMTP_|CF_|ANTHROPIC_|OPENAI_|INDEXNOW_KEY$|MONGODB_URI$|GITHUB_TOKEN$)/.test(k))),
    ...extra,
  })

function gitIn(cwd: string, ...args: string[]) {
  const res = spawnSync('git', ['-c', 'user.name=Example Person', '-c', 'user.email=owner@example.test', ...args], { cwd, env: neutralEnv(), encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  return res.stdout
}

const mkTemp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)))

/** A throw-away repository holding the script, with a linked worktree. */
function trialRepos() {
  const base = mkTemp('ai-trial')
  const main = path.join(base, 'main')
  const worktree = path.join(base, 'worktree')
  fs.mkdirSync(main)
  gitIn(main, 'init', '-q', '-b', 'main')
  fs.mkdirSync(path.join(main, 'scripts'))
  fs.copyFileSync(SCRIPT, path.join(main, 'scripts', 'ai-trial.mjs'))
  fs.mkdirSync(path.join(main, 'data'))
  fs.writeFileSync(path.join(main, 'data', 'home.json'), '{"seed":true}\n')
  fs.mkdirSync(path.join(main, 'content', 'blog'), { recursive: true })
  fs.writeFileSync(path.join(main, 'content', 'blog', '.gitkeep'), '')
  fs.writeFileSync(path.join(main, '.gitignore'), '.env*\n/.next/\n/node_modules/\ndata/*\n!data/home.json\npublic/uploads/\n')
  gitIn(main, 'add', '.')
  gitIn(main, 'commit', '-q', '-m', 'base')
  gitIn(main, 'worktree', 'add', '-q', '-b', 'trial', worktree)
  for (const dir of [main, worktree]) {
    // The script checks that next is installed; a marker file stands in.
    const bin = path.join(dir, 'node_modules', 'next', 'dist', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'next'), '')
  }
  return { base, main, worktree }
}

function runScript(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(cwd, 'scripts', 'ai-trial.mjs'), ...args], { cwd, env: neutralEnv(env), encoding: 'utf8' })
}

describe('where it runs', () => {
  let repos: ReturnType<typeof trialRepos>
  before(() => {
    repos = trialRepos()
  })
  after(() => fs.rmSync(repos.base, { recursive: true, force: true }))

  test('refuses the main checkout, whatever the arguments', () => {
    assert.match(String(mainCheckoutRefusal(repos.main)), /main checkout/)
    for (const args of [[], ['--check'], ['--reset'], ['--dev'], ['--import-content', repos.worktree]]) {
      const res = runScript(repos.main, args)
      assert.equal(res.status, 1, args.join(' '))
      assert.match(res.stderr, /This is the main checkout/)
      assert.match(res.stderr, /git worktree add/)
    }
    assert.equal(fs.existsSync(path.join(repos.main, '.env.local')), false)
  })

  test('refuses this repository the same way when it is the main one, and GIT_DIR cannot talk it out of that', () => {
    const fake = spawnSync(process.execPath, [path.join(repos.main, 'scripts', 'ai-trial.mjs'), '--check'], {
      cwd: repos.main,
      env: neutralEnv({ GIT_DIR: path.join(repos.main, '.git', 'worktrees', 'worktree'), GIT_COMMON_DIR: path.join(repos.main, '.git') }),
      encoding: 'utf8',
    })
    assert.equal(fake.status, 1)
    assert.match(fake.stderr, /main checkout/)
  })

  test('runs in a linked worktree, and --check changes nothing', () => {
    assert.equal(mainCheckoutRefusal(repos.worktree), null)
    const before = gitIn(repos.worktree, 'status', '--porcelain', '--ignored')
    const res = runScript(repos.worktree, ['--check', '--port', '3987'])
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /Checks passed\. Store: none/)
    assert.equal(gitIn(repos.worktree, 'status', '--porcelain', '--ignored'), before)
  })

  test('a directory outside git is refused', () => {
    const dir = mkTemp('ai-trial-nogit')
    try {
      assert.match(String(mainCheckoutRefusal(dir)), /not a git checkout/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a worktree without node_modules says what to run', () => {
    fs.rmSync(path.join(repos.worktree, 'node_modules'), { recursive: true, force: true })
    const res = runScript(repos.worktree, ['--check'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /yarn install --frozen-lockfile/)
    const bin = path.join(repos.worktree, 'node_modules', 'next', 'dist', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'next'), '')
  })

  test('a public SITE_URL or site host is refused, from the shell or a file, and the value is not printed', () => {
    const shell = runScript(repos.worktree, ['--check'], { SITE_URL: 'https://example.com' })
    assert.equal(shell.status, 1)
    assert.match(shell.stderr, /SITE_URL in the environment is not on loopback/)
    assert.doesNotMatch(shell.stderr + shell.stdout, /example\.com/)

    const host = runScript(repos.worktree, ['--check'], { NEXT_PUBLIC_SITE_HOST: 'example.com' })
    assert.equal(host.status, 1)
    assert.match(host.stderr, /NEXT_PUBLIC_SITE_HOST in the environment/)

    fs.writeFileSync(path.join(repos.worktree, '.env.production'), 'SITE_URL=https://example.com\n')
    try {
      const file = runScript(repos.worktree, ['--check'])
      assert.equal(file.status, 1)
      assert.match(file.stderr, /SITE_URL in \.env\.production/)
    } finally {
      fs.rmSync(path.join(repos.worktree, '.env.production'))
    }
    assert.equal(runScript(repos.worktree, ['--check'], { SITE_URL: 'http://127.0.0.1:3002' }).status, 0)
  })

  test('a port in use is refused before anything is written', async () => {
    const net = await import('node:net')
    const holder = net.createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()))
    const { port } = holder.address() as { port: number }
    try {
      const res = runScript(repos.worktree, ['--port', String(port)])
      assert.equal(res.status, 1)
      assert.match(res.stderr, /is in use/)
      assert.equal(fs.existsSync(path.join(repos.worktree, '.env.local')), false)
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  })

  test('unknown arguments and bad ports are refused', () => {
    assert.throws(() => parseArgs(['--tunnel']), /Unknown argument: --tunnel/)
    assert.throws(() => parseArgs(['--port', '80']), /--port/)
    assert.throws(() => parseArgs(['--port', 'x']), /--port/)
    assert.throws(() => parseArgs(['--import-content']), /needs a directory/)
    assert.throws(() => parseArgs(['--reset', '--dev']), /takes no other option/)
    assert.deepEqual(parseArgs([]), { dev: false, port: DEFAULT_PORT, importContent: null, check: false, reset: false })
    assert.equal(DEFAULT_PORT, 3002)
  })
})

test('Node: ABI 127 and at least 22.18, with the fix printed otherwise', () => {
  assert.equal(nodeProblem({ node: '22.23.4', modules: '127' } as NodeJS.ProcessVersions), null)
  assert.equal(nodeProblem({ node: '22.18.0', modules: '127' } as NodeJS.ProcessVersions), null)
  for (const versions of [
    { node: '23.6.1', modules: '131' },
    { node: '18.20.0', modules: '108' },
    { node: '22.17.1', modules: '127' },
    { node: '24.1.0', modules: '137' },
  ]) {
    const problem = String(nodeProblem(versions as NodeJS.ProcessVersions))
    assert.match(problem, new RegExp(`this is ${versions.node.replace(/\./g, '\\.')}`))
    assert.match(problem, /node-v22\.23\.4/)
  }
  assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), '22.23.4')
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines.node, '>=22.18')
})

describe('what the server can see', () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, [{ file: '.env.local', value: v }]]))

  test('blanks every listed credential from the shell and from files, reports names, never values', () => {
    const parent = {
      R2_ENDPOINT: 'SENTINEL-1',
      R2_REQUIRED: '1',
      SMTP_HOST: 'SENTINEL-2',
      CF_API_TOKEN: 'SENTINEL-3',
      INDEXNOW_KEY: 'SENTINEL-4',
      MONGODB_URI: 'SENTINEL-5',
      GITHUB_TOKEN: 'SENTINEL-6',
      ANTHROPIC_API_KEY: 'SENTINEL-7',
      ANTHROPIC_CUSTOM_HEADERS: 'SENTINEL-8',
      OPENAI_API_KEY: 'SENTINEL-9',
      NODE_ENV: 'production',
      PATH: '/bin',
      SMTP_PORT: '',
    }
    const { env, blanked } = childEnvironment(parent, files({ R2_BUCKET: 'SENTINEL-10', SMTP_PASS: 'SENTINEL-11', CF_ZONE_ID: '', JWT_SECRET: 'kept-from-file' }), { SITE_URL: 'http://127.0.0.1:3002' })
    for (const name of ['R2_ENDPOINT', 'R2_REQUIRED', 'R2_BUCKET', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'CF_API_TOKEN', 'CF_ZONE_ID', 'INDEXNOW_KEY', 'MONGODB_URI', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_API_KEY']) {
      assert.equal(env[name], '', name)
    }
    assert.deepEqual(blanked, ['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'CF_API_TOKEN', 'GITHUB_TOKEN', 'INDEXNOW_KEY', 'MONGODB_URI', 'OPENAI_API_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_REQUIRED', 'SMTP_HOST', 'SMTP_PASS'])
    assert.doesNotMatch(JSON.stringify(blanked), /SENTINEL/)
    assert.doesNotMatch(JSON.stringify(env), /SENTINEL/)
    assert.equal(env.NODE_ENV, undefined, 'next and the fixture installer set their own')
    assert.equal(env.PATH, '/bin')
    assert.equal(env.LINK_CHECK_INTERVAL_HOURS, '0', 'no background requests to the links in the content')
    assert.equal(env.SITE_URL, 'http://127.0.0.1:3002')
    assert.equal('JWT_SECRET' in env, false, 'left to the file')
  })

  test('the --check run names what it would blank and prints no value', () => {
    const repos = trialRepos()
    try {
      fs.writeFileSync(path.join(repos.worktree, '.env.local'), 'JWT_SECRET=x\nAI_KEYS_SECRET=y\nADMIN_EMAIL=a@example.test\nADMIN_PASS=SENTINEL-PASS\nR2_BUCKET=SENTINEL-BUCKET\n')
      const res = runScript(repos.worktree, ['--check'], { SMTP_PASS: 'SENTINEL-SMTP' })
      assert.equal(res.status, 0, res.stderr)
      assert.match(res.stdout, /Would blank: R2_BUCKET, SMTP_PASS\./)
      assert.doesNotMatch(res.stdout + res.stderr, /SENTINEL/)
    } finally {
      fs.rmSync(repos.base, { recursive: true, force: true })
    }
  })

  test('env files are read for names and a loopback SITE_URL passes in every form', async () => {
    const dir = mkTemp('ai-trial-env')
    try {
      fs.writeFileSync(path.join(dir, '.env'), '# comment\nexport R2_BUCKET="quoted"\nSITE_URL=http://localhost:3002\n')
      fs.writeFileSync(path.join(dir, '.env.local'), 'SITE_URL=http://127.0.0.1:3002\n')
      const found = readEnvFiles(dir)
      assert.equal(found.get('R2_BUCKET')?.[0].file, '.env')
      assert.equal(found.get('SITE_URL')?.length, 2)
      assert.equal(siteRefusal({}, found), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    for (const value of ['http://127.0.0.1:3002', 'http://localhost:3002', 'http://[::1]:3002', 'http://trial.localhost:3002', '127.0.0.1:3002']) {
      assert.equal(siteRefusal({ SITE_URL: value }, new Map()), null, value)
    }
    for (const value of ['https://example.com', 'example.com', 'http://0.0.0.0:3002', 'http://[::]:3002', 'http://192.0.2.1:3002', 'http://198.18.0.1', 'http://127.0.0.1.example.com', 'not a url at all %%']) {
      assert.match(String(siteRefusal({ SITE_URL: value }, new Map())), /not on loopback/, value)
    }
    assert.match(String(siteRefusal({}, files({ NEXT_PUBLIC_SITE_HOST: 'example.com' }))), /NEXT_PUBLIC_SITE_HOST in \.env\.local/)
    assert.equal(siteRefusal({ SITE_URL: '   ', NEXT_PUBLIC_SITE_HOST: '' }, new Map()), null)
  })

  test('whatever the trial accepts as loopback, the site treats as not public', async () => {
    const { hostnameOf, isLocalHostname } = await import('../lib/env')
    for (const value of ['http://127.0.0.1:3002', '127.0.0.1:3611', 'http://127.8.9.1', 'http://localhost', 'localhost:3002', 'http://[::1]:3002', 'http://trial.localhost:3002', 'HTTP://LOCALHOST:3002/']) {
      assert.equal(isLoopbackValue(value), true, value)
      const host = hostnameOf(value)
      assert.ok(host && isLocalHostname(host), value)
    }
  })
})

describe('.env.local', () => {
  test('written once, 0600, with every secret the trial needs', () => {
    const dir = mkTemp('ai-trial-envlocal')
    try {
      const first = ensureEnvLocal(dir, 3002, asEnv({}))
      assert.equal(first.created, true)
      assert.ok(first.generatedPass && first.generatedPass.length >= 24)
      const file = path.join(dir, '.env.local')
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      const text = fs.readFileSync(file, 'utf8')
      assert.match(text, /^JWT_SECRET=[0-9a-f]{64}$/m)
      assert.equal(Buffer.from(text.match(/^AI_KEYS_SECRET=(.+)$/m)![1], 'base64').length, 32)
      assert.match(text, /^ADMIN_EMAIL=owner@example\.test$/m)
      assert.ok(text.includes(`ADMIN_PASS=${first.generatedPass}\n`))
      assert.match(text, /^SITE_URL=http:\/\/127\.0\.0\.1:3002$/m)
      assert.match(text, /^ADMIN_RECENT_AUTH_MINUTES=1$/m)

      const second = ensureEnvLocal(dir, 3611, asEnv({}))
      assert.deepEqual(second, { created: false, generatedPass: null, email: null })
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'never rewritten')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('credentials from the shell are used and not reported as generated', () => {
    const dir = mkTemp('ai-trial-envlocal')
    try {
      const made = ensureEnvLocal(dir, 3611, asEnv({ ADMIN_EMAIL: 'walker@example.test', ADMIN_PASS: 'from-the-shell' }))
      assert.equal(made.generatedPass, null)
      const text = fs.readFileSync(path.join(dir, '.env.local'), 'utf8')
      assert.match(text, /^ADMIN_EMAIL=walker@example\.test$/m)
      assert.match(text, /^ADMIN_PASS=from-the-shell$/m)
      assert.match(text, /^SITE_URL=http:\/\/127\.0\.0\.1:3611$/m)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the password shows once, on a terminal only', () => {
    const made = { created: true, generatedPass: 'SENTINEL-PASS', email: 'owner@example.test' }
    assert.match(credentialNotice(made, true).join('\n'), /owner@example\.test with this password, shown once: SENTINEL-PASS/)
    const captured = credentialNotice(made, false).join('\n')
    assert.doesNotMatch(captured, /SENTINEL/)
    assert.match(captured, /it is ADMIN_PASS in \.env\.local/)
    assert.deepEqual(credentialNotice({ created: false, generatedPass: null, email: null }, true), [], 'not on later runs')
    assert.doesNotMatch(credentialNotice({ created: true, generatedPass: null, email: 'a@example.test' }, true).join('\n'), /password/, 'one from the shell is not repeated')
  })

  test('a captured run writes the file and its output never holds a secret from it', () => {
    const repos = trialRepos()
    try {
      // Stops at the fixture step: this throw-away repository has no installer.
      const res = runScript(repos.worktree, ['--port', '3989'])
      assert.equal(res.status, 1)
      const text = fs.readFileSync(path.join(repos.worktree, '.env.local'), 'utf8')
      const output = res.stdout + res.stderr
      assert.match(output, /Wrote \.env\.local \(0600\)/)
      for (const name of ['JWT_SECRET', 'AI_KEYS_SECRET', 'ADMIN_PASS']) {
        const value = text.match(new RegExp(`^${name}=(.+)$`, 'm'))![1]
        assert.equal(output.includes(value), false, name)
      }
    } finally {
      fs.rmSync(repos.base, { recursive: true, force: true })
    }
  })

  test('an existing file missing a secret is refused with the names and no values', () => {
    const repos = trialRepos()
    try {
      fs.writeFileSync(path.join(repos.worktree, '.env.local'), 'JWT_SECRET=SENTINEL\nAI_LOCAL_PROVIDER_ORIGINS=http://127.0.0.1:11434\n')
      const res = runScript(repos.worktree, ['--check'])
      assert.equal(res.status, 1)
      assert.match(res.stderr, /\.env\.local has no AI_KEYS_SECRET, ADMIN_EMAIL, ADMIN_PASS/)
      assert.doesNotMatch(res.stderr + res.stdout, /SENTINEL/)
    } finally {
      fs.rmSync(repos.base, { recursive: true, force: true })
    }
  })
})

test('preflight names the hosts behind a fake-IP proxy and the ones that do not resolve', async () => {
  assert.equal(isFakeIp('198.18.0.1'), true)
  assert.equal(isFakeIp('198.19.255.255'), true)
  assert.equal(isFakeIp('::ffff:198.18.3.4'), true)
  for (const address of ['198.17.255.255', '198.20.0.0', '203.0.113.5', '2001:db8::1', 'junk']) assert.equal(isFakeIp(address), false, address)

  const lookup = async (host: string) => {
    if (host === 'fake.example') return [{ address: '198.18.0.7', family: 4 }]
    if (host === 'mixed.example') return [{ address: '203.0.113.9', family: 4 }, { address: '198.19.1.1', family: 4 }]
    if (host === 'real.example') return [{ address: '203.0.113.1', family: 4 }]
    throw new Error('ENOTFOUND')
  }
  assert.deepEqual(await preflight(lookup, ['fake.example', 'mixed.example', 'real.example', 'gone.example']), { fakeIp: ['fake.example', 'mixed.example'], unresolved: ['gone.example'] })
})

test('an address that accepts the connection counts as exposed, loopback and a refusal do not', async () => {
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  const iface = (address: string, internal = false) => ({ address, internal, family: 'IPv4' }) as os.NetworkInterfaceInfo
  // 127.0.0.1 stands in for a LAN address: what matters is that the connection is accepted.
  assert.deepEqual(await exposedAddresses(port, { en0: [iface('127.0.0.1')] }), ['127.0.0.1'])
  assert.deepEqual(await exposedAddresses(port, { lo0: [iface('127.0.0.1', true)] }), [], 'the interface the server is meant to be on')
  await new Promise((resolve) => server.close(resolve))
  assert.deepEqual(await exposedAddresses(port, { en0: [iface('127.0.0.1')] }), [], 'refused')
})

describe('the store', () => {
  async function makeContentDb(file: string, opts: { items?: number; kv?: Record<string, string> } = {}) {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(file)
    db.exec('CREATE TABLE pages (name TEXT PRIMARY KEY); CREATE TABLE collection_items (slug TEXT PRIMARY KEY); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
    for (let i = 0; i < (opts.items ?? 0); i++) db.prepare('INSERT INTO collection_items VALUES (?)').run(`item-${i}`)
    for (const [k, v] of Object.entries(opts.kv ?? { home: '{}' })) db.prepare('INSERT INTO kv VALUES (?, ?)').run(k, v)
    db.close()
  }

  test('classification: none, the build by-product, the trial own, anything else foreign', async () => {
    const root = mkTemp('ai-trial-store')
    const data = path.join(root, 'data')
    fs.mkdirSync(data)
    try {
      fs.writeFileSync(path.join(data, 'home.json'), '{}')
      assert.equal(await classifyStore(root), 'none')

      await makeContentDb(path.join(data, 'content.db'))
      assert.equal(await classifyStore(root), 'byproduct')

      fs.rmSync(path.join(data, 'content.db'))
      await makeContentDb(path.join(data, 'content.db'), { items: 1 })
      assert.equal(await classifyStore(root), 'foreign', 'a store with content is never treated as disposable')

      fs.rmSync(path.join(data, 'content.db'))
      await makeContentDb(path.join(data, 'content.db'))
      fs.writeFileSync(path.join(data, 'auth.db'), '')
      assert.equal(await classifyStore(root), 'foreign', 'a server ran here')

      fs.rmSync(path.join(data, 'auth.db'))
      fs.writeFileSync(path.join(data, 'admin.json'), '{}')
      fs.rmSync(path.join(data, 'content.db'))
      assert.equal(await classifyStore(root), 'foreign')

      fs.rmSync(path.join(data, 'admin.json'))
      fs.writeFileSync(path.join(data, 'content.db'), 'not a database')
      assert.equal(await classifyStore(root), 'foreign')

      fs.writeFileSync(path.join(data, STORE_MARKER), 'fixture\n')
      assert.equal(await classifyStore(root), 'trial')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('--import-content copies content.db and uploads only, removes the fixtures, and serves no other store', async () => {
    const repos = trialRepos()
    const source = path.join(repos.base, 'source')
    try {
      fs.mkdirSync(path.join(source, 'data'), { recursive: true })
      fs.mkdirSync(path.join(source, 'public', 'uploads', 'nested'), { recursive: true })
      await makeContentDb(path.join(source, 'data', 'content.db'), { items: 3, kv: { home: '{"name":"Example Person"}' } })
      for (const other of ['admin.json', 'auth.db', 'analytics.db', 'audit.db', 'contact-inbox.jsonl', 'ai.db']) fs.writeFileSync(path.join(source, 'data', other), 'SENTINEL-OTHER-STORE')
      fs.writeFileSync(path.join(source, '.env'), 'R2_BUCKET=SENTINEL\n')
      fs.writeFileSync(path.join(source, 'public', 'uploads', 'a.webp'), 'image')
      fs.writeFileSync(path.join(source, 'public', 'uploads', 'nested', 'b.webp'), 'image')
      fs.symlinkSync('/etc/hosts', path.join(source, 'public', 'uploads', 'link.webp'))

      // Fixture leftovers that must not survive, or the seeds would auto-fill rows.
      const wt = repos.worktree
      fs.writeFileSync(path.join(wt, 'content', 'blog', 'fixture.mdx'), 'fixture')
      fs.writeFileSync(path.join(wt, 'data', 'home.json'), '{"fixture":true}\n')
      fs.mkdirSync(path.join(wt, 'public', 'uploads'), { recursive: true })
      fs.writeFileSync(path.join(wt, 'public', 'uploads', 'fixture.webp'), 'fixture')
      await makeContentDb(path.join(wt, 'data', 'content.db'), { items: 0 })
      fs.writeFileSync(path.join(wt, 'data', 'admin.json'), '{"keep":"sign-in"}')

      const before = process.cwd()
      process.chdir(wt)
      const res = await importContent(source, wt).finally(() => process.chdir(before))
      assert.equal(res.uploads, 2)

      const { default: Database } = await import('better-sqlite3')
      const db = new Database(path.join(wt, 'data', 'content.db'), { readonly: true })
      assert.equal((db.prepare('SELECT count(*) c FROM collection_items').get() as { c: number }).c, 3)
      db.close()
      assert.equal(fs.statSync(path.join(wt, 'data', 'content.db')).mode & 0o777, 0o600)
      for (const other of ['auth.db', 'analytics.db', 'audit.db', 'contact-inbox.jsonl', 'ai.db']) assert.equal(fs.existsSync(path.join(wt, 'data', other)), false, other)
      assert.equal(fs.readFileSync(path.join(wt, 'public', 'uploads', 'a.webp'), 'utf8'), 'image')
      assert.equal(fs.readFileSync(path.join(wt, 'public', 'uploads', 'nested', 'b.webp'), 'utf8'), 'image')
      assert.equal(fs.existsSync(path.join(wt, 'public', 'uploads', 'link.webp')), false, 'no symlink follows the copy')
      assert.equal(fs.existsSync(path.join(wt, 'public', 'uploads', 'fixture.webp')), false)
      assert.equal(fs.existsSync(path.join(wt, 'content', 'blog', 'fixture.mdx')), false)
      assert.equal(fs.existsSync(path.join(wt, 'content', 'blog', '.gitkeep')), true)
      assert.equal(fs.readFileSync(path.join(wt, 'data', 'home.json'), 'utf8'), '{"seed":true}\n', 'the git seed is back')
      assert.equal(fs.readFileSync(path.join(wt, 'data', STORE_MARKER), 'utf8'), 'imported\n')
      assert.equal(await classifyStore(wt), 'trial')
      assert.equal(fs.readFileSync(path.join(source, 'data', 'admin.json'), 'utf8'), 'SENTINEL-OTHER-STORE', 'the source is untouched')
    } finally {
      fs.rmSync(repos.base, { recursive: true, force: true })
    }
  })

  test('--import-content refuses a directory without a content store, and this worktree itself', async () => {
    const repos = trialRepos()
    try {
      await assert.rejects(importContent(path.join(repos.base, 'nothing'), repos.worktree), /has no data\/content\.db/)
      await makeContentDb(path.join(repos.worktree, 'data', 'content.db'))
      await assert.rejects(importContent(repos.worktree, repos.worktree), /another checkout/)
    } finally {
      fs.rmSync(repos.base, { recursive: true, force: true })
    }
  })

  test('--reset goes back to what git holds', () => {
    const repos = trialRepos()
    const wt = repos.worktree
    try {
      fs.writeFileSync(path.join(wt, '.env.local'), 'JWT_SECRET=x\n')
      fs.mkdirSync(path.join(wt, '.next'))
      fs.writeFileSync(path.join(wt, '.next', 'BUILD_ID'), 'x')
      fs.writeFileSync(path.join(wt, 'data', 'home.json'), '{"fixture":true}\n')
      fs.writeFileSync(path.join(wt, 'data', 'auth.db'), '')
      fs.writeFileSync(path.join(wt, 'data', STORE_MARKER), 'fixture\n')
      fs.writeFileSync(path.join(wt, 'content', 'blog', 'fixture.mdx'), 'fixture')
      fs.mkdirSync(path.join(wt, 'public', 'uploads'), { recursive: true })
      fs.writeFileSync(path.join(wt, 'public', 'uploads', 'x.webp'), 'x')
      resetTrial(wt)
      assert.equal(fs.existsSync(path.join(wt, '.env.local')), false)
      assert.equal(fs.existsSync(path.join(wt, '.next')), false)
      assert.equal(fs.existsSync(path.join(wt, 'public', 'uploads', 'x.webp')), false)
      assert.equal(fs.readFileSync(path.join(wt, 'data', 'home.json'), 'utf8'), '{"seed":true}\n')
      assert.deepEqual(fs.readdirSync(path.join(wt, 'data')), ['home.json'])
      assert.deepEqual(fs.readdirSync(path.join(wt, 'content', 'blog')), ['.gitkeep'])
      assert.equal(gitIn(wt, 'status', '--porcelain'), '')
    } finally {
      fs.rmSync(repos.base, { recursive: true, force: true })
    }
  })
})

test('the script binds to loopback and never 0.0.0.0, in both modes', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(source, /\['dev', '--webpack', '-H', '127\.0\.0\.1', '-p', String\(opts\.port\)\]/)
  assert.match(source, /\['start', '-H', '127\.0\.0\.1', '-p', String\(opts\.port\)\]/)
  assert.doesNotMatch(source, /'-H',\s*'0\.0\.0\.0'/)
})
