#!/usr/bin/env node
/**
 * Live smoke test of model providers — OWNER-RUN ONLY, REAL KEYS, REAL COST.
 * Never part of a gate (design §12.5): it runs the very probe Admin → AI →
 * Models → Test runs (lib/ai/providers/probe.ts: the model list, a streaming
 * request with the full tool catalogue plus probe_echo, the tool result sent
 * back, and for Claude the thinking display), once per provider you name,
 * and prints what each one actually does.
 *
 *   node --import ./tests/register.mjs scripts/ai-live-smoke.mjs --real <preset>=<model> [...]
 *
 *   presets  claude openai xai openrouter deepseek gemini qwen kimi glm
 *            minimax mistral groq ollama lmstudio custom
 *   keys     from the environment, one per preset, never from the command
 *            line (it would land in your shell history):
 *              AI_SMOKE_KEY_CLAUDE, AI_SMOKE_KEY_DEEPSEEK, AI_SMOKE_KEY_LMSTUDIO, …
 *            (upper case, "-" as "_"; optional for ollama, lmstudio, custom)
 *   hosts    a preset's alternative official host: AI_SMOKE_URL_<PRESET>
 *            (e.g. AI_SMOKE_URL_KIMI=https://api.moonshot.cn/v1);
 *            qwen: AI_SMOKE_QWEN_WORKSPACE and AI_SMOKE_QWEN_REGION;
 *            custom: AI_SMOKE_URL_CUSTOM and AI_SMOKE_WIRE_CUSTOM (chat|responses);
 *            ollama / lmstudio: AI_LOCAL_PROVIDER_ORIGINS=http://127.0.0.1:11434 (exact
 *            origins, loopback only, as on the site)
 *   --json   one JSON line per result instead of the table
 *
 * Without --real it only says what it would probe (which keys it found, by
 * name): every probe is a real request billed to your key. Use a dedicated
 * project key with a spend limit or a prepaid balance.
 *
 * What it never does: print, log or store a key (provider messages are
 * scrubbed of it before they are shown); read or write the site's stores (it
 * works in a temporary directory, removed at the end); send anything but the
 * probe's fixed prompt and the static tool catalogue — no site content.
 * Addresses go through the same SSRF rules as the site: a VPN or proxy in
 * fake-IP mode (198.18.0.0/15) is refused and named as the likely cause.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function usage(code = 2) {
  console.error('usage: node --import ./tests/register.mjs scripts/ai-live-smoke.mjs [--real] [--json] <preset>=<model> [...]')
  process.exit(code)
}

const envName = (preset, kind) => `AI_SMOKE_${kind}_${preset.toUpperCase().replace(/-/g, '_')}`

async function main(argv) {
  const real = argv.includes('--real')
  const json = argv.includes('--json')
  const specs = argv.filter((a) => !a.startsWith('--'))
  if (!specs.length) usage()
  const targets = []
  for (const spec of specs) {
    const at = spec.indexOf('=')
    if (at <= 0 || at === spec.length - 1) usage()
    targets.push({ preset: spec.slice(0, at), model: spec.slice(at + 1) })
  }

  // Work in a throw-away directory: the probe's spend counter and anything a module opens land there, not in data/.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-live-smoke-'))
  const prevCwd = process.cwd()
  process.chdir(work)
  fs.mkdirSync('data', { recursive: true })
  // Local servers are honoured only while "the site" is local-only, exactly as on the site.
  if ((process.env.AI_LOCAL_PROVIDER_ORIGINS || '').trim() && !process.env.SITE_URL) process.env.SITE_URL = 'http://127.0.0.1'
  // The SDK reads a few variables whatever its options say; the adapter refuses ANTHROPIC_CUSTOM_HEADERS itself.
  let mods
  try {
    mods = {
      keys: await import(path.join(ROOT, 'lib/ai/providers/keys.ts')),
      presets: await import(path.join(ROOT, 'lib/ai/presets.ts')),
      factory: await import(path.join(ROOT, 'lib/ai/providers/factory.ts')),
      probe: await import(path.join(ROOT, 'lib/ai/providers/probe.ts')),
      runs: await import(path.join(ROOT, 'lib/ai/runs.ts')),
      scrub: await import(path.join(ROOT, 'lib/ai/scrub.ts')),
    }
  } catch (err) {
    process.chdir(prevCwd)
    fs.rmSync(work, { recursive: true, force: true })
    console.error('[ai-live-smoke] could not load the site modules: run it with `node --import ./tests/register.mjs` from the repository root, on Node 22.18 or later.')
    console.error(`[ai-live-smoke] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const rows = []
  try {
    for (const t of targets) {
      const preset = mods.presets.presetById(t.preset)
      if (!preset) {
        rows.push({ preset: t.preset, model: t.model, status: 'not run', message: 'Unknown preset.' })
        continue
      }
      const apiKey = (process.env[envName(t.preset, 'KEY')] || '').trim() || null
      const resolved = mods.keys.resolveTarget({
        preset: t.preset,
        baseUrl: process.env[envName(t.preset, 'URL')],
        wire: process.env[envName(t.preset, 'WIRE')],
        workspaceId: process.env.AI_SMOKE_QWEN_WORKSPACE,
        region: process.env.AI_SMOKE_QWEN_REGION,
      })
      if (!resolved.ok) {
        rows.push({ preset: t.preset, model: t.model, status: 'not run', message: resolved.problem.error })
        continue
      }
      if (!apiKey && !preset.keyOptional) {
        rows.push({ preset: t.preset, model: t.model, status: 'not run', message: `No key: set ${envName(t.preset, 'KEY')}.` })
        continue
      }
      if (!real) {
        rows.push({ preset: t.preset, model: t.model, status: 'would probe', message: `${new URL(resolved.target.baseUrl).host}, key ${apiKey ? `from ${envName(t.preset, 'KEY')}` : 'none'}` })
        continue
      }
      const scrub = mods.scrub.createScrubber([apiKey])
      const quirks = mods.presets.quirksFor(preset)
      const adapter = mods.factory.createAdapter({ wire: resolved.target.wire, baseUrl: resolved.target.baseUrl, apiKey, quirks })
      let result
      try {
        result = await mods.probe.probeProvider({
          adapter,
          wire: resolved.target.wire,
          model: t.model,
          tools: mods.runs.assistantTools(),
          effort: resolved.target.wire === 'anthropic' ? 'medium' : null,
          maxOutputTokens: quirks.maxOutputTokens,
          signal: AbortSignal.timeout(180_000),
          providerId: null,
        })
      } catch (err) {
        result = { status: 'failed', message: err instanceof Error ? err.message : String(err), observations: {}, steps: [], display: null }
      }
      rows.push(scrub.value({ preset: t.preset, model: t.model, ...result }))
    }
  } finally {
    process.chdir(prevCwd)
    fs.rmSync(work, { recursive: true, force: true })
  }

  if (json) {
    for (const r of rows) console.log(JSON.stringify(r))
    return
  }
  const yes = (v) => (v === true ? 'yes' : v === false ? 'no' : v === undefined || v === null ? '-' : String(v))
  const header = ['preset', 'model', 'status', 'tools', 'args', 'reasoning', 'usage', 'cached', 'limit ok', 'display', 'ms']
  const lines = rows.map((r) => {
    const o = r.observations || {}
    return [r.preset, r.model, r.status, yes(o.toolsWork), yes(o.argsArrived), yes(o.reasoningSeen), yes(o.usageSeen), yes(o.cachedSeen), yes(o.outputLimitAccepted), yes(r.display), yes(o.elapsedMs)]
  })
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)))
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  console.log(fmt(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const l of lines) console.log(fmt(l))
  for (const r of rows) if (r.message) console.log(`\n${r.preset} ${r.model}: ${r.message}`)
  for (const r of rows) for (const s of r.steps || []) if (!s.ok && s.detail) console.log(`  ${r.preset} · ${s.step}: ${s.detail}`)
  if (!real) console.log('\nNothing was sent. Add --real to run these probes on your keys (real requests, real cost).')
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('[ai-live-smoke] failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
