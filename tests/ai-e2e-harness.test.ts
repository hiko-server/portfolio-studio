/**
 * The AI end-to-end harness: its Playwright projects stay apart from the public
 * ones and out of every run but scripts/ai-e2e.sh's, and that script runs what
 * design §12.4 says it runs. The script itself is proven by running it; this
 * keeps it from drifting between runs.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const script = fs.readFileSync(path.join(ROOT, 'scripts/ai-e2e.sh'), 'utf8')
const config = fs.readFileSync(path.join(ROOT, 'e2e/playwright.config.ts'), 'utf8')

/** `playwright test --list` with only the given E2E_* variables set. Lists, never runs: no request leaves. */
function listTests(env: Record<string, string>, args: string[] = []) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('E2E_')))
  const res = spawnSync(path.join(ROOT, 'node_modules/.bin/playwright'), ['test', '-c', 'e2e/playwright.config.ts', '--list', '--reporter=list', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...clean, CI: '', ...env } as unknown as NodeJS.ProcessEnv,
  })
  return { ...res, lines: res.stdout.split('\n').filter((l) => /\.spec\.ts:\d+:\d+/.test(l)) }
}
const isAiSpec = (l: string) => /[\s/]ai-[\w-]+\.spec\.ts/.test(l)
const AI_RUN = { E2E_BASE_URL: 'http://127.0.0.1:3610', E2E_FAKE_LLM_URL: 'http://127.0.0.1:3611' }

test('the AI specs run in the two AI projects and in no other', () => {
  const res = listTests(AI_RUN)
  assert.equal(res.status, 0, res.stderr)
  const lines = res.lines
  const projectOf = (l: string) => l.match(/\[([\w-]+)\]/)?.[1]
  const ai = lines.filter(isAiSpec)
  assert.ok(ai.length > 0)
  assert.deepEqual([...new Set(ai.map(projectOf))].sort(), ['ai-admin', 'ai-consent-firefox'])
  for (const l of lines.filter((x) => /^\s*\[ai-/.test(x))) assert.match(l, /[\s/]ai-[\w-]+\.spec\.ts/, 'an AI project runs only AI specs')
  assert.ok(ai.some((l) => /\[ai-consent-firefox\].*ai-signin\.spec\.ts/.test(l)), 'the Firefox sign-in check of stage P0 stays')
})

test('a plain run lists no AI test: not `yarn e2e`, not the post-deploy run against production', () => {
  // The post-deploy command scripts/deploy.sh prints, with a documentation host in place of the site.
  for (const [env, args] of [
    [{}, []],
    [{ E2E_BASE_URL: 'https://example.com' }, ['--grep-invert', '@admin']],
    [{ E2E_BASE_URL: 'http://127.0.0.1:3000', ADMIN_EMAIL: 'owner@example.test', ADMIN_PASS: 'not-a-real-password' }, []],
  ] as const) {
    const res = listTests(env, [...args])
    assert.equal(res.status, 0, res.stderr)
    assert.ok(res.lines.length > 100, 'the ordinary projects are still listed')
    assert.deepEqual(res.lines.filter((l) => isAiSpec(l) || /^\s*\[ai-/.test(l)), [], JSON.stringify(env))
  }
})

test('with the marker, the AI projects refuse any base or fake that is not on loopback', () => {
  for (const env of [
    { ...AI_RUN, E2E_BASE_URL: 'https://example.com' },
    { ...AI_RUN, E2E_FAKE_LLM_URL: 'http://198.51.100.7:3611' },
    { ...AI_RUN, E2E_BASE_URL: 'http://localhost:3610' },
    { ...AI_RUN, E2E_FAKE_LLM_URL: 'not a url' },
  ]) {
    const res = listTests(env)
    assert.notEqual(res.status, 0, JSON.stringify(env))
    assert.match(res.stderr, /The AI projects run only on loopback \(scripts\/ai-e2e\.sh\): E2E_(BASE_URL|FAKE_LLM_URL) must be a URL on 127\.0\.0\.1/)
    assert.deepEqual(res.lines, [], 'nothing is listed, so nothing would run')
  }
})

test('the AI projects have no dependencies, so they do not wait on every public project', () => {
  const start = config.indexOf('function aiProjects()')
  assert.ok(start > 0)
  const block = config.slice(start, config.indexOf('\n}\n', start))
  for (const name of ['ai-admin', 'ai-consent-firefox']) assert.ok(block.includes(`name: '${name}'`), name)
  assert.doesNotMatch(block, /dependencies/)
  assert.match(config, /\.\.\.aiProjects\(\),\n  \],\n\}\)/, 'registered through aiProjects() only')
})

test('ai-e2e.sh is valid bash, on loopback, on the standalone server, with the fake provider', () => {
  assert.equal(spawnSync('bash', ['-n', 'scripts/ai-e2e.sh'], { cwd: ROOT }).status, 0)
  assert.equal((fs.statSync(path.join(ROOT, 'scripts/ai-e2e.sh')).mode & 0o100) !== 0, true, 'executable')
  // Fixture store into a temp tree, before the build, never the checkout's own data.
  assert.match(script, /mktemp -d/)
  assert.match(script, /rm -rf "\$WT\/data" "\$WT\/content" "\$WT\/public\/uploads" "\$WT\/public\/images\/imageScroller"/)
  assert.ok(script.indexOf('fixture-store.mjs') < script.indexOf('next build --webpack'))
  assert.match(script, /env -u NODE_ENV node --import \.\/tests\/register\.mjs scripts\/ci\/fixture-store\.mjs/)
  // The standalone server with public and static copied in, as the image has them.
  assert.match(script, /cp -R public \.next\/standalone\//)
  assert.match(script, /cp -R \.next\/static \.next\/standalone\/\.next\//)
  assert.match(script, /node server\.js/)
  assert.doesNotMatch(script, /next start/)
  // Loopback only, throw-away secrets, the local-provider origin of the fake.
  assert.match(script, /HOSTNAME=127\.0\.0\.1/)
  assert.doesNotMatch(script, /HOSTNAME=0\.0\.0\.0/)
  assert.match(script, /AI_KEYS_SECRET="\$\(secret 32 base64\)"/)
  // …and of e2e/ai-oauth.spec.ts's client-document stub (stage M5), on loopback too.
  assert.match(script, /AI_LOCAL_PROVIDER_ORIGINS="\$FAKE \$OAUTH_STUB"/)
  assert.match(script, /OAUTH_STUB="http:\/\/127\.0\.0\.1:\$OAUTH_STUB_PORT"/)
  assert.match(script, /node tests\/helpers\/fake-llm\.mjs --port "\$FAKE_PORT"/)
  // Credentials never reach the build or the server, and nothing prints a secret.
  assert.match(script, /\^\(R2_\|SMTP_\|CF_\|ANTHROPIC_\|OPENAI_\)\|\^\(INDEXNOW_KEY\|MONGODB_URI\|GITHUB_TOKEN/)
  assert.doesNotMatch(script, /set -x|echo .*\$(ADMIN_PASS|JWT_SECRET|AI_KEYS_SECRET)/)
  // Both projects, one after the other, each one's result reported; E2E_FAKE_LLM_URL is what registers them.
  assert.match(script, /PROJECTS=\(ai-admin ai-consent-firefox\)/)
  // The server's own stores, for the specs that switch a setting there (its cwd is .next/standalone).
  assert.match(script, /export E2E_SERVER_DATA_DIR="\$WT\/\.next\/standalone\/data"/)
  assert.match(script, /E2E_BASE_URL="\$BASE" E2E_FAKE_LLM_URL="\$FAKE" E2E_OAUTH_STUB_PORT="\$OAUTH_STUB_PORT" node_modules\/\.bin\/playwright test -c e2e\/playwright\.config\.ts --project="\$project"/)
})

test('the copy carries no env file into the build: git ignores only .env and .env*.local, and Next loads .env.production', () => {
  // The script's own copy loop, run on a throw-away repository.
  const start = script.indexOf('git ls-files -z --cached --others --exclude-standard | while')
  const end = script.indexOf('\ndone\n', start)
  assert.ok(start > 0 && end > start)
  const loop = script.slice(start, end + '\ndone'.length)
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-e2e-copy-')))
  const repo = path.join(base, 'repo')
  const wt = path.join(base, 'wt')
  // A GIT_DIR in the shell must not answer for the throw-away repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) as NodeJS.ProcessEnv
  try {
    fs.mkdirSync(repo)
    fs.mkdirSync(wt)
    const git = (...args: string[]) => assert.equal(spawnSync('git', ['-c', 'user.name=Example Person', '-c', 'user.email=owner@example.test', ...args], { cwd: repo, env }).status, 0)
    git('init', '-q')
    fs.writeFileSync(path.join(repo, '.gitignore'), fs.readFileSync(path.join(ROOT, '.gitignore')))
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked')
    fs.writeFileSync(path.join(repo, '.env.example'), 'R2_BUCKET=\n')
    git('add', '.gitignore', 'tracked.txt', '.env.example')
    git('commit', '-q', '-m', 'base')
    fs.writeFileSync(path.join(repo, 'new-file.ts'), 'new')
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local', '.env.test']) {
      fs.writeFileSync(path.join(repo, name), 'R2_BUCKET: SENTINEL\n')
    }
    const res = spawnSync('bash', ['-c', `set -euo pipefail\nWT=${JSON.stringify(wt)}\n${loop}`], { cwd: repo, env, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(fs.readdirSync(wt).sort(), ['.env.example', '.gitignore', 'new-file.ts', 'tracked.txt'])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('a free port above 3600 by default, so the trial port 3002 stays free', () => {
  assert.match(script, /free_port "\$\{AI_E2E_PORT:-3610\}"/)
})
