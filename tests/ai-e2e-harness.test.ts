/**
 * The AI end-to-end harness: its Playwright projects stay apart from the public
 * ones, and scripts/ai-e2e.sh runs what design §12.4 says it runs. The script
 * itself is proven by running it; this keeps it from drifting between runs.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const script = fs.readFileSync(path.join(ROOT, 'scripts/ai-e2e.sh'), 'utf8')
const config = fs.readFileSync(path.join(ROOT, 'e2e/playwright.config.ts'), 'utf8')

test('the AI specs run in the two AI projects and in no other', () => {
  const res = spawnSync(path.join(ROOT, 'node_modules/.bin/playwright'), ['test', '-c', 'e2e/playwright.config.ts', '--list', '--reporter=list'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '' } as unknown as NodeJS.ProcessEnv,
  })
  assert.equal(res.status, 0, res.stderr)
  const lines = res.stdout.split('\n').filter((l) => /\.spec\.ts:\d+:\d+/.test(l))
  const projectOf = (l: string) => l.match(/\[([\w-]+)\]/)?.[1]
  const ai = lines.filter((l) => /[\s/]ai-[\w-]+\.spec\.ts/.test(l))
  assert.ok(ai.length > 0)
  assert.deepEqual([...new Set(ai.map(projectOf))].sort(), ['ai-admin', 'ai-consent-firefox'])
  for (const l of lines.filter((x) => /^\s*\[ai-/.test(x))) assert.match(l, /[\s/]ai-[\w-]+\.spec\.ts/, 'an AI project runs only AI specs')
  assert.ok(ai.some((l) => /\[ai-consent-firefox\].*ai-signin\.spec\.ts/.test(l)), 'the Firefox sign-in check of stage P0 stays')
})

test('the AI projects have no dependencies, so they do not wait on every public project', () => {
  for (const name of ['ai-admin', 'ai-consent-firefox']) {
    const start = config.indexOf(`name: '${name}'`)
    assert.ok(start > 0, name)
    const block = config.slice(start, config.indexOf('\n  ],', start))
    const own = name === 'ai-admin' ? block.slice(0, block.indexOf('\n')) : block
    assert.doesNotMatch(own, /dependencies/, name)
  }
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
  assert.match(script, /AI_LOCAL_PROVIDER_ORIGINS="\$FAKE"/)
  assert.match(script, /node tests\/helpers\/fake-llm\.mjs --port "\$FAKE_PORT"/)
  // Credentials never reach the build or the server, and nothing prints a secret.
  assert.match(script, /\^\(R2_\|SMTP_\|CF_\|ANTHROPIC_\|OPENAI_\)\|\^\(INDEXNOW_KEY\|MONGODB_URI\|GITHUB_TOKEN/)
  assert.doesNotMatch(script, /set -x|echo .*\$(ADMIN_PASS|JWT_SECRET|AI_KEYS_SECRET)/)
  // Both projects, one after the other, each one's result reported.
  assert.match(script, /PROJECTS=\(ai-admin ai-consent-firefox\)/)
})

test('a free port above 3600 by default, so the trial port 3002 stays free', () => {
  assert.match(script, /free_port "\$\{AI_E2E_PORT:-3610\}"/)
})
