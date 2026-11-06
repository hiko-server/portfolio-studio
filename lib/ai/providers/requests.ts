import crypto from 'node:crypto'
import { parseOwnerQuirks, type OwnerQuirks } from '../presets'
import { cleanApiKey, cleanEffort, cleanModel, getProvider, resolveTarget, type ProviderRow, type StoredTest, type Target } from './keys'

/**
 * The two request shapes of "Check key" and "Test" (SERVER-ONLY, design
 * §7.7), never a mix:
 *
 *   { typedKey, preset, … }  Add a model, before Save: the key the owner just
 *                            typed, to the address the owner just chose. A
 *                            preset's host is a constant (no step-up); a
 *                            Custom URL needs a recent verification first,
 *                            or a stolen cookie would have an outbound HTTP
 *                            primitive.
 *   { providerId }           Re-test a saved key: it is opened with its own
 *                            stored, AAD-bound URL. Nothing in the request
 *                            can redirect it.
 *
 * So a stored key never reaches a request-supplied URL.
 */

const TYPED_KEYS = new Set(['typedKey', 'preset', 'baseUrl', 'wire', 'workspaceId', 'region', 'model', 'effort', 'quirks'])
const STORED_KEYS = new Set(['providerId', 'model'])

export type KeyShape =
  | { kind: 'stored'; row: ProviderRow; model: string | null }
  | { kind: 'typed'; target: Target; apiKey: string | null; model: string | null; effort: string | null; ownerQuirks: OwnerQuirks }

export type ShapeError = { status: number; code: string; field?: string; error: string }

export function parseKeyShape(body: unknown): { ok: true; shape: KeyShape } | { ok: false; problem: ShapeError } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, problem: { status: 400, code: 'INVALID', error: 'Send a JSON object.' } }
  const o = body as Record<string, unknown>
  const keys = Object.keys(o)
  const model = cleanModel(o.model)
  if (model === undefined && o.model !== undefined) return { ok: false, problem: { status: 400, code: 'INVALID', field: 'model', error: 'Not a model name.' } }
  if ('providerId' in o) {
    const extra = keys.find((k) => !STORED_KEYS.has(k))
    if (extra) return { ok: false, problem: { status: 400, code: 'INVALID', field: extra, error: 'A saved key is tested with its own stored address only.' } }
    const row = getProvider(o.providerId)
    if (!row) return { ok: false, problem: { status: 404, code: 'NOT_FOUND', error: 'No such provider.' } }
    return { ok: true, shape: { kind: 'stored', row, model: model ?? row.defaultModel } }
  }
  const extra = keys.find((k) => !TYPED_KEYS.has(k))
  if (extra) return { ok: false, problem: { status: 400, code: 'INVALID', field: extra, error: `Unknown field: ${extra}.` } }
  const resolved = resolveTarget({ preset: o.preset, baseUrl: o.baseUrl, wire: o.wire, workspaceId: o.workspaceId, region: o.region })
  if (!resolved.ok) return { ok: false, problem: { status: resolved.problem.code === 'LOCAL_NOT_ALLOWED' ? 409 : 400, ...resolved.problem } }
  const typed = o.typedKey === undefined || o.typedKey === '' ? null : cleanApiKey(o.typedKey)
  if (o.typedKey !== undefined && o.typedKey !== '' && typed === null) return { ok: false, problem: { status: 400, code: 'INVALID', field: 'typedKey', error: 'That does not look like an API key.' } }
  if (typed === null && !resolved.target.preset.keyOptional) return { ok: false, problem: { status: 400, code: 'INVALID', field: 'typedKey', error: 'Enter the API key.' } }
  const effort = o.effort === undefined ? null : cleanEffort(o.effort)
  if (effort === undefined) return { ok: false, problem: { status: 400, code: 'INVALID', field: 'effort', error: 'Not an effort level.' } }
  const quirks = parseOwnerQuirks(o.quirks)
  if (!quirks.ok) return { ok: false, problem: { status: 400, code: 'INVALID', field: quirks.field, error: 'Not a setting this key takes.' } }
  return { ok: true, shape: { kind: 'typed', target: resolved.target, apiKey: typed, model: model ?? null, effort, ownerQuirks: quirks.quirks } }
}

// ── A Test run before Save, kept so Save can carry its result ─────────────
//
// The browser never hands a test result to the server (it could say
// anything): the server keeps what it measured itself, for ten minutes, under
// a hash of exactly what was tested — preset, wire, address, model and the
// key's own hash. Save looks it up with the same inputs.

const TYPED_TTL_MS = 10 * 60_000
const TYPED_MAX = 20

type ProbeGlobal = typeof globalThis & { __aiTypedProbes?: Map<string, { at: number; result: StoredTest }> }
const pg = globalThis as ProbeGlobal
const typedProbes = () => (pg.__aiTypedProbes ??= new Map())

export function typedProbeKey(target: Target, apiKey: string | null, model: string): string {
  const keyHash = apiKey ? crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex') : ''
  return crypto.createHash('sha256').update(JSON.stringify([target.preset.id, target.wire, target.baseUrl, model, keyHash])).digest('hex')
}

export function rememberTypedProbe(key: string, result: StoredTest, now = Date.now()): void {
  const m = typedProbes()
  for (const [k, v] of m) if (now - v.at > TYPED_TTL_MS) m.delete(k)
  while (m.size >= TYPED_MAX) m.delete(m.keys().next().value as string)
  m.set(key, { at: now, result })
}

export function takeTypedProbe(key: string, now = Date.now()): StoredTest | null {
  const m = typedProbes()
  const hit = m.get(key)
  if (!hit) return null
  m.delete(key)
  return now - hit.at > TYPED_TTL_MS ? null : hit.result
}
