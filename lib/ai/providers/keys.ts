import crypto from 'node:crypto'
import { getAuthDb } from '../../adminAuth/db'
import { DEFAULT_CLAUDE_EFFORT, parseOwnerQuirks, presetById, qwenBaseUrl, quirksFor, type OwnerQuirks, type Preset, type PresetId, type Quirks } from '../presets'
import { canonicalBaseUrl, openProviderKey, sealProviderKey, SecretBoxError, API_KEY_MAX, type SealedKey } from '../secretBox'
import { exactOrigin } from '../../security/origin'
import { localProviderOrigins } from '../settings'
import { ANTHROPIC_BASE } from './anthropic'
import type { Wire } from './types'

/**
 * The owner's model providers (SERVER-ONLY, design §7.4, §7.6): rows of
 * auth.db `ai_provider_keys`, each key sealed with AES-256-GCM to its row id,
 * preset and canonical base URL (lib/ai/secretBox). So:
 *
 *   - a key is opened per call and never cached, never returned, never put
 *     in the environment; a view carries only its last four characters;
 *   - a database edit that points a row at another URL makes the key fail
 *     to open ("Re-enter key") instead of sending it somewhere new;
 *   - the URL is set only here, by the owner, at key entry (step-up in the
 *     route); changing it means typing the key again. It is never a tool
 *     argument, never read from a page or a tool result.
 *
 * Which URLs a provider may use (§7.6): an official preset host (a
 * constant), Qwen's host built from two `^[a-z0-9-]+$` fields, an exact
 * local origin from AI_LOCAL_PROVIDER_ORIGINS while the site is local-only,
 * or — Custom only — an https URL on port 443 whose host is a name, with no
 * userinfo, query or fragment. Addresses are vetted on every request by the
 * transport (lib/security/safeFetch).
 */

export const PROVIDER_ID_RE = /^p[A-Za-z0-9_-]{8,64}$/
export const LABEL_MAX = 60
export const MODEL_MAX = 200
const EFFORT_RE = /^[a-z][a-z0-9_-]{0,15}$/
/** Models whose last Test result a row keeps. */
const TESTS_KEPT = 20

export type ProbeStatus = 'ready' | 'chat-only' | 'schema-refused' | 'key-refused' | 'failed'

/** One model's last Test (lib/ai/providers/probe), as stored in test_json: redacted, plain text only. */
export type StoredTest = {
  status: ProbeStatus
  at: number
  /** Claude only: the thinking display the API accepted. */
  display: 'updates' | 'omitted' | null
  /** Claude only: what the Models API said the model takes. */
  claude: { effort: boolean; adaptiveThinking: boolean; fallbacks: boolean; maxOutputTokens: number | null; imageInput?: boolean | null; pdfInput?: boolean | null } | null
  observations: Record<string, boolean | number | string | null>
  steps: Array<{ step: string; ok: boolean; detail: string | null }>
  message: string | null
}

export type ProviderRow = {
  id: string
  preset: PresetId
  label: string
  wire: Wire
  baseUrl: string
  defaultModel: string | null
  effort: string | null
  ownerQuirks: OwnerQuirks
  sealed: { cipher: Buffer | null; nonce: Buffer | null; kid: number }
  keyHint: string | null
  tests: Record<string, StoredTest>
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

type DbRow = {
  id: string
  preset: string
  label: string
  wire: Wire
  base_url: string
  default_model: string | null
  effort: string | null
  quirks_json: string
  key_cipher: Buffer | null
  key_nonce: Buffer | null
  key_kid: number
  key_hint: string | null
  test_json: string | null
  created_at: number
  updated_at: number
  last_used_at: number | null
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function fromDb(r: DbRow): ProviderRow {
  const owner = parseOwnerQuirks(parseJson<unknown>(r.quirks_json, {}))
  return {
    id: r.id,
    preset: r.preset as PresetId,
    label: r.label,
    wire: r.wire,
    baseUrl: r.base_url,
    defaultModel: r.default_model,
    effort: r.effort,
    ownerQuirks: owner.ok ? owner.quirks : {},
    sealed: { cipher: r.key_cipher, nonce: r.key_nonce, kid: r.key_kid },
    keyHint: r.key_hint,
    tests: parseJson<Record<string, StoredTest>>(r.test_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
  }
}

export function getProvider(id: unknown): ProviderRow | null {
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) return null
  const r = getAuthDb().prepare('SELECT * FROM ai_provider_keys WHERE id = ?').get(id) as DbRow | undefined
  return r ? fromDb(r) : null
}

export function listProviders(): ProviderRow[] {
  return (getAuthDb().prepare('SELECT * FROM ai_provider_keys ORDER BY created_at ASC').all() as DbRow[]).map(fromDb)
}

export function presetOf(row: Pick<ProviderRow, 'preset'>): Preset {
  const p = presetById(row.preset)
  if (!p) throw new Error('Unknown provider preset')
  return p
}

export function quirksOf(row: ProviderRow): Quirks {
  return quirksFor(presetOf(row), row.ownerQuirks)
}

// ── Where a provider may be reached ───────────────────────────────────────

export type TargetInput = {
  preset: unknown
  /** Custom, local presets, and a preset's alternative host: the URL the owner chose. */
  baseUrl?: unknown
  /** Custom only: which wire the endpoint speaks. */
  wire?: unknown
  /** Qwen only. */
  workspaceId?: unknown
  region?: unknown
}

export type Target = { preset: Preset; wire: Wire; baseUrl: string; local: boolean; custom: boolean }

export type TargetProblem = { code: 'INVALID'; field: string; error: string } | { code: 'LOCAL_NOT_ALLOWED'; field: string; error: string }

/** A custom endpoint's URL by the rules of §7.6, or why not. */
export function customUrlProblem(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'Not a URL.'
  }
  if (u.protocol !== 'https:') return 'Use an https address.'
  if (u.username || u.password) return 'No user name or password in the address.'
  if (u.search || u.hash || /[?#]/.test(raw)) return 'No query or fragment in the address.'
  if (u.port && u.port !== '443') return 'Only port 443.'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(host) || host.includes(':')) return 'Use a host name, not an IP address.'
  if (!host.includes('.')) return 'Use a full host name.'
  return null
}

/** Is `url`'s origin one of AI_LOCAL_PROVIDER_ORIGINS (honoured only while the site is local-only)? */
function isAllowedLocal(url: string): boolean {
  let origin: string | null
  try {
    origin = exactOrigin(new URL(url).origin)
  } catch {
    return false
  }
  return !!origin && localProviderOrigins().includes(origin)
}

/** Resolve where a new key will be used. Never reads a stored row: only the owner's own entry. */
export function resolveTarget(input: TargetInput): { ok: true; target: Target } | { ok: false; problem: TargetProblem } {
  const preset = presetById(input.preset)
  if (!preset) return { ok: false, problem: { code: 'INVALID', field: 'preset', error: 'Choose a provider.' } }
  const given = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : null
  const bad = (field: string, error: string) => ({ ok: false as const, problem: { code: 'INVALID' as const, field, error } })

  if (preset.hostFromFields === 'qwen') {
    const url = qwenBaseUrl(String(input.workspaceId ?? ''), String(input.region ?? ''))
    if (!url) return bad('workspaceId', 'Workspace ID and region are lower-case letters, digits and hyphens.')
    return { ok: true, target: { preset, wire: 'chat', baseUrl: url, local: false, custom: false } }
  }
  if (preset.id === 'custom') {
    if (input.wire !== 'chat' && input.wire !== 'responses') return bad('wire', 'Choose Chat Completions or Responses.')
    if (!given) return bad('baseUrl', 'Enter the base URL.')
    const canonical = canonicalBaseUrl(given)
    if (!canonical) return bad('baseUrl', 'Not a usable URL.')
    if (isAllowedLocal(canonical)) return { ok: true, target: { preset, wire: input.wire, baseUrl: canonical, local: true, custom: true } }
    const problem = customUrlProblem(given)
    if (problem) {
      const local = /^http:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(given)
      if (local) return { ok: false, problem: { code: 'LOCAL_NOT_ALLOWED', field: 'baseUrl', error: 'A local server works only while this site runs locally, for an origin listed in AI_LOCAL_PROVIDER_ORIGINS.' } }
      return bad('baseUrl', problem)
    }
    return { ok: true, target: { preset, wire: input.wire, baseUrl: canonical, local: false, custom: true } }
  }
  if (preset.local) {
    const canonical = canonicalBaseUrl(given ?? preset.baseUrls[0])
    if (!canonical || !isAllowedLocal(canonical)) {
      return { ok: false, problem: { code: 'LOCAL_NOT_ALLOWED', field: 'baseUrl', error: 'A local server works only while this site runs locally, for an origin listed in AI_LOCAL_PROVIDER_ORIGINS.' } }
    }
    return { ok: true, target: { preset, wire: preset.wire as Wire, baseUrl: canonical, local: true, custom: false } }
  }
  // An official preset: one of its constant hosts, nothing else.
  const choices = preset.baseUrls.map((u) => canonicalBaseUrl(u) as string)
  const chosen = given ? canonicalBaseUrl(given) : choices[0]
  if (!chosen || !choices.includes(chosen)) return bad('baseUrl', `${preset.name} is reached at ${choices.join(' or ')}.`)
  return { ok: true, target: { preset, wire: preset.wire as Wire, baseUrl: chosen, local: false, custom: false } }
}

// ── Owner fields ──────────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

export function cleanLabel(raw: unknown, fallback: string): string | null {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > LABEL_MAX || CONTROL.test(v)) return null
  return v
}

export function cleanModel(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  if (!v || v.length > MODEL_MAX || CONTROL.test(v) || /\s/.test(v)) return undefined
  return v
}

export function cleanEffort(raw: unknown): string | null | undefined {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string' || !EFFORT_RE.test(raw)) return undefined
  return raw
}

/** A typed API key as the provider will receive it, or null when it cannot be one. */
export function cleanApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (!v || v.length > API_KEY_MAX || /[\s\u0000-\u001f\u007f]/.test(v)) return null
  return v
}

export const newProviderId = () => `p${crypto.randomBytes(12).toString('base64url')}`

// ── Writes (the route checks the step-up first) ───────────────────────────

export type AddProvider = {
  target: Target
  label: string
  apiKey: string | null
  defaultModel: string | null
  effort: string | null
  ownerQuirks: OwnerQuirks
  /** The Test the owner ran before saving, if any (kept as the model's last result). */
  test?: { model: string; result: StoredTest } | null
}

export type WriteResult = { ok: true; row: ProviderRow } | { ok: false; code: 'NO_SECRET' | 'BAD_KEY' | 'KEY_REQUIRED' | 'NOT_FOUND'; error: string }

function seal(apiKey: string | null, row: { id: string; preset: string; baseUrl: string }): { ok: true; sealed: SealedKey | null } | { ok: false; code: 'NO_SECRET' | 'BAD_KEY'; error: string } {
  if (apiKey === null) return { ok: true, sealed: null }
  try {
    return { ok: true, sealed: sealProviderKey(apiKey, row) }
  } catch (err) {
    if (err instanceof SecretBoxError && err.code === 'NO_SECRET') return { ok: false, code: 'NO_SECRET', error: 'This server cannot store keys: its key-encryption secret is not set. System health says how to set it.' }
    return { ok: false, code: 'BAD_KEY', error: 'That does not look like an API key.' }
  }
}

function testsJson(tests: Record<string, StoredTest>): string {
  const entries = Object.entries(tests).sort((a, b) => b[1].at - a[1].at).slice(0, TESTS_KEPT)
  return JSON.stringify(Object.fromEntries(entries))
}

export function addProvider(input: AddProvider, now = Date.now()): WriteResult {
  const { target } = input
  if (input.apiKey === null && !target.preset.keyOptional) return { ok: false, code: 'KEY_REQUIRED', error: 'Enter the API key.' }
  const id = newProviderId()
  const sealedOr = seal(input.apiKey, { id, preset: target.preset.id, baseUrl: target.baseUrl })
  if (!sealedOr.ok) return sealedOr
  const sealed = sealedOr.sealed
  const effort = input.effort ?? (target.wire === 'anthropic' ? DEFAULT_CLAUDE_EFFORT : null)
  const tests = input.test ? { [input.test.model]: input.test.result } : {}
  getAuthDb()
    .prepare(
      `INSERT INTO ai_provider_keys (id, preset, label, wire, base_url, default_model, effort, quirks_json, key_cipher, key_nonce, key_kid, key_hint, test_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      target.preset.id,
      input.label,
      target.wire,
      target.baseUrl,
      input.defaultModel,
      effort,
      JSON.stringify(input.ownerQuirks),
      sealed?.cipher ?? null,
      sealed?.nonce ?? null,
      sealed?.kid ?? 1,
      sealed?.hint ?? null,
      Object.keys(tests).length ? testsJson(tests) : null,
      now,
      now,
    )
  return { ok: true, row: getProvider(id) as ProviderRow }
}

/** Replace a key, optionally at a new address (the address changes only with a key typed again). */
export function replaceKey(id: string, apiKey: string | null, target: Target | null, now = Date.now()): WriteResult {
  const row = getProvider(id)
  if (!row) return { ok: false, code: 'NOT_FOUND', error: 'No such provider.' }
  const preset = presetOf(row)
  const baseUrl = target ? target.baseUrl : row.baseUrl
  if (apiKey === null && !preset.keyOptional) return { ok: false, code: 'KEY_REQUIRED', error: 'Enter the API key.' }
  const sealedOr = seal(apiKey, { id, preset: row.preset, baseUrl })
  if (!sealedOr.ok) return sealedOr
  const sealed = sealedOr.sealed
  getAuthDb()
    .prepare('UPDATE ai_provider_keys SET base_url = ?, wire = ?, key_cipher = ?, key_nonce = ?, key_kid = ?, key_hint = ?, test_json = NULL, updated_at = ? WHERE id = ?')
    .run(baseUrl, target ? target.wire : row.wire, sealed?.cipher ?? null, sealed?.nonce ?? null, sealed?.kid ?? 1, sealed?.hint ?? null, now, id)
  return { ok: true, row: getProvider(id) as ProviderRow }
}

/** Label, default model, effort, owner quirks: none of them can redirect a key, so none needs a step-up. */
export function updateProvider(id: string, patch: { label?: string; defaultModel?: string | null; effort?: string | null; ownerQuirks?: OwnerQuirks }, now = Date.now()): ProviderRow | null {
  const row = getProvider(id)
  if (!row) return null
  const next = {
    label: patch.label ?? row.label,
    defaultModel: patch.defaultModel !== undefined ? patch.defaultModel : row.defaultModel,
    effort: patch.effort !== undefined ? patch.effort : row.effort,
    quirks: patch.ownerQuirks ? { ...row.ownerQuirks, ...patch.ownerQuirks } : row.ownerQuirks,
  }
  getAuthDb()
    .prepare('UPDATE ai_provider_keys SET label = ?, default_model = ?, effort = ?, quirks_json = ?, updated_at = ? WHERE id = ?')
    .run(next.label, next.defaultModel, next.effort, JSON.stringify(next.quirks), now, id)
  return getProvider(id)
}

/** Remove a provider (no step-up: it only reduces access). Clears it as the default. */
export function removeProvider(id: string): boolean {
  const db = getAuthDb()
  return db.transaction(() => {
    const changed = db.prepare('DELETE FROM ai_provider_keys WHERE id = ?').run(id).changes > 0
    if (changed) db.prepare('UPDATE ai_settings SET default_provider_id = NULL WHERE id = 1 AND default_provider_id = ?').run(id)
    return changed
  })()
}

export function recordTest(id: string, model: string, result: StoredTest): void {
  const row = getProvider(id)
  if (!row) return
  getAuthDb().prepare('UPDATE ai_provider_keys SET test_json = ? WHERE id = ?').run(testsJson({ ...row.tests, [model]: result }), id)
}

/** last_used_at, written at most once a minute. */
export function touchProvider(id: string, now = Date.now()): void {
  getAuthDb().prepare('UPDATE ai_provider_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)').run(now, id, now - 60_000)
}

export function defaultProviderId(): string | null {
  const r = getAuthDb().prepare('SELECT default_provider_id AS id FROM ai_settings WHERE id = 1').get() as { id: string | null } | undefined
  return r?.id ?? null
}

/** Choose the assistant's default provider (any saved row, or none). */
export function setDefaultProvider(id: string | null): boolean {
  if (id !== null && !getProvider(id)) return false
  getAuthDb().prepare('UPDATE ai_settings SET default_provider_id = ? WHERE id = 1').run(id)
  return true
}

// ── Opening a key for one call ────────────────────────────────────────────

export type OpenedRowKey = { ok: true; apiKey: string | null } | { ok: false; reason: 'no-secret' | 'reenter' }

/**
 * The row's key, opened for one call with the row's own stored, AAD-bound
 * URL. Null for a keyless local server. Nothing in a request can choose
 * where it goes.
 */
export function openRowKey(row: ProviderRow): OpenedRowKey {
  if (!row.sealed.cipher) {
    // A keyless row is only legitimate for presets that allow it.
    return presetOf(row).keyOptional ? { ok: true, apiKey: null } : { ok: false, reason: 'reenter' }
  }
  if (row.wire === 'anthropic' && canonicalBaseUrl(row.baseUrl) !== ANTHROPIC_BASE) return { ok: false, reason: 'reenter' }
  const opened = openProviderKey(row.sealed, { id: row.id, preset: row.preset, baseUrl: row.baseUrl })
  return opened.ok ? { ok: true, apiKey: opened.apiKey } : opened
}

export type KeyState = 'ok' | 'none' | 'reenter' | 'no-secret'

/** What the admin may know about a stored key: never the key. */
export function keyState(row: ProviderRow): KeyState {
  if (!row.sealed.cipher) return presetOf(row).keyOptional ? 'none' : 'reenter'
  const opened = openRowKey(row)
  return opened.ok ? 'ok' : opened.reason
}

/** The model's last Test as the UI shows it ("Untested" when none passed through here). */
export function statusOf(row: ProviderRow, model: string | null): ProbeStatus | 'untested' {
  if (!model) return 'untested'
  return row.tests[model]?.status ?? 'untested'
}

export type ProviderView = {
  id: string
  preset: PresetId
  presetName: string
  label: string
  wire: Wire
  baseUrlHost: string
  local: boolean
  defaultModel: string | null
  effort: string | null
  quirks: OwnerQuirks
  hasKey: boolean
  keyHint: string | null
  keyState: KeyState
  status: ProbeStatus | 'untested'
  tests: Record<string, Pick<StoredTest, 'status' | 'at' | 'display' | 'observations' | 'steps' | 'message'>>
  isDefault: boolean
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export function providerView(row: ProviderRow, defaultId: string | null): ProviderView {
  let host = ''
  try {
    host = new URL(row.baseUrl).host
  } catch {
    host = ''
  }
  const preset = presetOf(row)
  return {
    id: row.id,
    preset: row.preset,
    presetName: preset.name,
    label: row.label,
    wire: row.wire,
    baseUrlHost: host,
    local: !!preset.local || (preset.id === 'custom' && row.baseUrl.startsWith('http:')),
    defaultModel: row.defaultModel,
    effort: row.effort,
    quirks: row.ownerQuirks,
    hasKey: !!row.sealed.cipher,
    keyHint: row.keyHint,
    keyState: keyState(row),
    status: statusOf(row, row.defaultModel),
    tests: Object.fromEntries(Object.entries(row.tests).map(([m, t]) => [m, { status: t.status, at: t.at, display: t.display, observations: t.observations, steps: t.steps, message: t.message }])),
    isDefault: row.id === defaultId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  }
}

