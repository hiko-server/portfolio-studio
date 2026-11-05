#!/usr/bin/env node
/**
 * The local trial of the AI and MCP work: a production build of this worktree
 * on loopback, on synthetic fixture content, with nothing that can reach
 * another system (docs/ai-trial.md).
 *
 *   node scripts/ai-trial.mjs                       build and serve on http://127.0.0.1:3002
 *   node scripts/ai-trial.mjs --dev                 next dev instead (Safari, hot reload)
 *   node scripts/ai-trial.mjs --port 3611           another loopback port
 *   node scripts/ai-trial.mjs --import-content DIR  serve a copy of DIR's content instead of the fixtures
 *   node scripts/ai-trial.mjs --check               run the guards, change nothing, start nothing
 *   node scripts/ai-trial.mjs --reset               remove the trial's secrets, store and build
 *
 * A local server edits local data only if R2, SMTP and Cloudflare credentials
 * are absent: with R2 credentials a local save mirrors to whatever bucket they
 * name, and SMTP sends real mail. A null getPublicHost() stops purge and
 * IndexNow only, not those two. So the trial runs only through this script:
 *
 *   - it refuses the main checkout, where a real .env.local may live;
 *   - it needs Node 22 (ABI 127, better-sqlite3's build; 22.18 for type stripping);
 *   - it refuses a SITE_URL or NEXT_PUBLIC_SITE_HOST that is not on loopback;
 *   - it blanks R2_*, SMTP_*, CF_*, INDEXNOW_KEY, MONGODB_URI, GITHUB_TOKEN,
 *     ANTHROPIC_*, OPENAI_* in the server's environment, whether they came from
 *     the shell or an env file (Next's loader does not override a set variable,
 *     even an empty one), and prints the names it blanked, never a value;
 *   - it binds to 127.0.0.1 only, never 0.0.0.0, and checks that from outside;
 *   - --import-content copies content.db (through db.backup()) and uploads, and
 *     no other store: the rest of data/ would break sign-in and bring in the
 *     inbox, analytics and audit stores.
 *
 * The generated password is shown once, and only on a terminal: a run with its
 * output captured leaves it in .env.local (0600) and out of any log.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import util from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = path.resolve(here, '..')

export const DEFAULT_PORT = 3002
export const STORE_MARKER = '.ai-trial-store'
const REQUIRED_NODE = { abi: '127', major: 22, minor: 18 }
const PREFLIGHT_HOSTS = ['api.anthropic.com', 'api.openai.com', 'api.deepseek.com']
/** The files Next reads in a build or dev run; the shell's environment comes first. */
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local']
/** Without these the site cannot sign anyone in or open the AI store. */
const REQUIRED_SECRETS = ['JWT_SECRET', 'AI_KEYS_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASS']

const log = (line) => console.log(`[ai-trial] ${line}`)

/** A guard said no. Printed without a stack: it is the answer, not a crash. */
class Refused extends Error {}

const USAGE = `usage: node scripts/ai-trial.mjs [--dev] [--port <n>] [--import-content <dir>] [--check] [--reset]`

export function parseArgs(argv) {
  const opts = { dev: false, port: DEFAULT_PORT, importContent: null, check: false, reset: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dev') opts.dev = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--reset') opts.reset = true
    else if (arg === '--port') {
      const port = Number(argv[++i])
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Refused(`--port needs a number from 1024 to 65535.\n${USAGE}`)
      opts.port = port
    } else if (arg === '--import-content') {
      const dir = argv[++i]
      if (!dir) throw new Refused(`--import-content needs a directory.\n${USAGE}`)
      opts.importContent = dir
    } else throw new Refused(`Unknown argument: ${arg}\n${USAGE}`)
  }
  if (opts.reset && (opts.dev || opts.importContent || opts.check)) throw new Refused(`--reset takes no other option.\n${USAGE}`)
  return opts
}

// ── Guards ──────────────────────────────────────────────────────────────

function git(root, args, opts = {}) {
  // A GIT_DIR in the shell must not answer for this checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return spawnSync('git', args, { cwd: root, env, encoding: 'utf8', ...opts })
}

/** A reason to refuse, or null. In a linked worktree the git dir and the common dir differ. */
export function mainCheckoutRefusal(root) {
  const res = git(root, ['rev-parse', '--git-dir', '--git-common-dir'])
  if (res.status !== 0) return 'This is not a git checkout, so it cannot be told apart from the main one. Run the trial in a dedicated worktree.'
  const [gitDir, commonDir] = res.stdout.trim().split('\n').map((p) => fs.realpathSync(path.resolve(root, p)))
  if (gitDir !== commonDir) return null
  return [
    'This is the main checkout: a real .env.local here would mirror saves to R2 and send real mail. Run the trial in a dedicated worktree:',
    '  git worktree add ../landing_page-ai-trial feat/ai-mcp',
    '  cd ../landing_page-ai-trial && yarn install --frozen-lockfile && node scripts/ai-trial.mjs',
  ].join('\n')
}

/** A reason to refuse, or null. */
export function nodeProblem(versions = process.versions) {
  const [major, minor] = String(versions.node).split('.').map(Number)
  const fits = versions.modules === REQUIRED_NODE.abi && major === REQUIRED_NODE.major && minor >= REQUIRED_NODE.minor
  if (fits) return null
  return [
    `This trial needs Node 22 at ${REQUIRED_NODE.major}.${REQUIRED_NODE.minor} or later (ABI ${REQUIRED_NODE.abi}); this is ${versions.node} (ABI ${versions.modules}).`,
    'The pinned version is in .nvmrc. With no version manager, the official tarball:',
    '  mkdir -p ~/.local/node && curl -fsSL https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-arm64.tar.xz | tar -xJ -C ~/.local/node',
    '  export PATH=~/.local/node/node-v22.23.4-darwin-arm64/bin:$PATH',
  ].join('\n')
}

/** Every variable in the env files Next would read: name -> [{ file, value }]. Values stay in memory. */
export function readEnvFiles(root) {
  const found = new Map()
  for (const file of ENV_FILES) {
    let text
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const [name, value] of Object.entries(util.parseEnv(text))) {
      if (!found.has(name)) found.set(name, [])
      found.get(name).push({ file, value })
    }
  }
  return found
}

/**
 * Is this configured site value (an origin or a bare host) on loopback? Stricter
 * than isLocalHostname in lib/env.ts, which also calls 0.0.0.0 local. A test holds
 * the two together: whatever passes here, getPublicHost() treats as not public.
 */
export function isLoopbackValue(value) {
  const raw = String(value).trim()
  let host
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  return host === 'localhost' || host === '[::1]' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** A reason to refuse, or null. Names the variable and where it was set, never its value. */
export function siteRefusal(env, files) {
  for (const name of ['SITE_URL', 'NEXT_PUBLIC_SITE_HOST']) {
    const sources = [...(env[name] ? [{ file: 'the environment', value: env[name] }] : []), ...(files.get(name) ?? [])]
    for (const { file, value } of sources) {
      if (value.trim() && !isLoopbackValue(value)) {
        return `${name} in ${file} is not on loopback. The trial never runs with a public host: with one set, the local-only rules are off and a save could reach it. Unset it for this run.`
      }
    }
  }
  return null
}

/** Is this name one the server must not see? */
const MUST_BE_BLANK = /^(R2_|SMTP_|CF_|ANTHROPIC_|OPENAI_)|^(INDEXNOW_KEY|MONGODB_URI|GITHUB_TOKEN)$/

/**
 * The environment of every child: blanks what could reach another system, from
 * the shell or a file, and reports the names that held a value.
 */
export function childEnvironment(parent, files, overrides = {}) {
  const env = { ...parent }
  delete env.NODE_ENV
  const blanked = new Set()
  for (const name of new Set([...Object.keys(parent), ...files.keys()])) {
    if (!MUST_BE_BLANK.test(name)) continue
    if (parent[name] || (files.get(name) ?? []).some((f) => f.value)) blanked.add(name)
    env[name] = ''
  }
  // LINK_CHECK_INTERVAL_HOURS=0: no background requests to the links in the content. "Check links now" still works.
  return { env: { ...env, NEXT_TELEMETRY_DISABLED: '1', LINK_CHECK_INTERVAL_HOURS: '0', ...overrides }, blanked: [...blanked].sort() }
}

/** True for an address in 198.18.0.0/15, the range a proxy in fake-IP mode answers from. */
export function isFakeIp(address) {
  const match = String(address).replace(/^::ffff:/i, '').match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  return !!match && match[1] === '198' && (match[2] === '18' || match[2] === '19')
}

/**
 * Providers are reached through safeFetch, which correctly blocks 198.18.0.0/15.
 * On a machine whose proxy is in fake-IP mode they would fail with an address
 * error later, so say it now. SSRF rules are never relaxed for this.
 */
export async function preflight(lookup = (host) => dns.lookup(host, { all: true }), hosts = PREFLIGHT_HOSTS) {
  const results = await Promise.all(
    hosts.map(async (host) => {
      try {
        const answers = await Promise.race([lookup(host), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000).unref())])
        return { host, fakeIp: answers.some((a) => isFakeIp(a.address)), resolved: true }
      } catch {
        return { host, fakeIp: false, resolved: false }
      }
    }),
  )
  return {
    fakeIp: results.filter((r) => r.fakeIp).map((r) => r.host),
    unresolved: results.filter((r) => !r.resolved).map((r) => r.host),
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

// ── .env.local ──────────────────────────────────────────────────────────

/**
 * Writes the worktree's .env.local once, 0600. ADMIN_EMAIL and ADMIN_PASS from
 * the shell take the place of generated ones, so an agent can sign in without
 * reading this file. Returns the password only when it was generated here.
 */
export function ensureEnvLocal(root, port, parent = process.env) {
  const file = path.join(root, '.env.local')
  const email = parent.ADMIN_EMAIL || 'owner@example.test'
  const generated = parent.ADMIN_PASS ? null : crypto.randomBytes(18).toString('base64url')
  const lines = [
    '# Written once by scripts/ai-trial.mjs for this worktree. Local trial only: never copy these to a server.',
    `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    `AI_KEYS_SECRET=${crypto.randomBytes(32).toString('base64')}`,
    `ADMIN_EMAIL=${email}`,
    `ADMIN_PASS=${parent.ADMIN_PASS || generated}`,
    `SITE_URL=http://127.0.0.1:${port}`,
    'ADMIN_RECENT_AUTH_MINUTES=1',
    '',
  ]
  try {
    fs.writeFileSync(file, lines.join('\n'), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return { created: false, generatedPass: null, email: null }
  }
  return { created: true, generatedPass: generated, email }
}

/** What to say about a new .env.local. The password appears once, on a terminal, and never in captured output. */
export function credentialNotice({ created, generatedPass, email }, isTerminal) {
  if (!created) return []
  const lines = ['Wrote .env.local (0600) with new secrets.']
  if (generatedPass && isTerminal) lines.push(`Sign in as ${email} with this password, shown once: ${generatedPass}`)
  else if (generatedPass) lines.push('The password is not printed because this output is not a terminal: it is ADMIN_PASS in .env.local.')
  return lines
}

// ── The store ───────────────────────────────────────────────────────────

const removeDbFiles = (dbPath) => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })
}

/**
 * none:      nothing here, install the fixtures.
 * byproduct: content.db that `next build` made from the git seeds and nothing
 *            else: no server ever ran here. It holds no content, and it would
 *            stop the fixture installer, which refuses an existing store.
 * trial:     installed by this script earlier.
 * foreign:   a store this script did not install. It is left alone.
 */
export async function classifyStore(root) {
  const data = path.join(root, 'data')
  const has = (name) => fs.existsSync(path.join(data, name))
  if (has(STORE_MARKER)) return 'trial'
  const server = has('admin.json') || has('auth.db')
  if (!has('content.db')) return server ? 'foreign' : 'none'
  if (server) return 'foreign'
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(path.join(data, 'content.db'), { readonly: true, fileMustExist: true })
  try {
    const { rows } = db.prepare('SELECT (SELECT count(*) FROM collection_items) + (SELECT count(*) FROM pages) AS rows').get()
    return rows === 0 ? 'byproduct' : 'foreign'
  } catch {
    return 'foreign'
  } finally {
    db.close()
  }
}

function installFixtures(root, env) {
  const res = spawnSync(process.execPath, ['--import', './tests/register.mjs', 'scripts/ci/fixture-store.mjs'], { cwd: root, env, stdio: 'inherit' })
  if (res.status !== 0) throw new Refused('The fixture store did not install (see above).')
  fs.writeFileSync(path.join(root, 'data', STORE_MARKER), 'fixture\n')
}

/** Removes what the fixture installer or an earlier import left in tracked and untracked content paths. */
function restoreContentPaths(root) {
  const paths = ['data', 'content', 'public/uploads']
  const clean = git(root, ['clean', '-fdqx', '--', ...paths])
  if (clean.status !== 0) throw new Refused(`git clean failed: ${clean.stderr.trim()}`)
  const tracked = git(root, ['ls-files', '--', ...paths]).stdout.split('\n').filter(Boolean)
  if (tracked.length) {
    const restore = git(root, ['checkout', '-q', '--', ...tracked])
    if (restore.status !== 0) throw new Refused(`git checkout failed: ${restore.stderr.trim()}`)
  }
}

/** content.db through db.backup() (a live source is safe) plus public/uploads. No other store. */
export async function importContent(source, root) {
  const from = path.resolve(source)
  const sourceDb = path.join(from, 'data', 'content.db')
  if (!fs.existsSync(sourceDb)) throw new Refused(`${from} has no data/content.db. Pass the checkout that holds the content.`)
  if (fs.realpathSync(from) === fs.realpathSync(root)) throw new Refused('--import-content needs another checkout, not this worktree.')

  const { default: Database } = await import('better-sqlite3')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const staging = path.join(os.tmpdir(), `ai-trial-import-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`)
  const db = new Database(sourceDb, { readonly: true, fileMustExist: true })
  try {
    await db.backup(staging)
  } finally {
    db.close()
  }
  try {
    restoreContentPaths(root)
    fs.mkdirSync(dataDir, { recursive: true })
    const target = path.join(dataDir, 'content.db')
    removeDbFiles(target)
    fs.copyFileSync(staging, target)
    fs.chmodSync(target, 0o600)
  } finally {
    fs.rmSync(staging, { force: true })
  }

  let uploads = 0
  const fromUploads = path.join(from, 'public', 'uploads')
  if (fs.existsSync(fromUploads)) {
    const toUploads = path.join(root, 'public', 'uploads')
    fs.mkdirSync(toUploads, { recursive: true })
    fs.cpSync(fromUploads, toUploads, {
      recursive: true,
      force: true,
      filter: (src) => {
        const stat = fs.lstatSync(src)
        if (stat.isFile()) uploads++
        return stat.isDirectory() || stat.isFile()
      },
    })
  }
  fs.writeFileSync(path.join(dataDir, STORE_MARKER), 'imported\n')
  return { uploads }
}

/** Back to what git holds: secrets, store, fixtures, uploads and the build all go. */
export function resetTrial(root) {
  fs.rmSync(path.join(root, '.env.local'), { force: true })
  fs.rmSync(path.join(root, '.next'), { recursive: true, force: true })
  restoreContentPaths(root)
}

// ── Running ─────────────────────────────────────────────────────────────

/** Connects to the port on this machine's other addresses: anything but a refusal means it is exposed. */
export async function exposedAddresses(port, interfaces = os.networkInterfaces()) {
  const addresses = Object.values(interfaces)
    .flat()
    .filter((i) => i && !i.internal && i.family === 'IPv4')
    .map((i) => i.address)
  const results = await Promise.all(
    addresses.map(
      (host) =>
        new Promise((resolve) => {
          const socket = net.connect({ host, port })
          socket.setTimeout(1000)
          socket.once('connect', () => {
            socket.destroy()
            resolve(host)
          })
          socket.once('timeout', () => {
            socket.destroy()
            resolve(null)
          })
          socket.once('error', () => resolve(null))
        }),
    ),
  )
  return results.filter(Boolean)
}

function runNextToEnd(root, args, env) {
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), ...args], { cwd: root, env, stdio: 'inherit' })
  return new Promise((resolve) => {
    const forward = (signal) => child.kill(signal)
    process.on('SIGINT', forward)
    process.on('SIGTERM', forward)
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      resolve(code ?? (signal ? 128 : 1))
    })
  })
}

async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (res.status < 500) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function serve(root, opts, env) {
  const url = `http://127.0.0.1:${opts.port}`
  const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next')
  const args = opts.dev ? ['dev', '--webpack', '-H', '127.0.0.1', '-p', String(opts.port)] : ['start', '-H', '127.0.0.1', '-p', String(opts.port)]
  const child = spawn(process.execPath, [next, ...args], { cwd: root, env, stdio: 'inherit' })
  const stop = (signal) => child.kill(signal)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let failed = false
  child.once('exit', (code, signal) => process.exit(failed ? 1 : (code ?? (signal ? 0 : 1))))

  const announce = async () => {
    if (!(await waitForHealth(url, child, opts.dev ? 300_000 : 120_000))) {
      if (child.exitCode === null) {
        console.error(`[ai-trial] The server did not answer on ${url}.`)
        failed = true
        child.kill('SIGTERM')
      }
      return
    }
    const exposed = await exposedAddresses(opts.port)
    if (exposed.length) {
      console.error(`[ai-trial] The server answers on ${exposed.join(', ')}, not only on loopback. Stopping it.`)
      failed = true
      child.kill('SIGTERM')
      return
    }
    log('')
    log('Ready. Use this one URL, not localhost: the canonical host is fixed.')
    log(`  ${url}`)
    // The MCP route arrives with stage M1; the URL is printed once it exists.
    if (fs.existsSync(path.join(root, 'pages', 'api', 'mcp.ts'))) log(`  MCP: ${url}/mcp`)
    log('Sign in with ADMIN_EMAIL and ADMIN_PASS from .env.local.')
    if (!opts.dev) log('Browsers: Chrome or Firefox. Safari rejects the Secure session cookie on plain http; run with --dev for Safari.')
    log('Step-up asks again a minute after sign-in (ADMIN_RECENT_AUTH_MINUTES=1). Stop with Ctrl-C.')
  }
  announce().catch((err) => {
    console.error(`[ai-trial] ${err.message}`)
    failed = true
    child.kill('SIGTERM')
  })
}

export async function main(argv = process.argv.slice(2), root = defaultRoot) {
  const opts = parseArgs(argv)

  const notHere = mainCheckoutRefusal(root)
  if (notHere) throw new Refused(notHere)
  const wrongNode = nodeProblem()
  if (wrongNode) throw new Refused(wrongNode)
  if (!fs.existsSync(path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
    throw new Refused('This worktree has no node_modules of its own. Run: yarn install --frozen-lockfile')
  }

  if (opts.reset) {
    if (!(await portIsFree(DEFAULT_PORT))) throw new Refused(`Something is listening on port ${DEFAULT_PORT}. Stop the trial first.`)
    resetTrial(root)
    log('Removed .env.local, the store, the fixtures and the build. The next run starts fresh, with new secrets.')
    return
  }

  const files = readEnvFiles(root)
  const publicHost = siteRefusal(process.env, files)
  if (publicHost) throw new Refused(publicHost)

  if (!(await portIsFree(opts.port))) throw new Refused(`Port ${opts.port} is in use on 127.0.0.1. Stop what holds it, or pass --port.`)

  const missing = fs.existsSync(path.join(root, '.env.local')) ? REQUIRED_SECRETS.filter((n) => !files.get(n)?.some((f) => f.value) && !process.env[n]) : []
  if (missing.length) throw new Refused(`.env.local has no ${missing.join(', ')}. Add them, or remove the file (--reset) so a new one is written.`)

  const { fakeIp, unresolved } = await preflight()
  if (fakeIp.length) {
    log(`These hosts resolve into 198.18.0.0/15: ${fakeIp.join(', ')}.`)
    log('A proxy in fake-IP mode answers from that range, which the site correctly blocks, so providers reached through it would fail.')
    log('Switch the proxy to real-IP mode for them. The Claude preset uses its SDK on a fixed host, so it can work when others do not.')
  }
  if (unresolved.length) log(`Could not resolve ${unresolved.join(', ')}: those providers will not answer from here.`)

  if (opts.check) {
    const store = await classifyStore(root)
    const { blanked } = childEnvironment(process.env, files)
    log(`Checks passed. Store: ${store}. ${blanked.length ? `Would blank: ${blanked.join(', ')}.` : 'Nothing to blank.'}`)
    return
  }

  for (const line of credentialNotice(ensureEnvLocal(root, opts.port), process.stdout.isTTY === true)) log(line)

  const envFiles = readEnvFiles(root)
  const { env, blanked } = childEnvironment(process.env, envFiles, { SITE_URL: `http://127.0.0.1:${opts.port}` })
  if (blanked.length) log(`Blanked for the server: ${blanked.join(', ')}.`)

  if (opts.importContent) {
    const { uploads } = await importContent(opts.importContent, root)
    log(`Imported content.db and ${uploads} upload(s). No other store was copied. R2 and mail stay blank; what the tools read goes to the provider you pick.`)
  } else {
    const store = await classifyStore(root)
    if (store === 'byproduct') removeDbFiles(path.join(root, 'data', 'content.db'))
    if (store === 'none' || store === 'byproduct') installFixtures(root, env)
    else if (store === 'foreign') log('data/ holds a store this script did not install, and it is served as it is. --reset goes back to the fixtures.')
  }

  if (!opts.dev) {
    log('Building (next build --webpack). The build runs on the same blanked environment.')
    const code = await runNextToEnd(root, ['build', '--webpack'], env)
    if (code !== 0) throw new Refused(`next build failed (exit ${code}).`)
    log('Next warns that `next start` does not suit output: standalone. It works here; scripts/ai-e2e.sh proves the standalone server.')
  }
  serve(root, opts, env)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((err) => {
    if (err instanceof Refused) {
      console.error(`[ai-trial] ${err.message}`)
      process.exit(1)
    }
    console.error('[ai-trial] failed:', err.message || err)
    process.exit(1)
  })
}
