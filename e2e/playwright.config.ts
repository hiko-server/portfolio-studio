import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices, type Project } from '@playwright/test'

/**
 * Browser E2E + accessibility gate (`yarn e2e`).
 *
 * Runs against an already running build — never a dev server:
 *   - CI: the Docker image built from this commit, started with an EMPTY
 *     data volume (E2E_BASE_URL=http://127.0.0.1:3000, ADMIN_EMAIL/ADMIN_PASS
 *     from the job env);
 *   - after a deploy: production with real content, admin specs excluded:
 *       E2E_BASE_URL=https://lucian-dev.com yarn e2e --grep-invert @admin
 *
 * Public pages run in four Chromium projects (desktop, tablet, phone,
 * reduced motion) and on WebKit (iPhone) and Firefox; the admin and contact
 * flows only on desktop. On the synthetic fixture store (E2E_FIXTURE=1,
 * scripts/ci/fixture-store.mjs) the performance and layout gates
 * (gates.spec.ts) and the visual baselines (visual.spec.ts, `visual`
 * project) run too. The @admin tests form their
 * own desktop project that starts once the public projects are done: they
 * change shared content (the home section order and highlights, logos, the
 * CV, drafts) and regenerate the ISR pages, which would otherwise shift a
 * public test's page between two of its own loads (e.g. a Back that
 * restores the scroll position). They also run one at a time: several of
 * them save the same home document or CV with If-Match, and two editors
 * open at once would conflict (409). If a public test fails, the admin
 * project is reported as not run.
 *
 * The AI specs (e2e/ai-*.spec.ts) run only through scripts/ai-e2e.sh, on the
 * standalone server with the fake provider next to it, in two projects of
 * their own with no `dependencies`, so they do not wait on every public
 * project: `ai-admin` (Chromium) and `ai-consent-firefox`. Those projects
 * exist only when the script's E2E_FAKE_LLM_URL is set (aiProjects below), so
 * a plain `yarn e2e`, and the post-deploy run against production, never
 * lists them: they sign in and change content.
 */
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000'
const CI = !!process.env.CI
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }
const publicOnly = /public\.spec\.ts$/
/**
 * The public checks, the fixture-store layout gates (e2e/gates.spec.ts) and
 * the image viewer's gestures (e2e/lightbox-gestures.spec.ts: touch on
 * Safari's engine matters most), also run on WebKit and Firefox.
 */
const crossEngine = /(public|gates|lightbox-gestures)\.spec\.ts$/
const aiSpecs = /[\\/]ai-[\w-]+\.spec\.ts$/

/**
 * Firefox reads the profile list in the user's Application Support folder even
 * when it is given a -profile, and quits with "Could not find profile folder"
 * if macOS denies that folder to the calling process (an agent's shell, say).
 * CFFIXED_USER_HOME points this one browser process at an empty home, so the
 * AI project runs either way and the owner's Firefox data is never read.
 */
function firefoxEnv(): NodeJS.ProcessEnv {
  const home = path.join(os.tmpdir(), 'ai-e2e-firefox-home')
  fs.mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true })
  fs.mkdirSync(path.join(home, 'Library', 'Caches'), { recursive: true })
  return { ...process.env, CFFIXED_USER_HOME: home }
}

/**
 * The AI projects, registered only for scripts/ai-e2e.sh, which sets
 * E2E_FAKE_LLM_URL next to its own loopback server. With that marker the base
 * URL and the fake must both be on 127.0.0.1: anything else is refused here,
 * before a single test could sign in or write somewhere real. One worker each:
 * their tests share one server and its one AI switch.
 */
function aiProjects(): Project[] {
  const fake = process.env.E2E_FAKE_LLM_URL
  if (!fake) return []
  for (const [name, value] of [['E2E_BASE_URL', baseURL], ['E2E_FAKE_LLM_URL', fake]] as const) {
    if (!URL.canParse(value) || new URL(value).hostname !== '127.0.0.1') {
      throw new Error(`The AI projects run only on loopback (scripts/ai-e2e.sh): ${name} must be a URL on 127.0.0.1.`)
    }
  }
  return [
    { name: 'ai-admin', testMatch: /[\\/]ai-(signin|admin|assistant|editor|public|oauth)\.spec\.ts$/, use: desktop, workers: 1 },
    {
      name: 'ai-consent-firefox',
      testMatch: /[\\/]ai-(signin|oauth)\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 }, launchOptions: { env: firefoxEnv() } },
      workers: 1,
    },
  ]
}

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Asia/Hong_Kong',
  },
  projects: [
    { name: 'chromium', use: desktop, grepInvert: /@admin/, testIgnore: [/visual\.spec\.ts$/, aiSpecs] },
    { name: 'tablet', testMatch: publicOnly, testIgnore: aiSpecs, use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', testMatch: publicOnly, testIgnore: aiSpecs, use: { ...devices['Pixel 7'] } },
    { name: 'reduced', testMatch: publicOnly, testIgnore: aiSpecs, use: { ...desktop, reducedMotion: 'reduce' } },
    // Cross-engine: the public checks on Safari's engine (iPhone — about half
    // of Hong Kong's mobile visits) and on Firefox.
    { name: 'webkit', testMatch: crossEngine, testIgnore: aiSpecs, grepInvert: /@admin/, use: { ...devices['iPhone 15'] } },
    { name: 'firefox', testMatch: crossEngine, testIgnore: aiSpecs, grepInvert: /@admin/, use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
    // Visual baselines of the fixture store (e2e/visual.spec.ts; skipped elsewhere).
    { name: 'visual', testMatch: /visual\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'admin', use: desktop, grep: /@admin/, testIgnore: aiSpecs, workers: 1, dependencies: ['chromium', 'tablet', 'mobile', 'reduced', 'webkit', 'firefox', 'visual'] },
    // AI: only through scripts/ai-e2e.sh (see aiProjects).
    ...aiProjects(),
  ],
})
