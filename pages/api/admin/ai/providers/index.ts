import type { NextApiRequest, NextApiResponse } from 'next'
import { withApi } from '../../../../../lib/apiHandler'
import { readAdminContext } from '../../../../../lib/auth'
import { requireRecentAuth } from '../../../../../lib/adminAuth/stepUp'
import { recordAdminAudit } from '../../../../../lib/audit/record'
import { log } from '../../../../../lib/log'
import { aiAlert } from '../../../../../lib/ai/alerts'
import { CUSTOM_TRUST_LINE, EFFORTS, KEY_ADVICE, MAX_OUTPUT_TOKENS_LIMIT, MIN_OUTPUT_TOKENS, parseOwnerQuirks, PRESETS } from '../../../../../lib/ai/presets'
import { anthropicEnvProblem } from '../../../../../lib/ai/providers/env'
import {
  addProvider,
  cleanApiKey,
  cleanEffort,
  cleanLabel,
  cleanModel,
  defaultProviderId,
  getProvider,
  listProviders,
  presetOf,
  providerView,
  removeProvider,
  replaceKey,
  resolveTarget,
  setDefaultProvider,
  updateProvider,
} from '../../../../../lib/ai/providers/keys'
import { takeTypedProbe, typedProbeKey } from '../../../../../lib/ai/providers/requests'
import { aiKeysSecretStatus } from '../../../../../lib/ai/secretBox'
import { localProviderOrigins } from '../../../../../lib/ai/settings'

/**
 * The owner's model providers (admin only, never cached; design §7.3, §7.4).
 *
 *   GET                                  → { providers, presets, defaultProviderId, keys, ... }
 *   POST   { preset, apiKey?, label?, baseUrl?, wire?, workspaceId?, region?,
 *            defaultModel?, effort?, quirks?, makeDefault? }
 *                                        → 201 { provider }           step-up
 *   PATCH  { id, label?, defaultModel?, effort?, quirks?, makeDefault? }
 *                                        → { provider }
 *   PATCH  { id, apiKey, baseUrl?, … }   → { provider }               step-up (replace the key, maybe its address)
 *   DELETE { id }                        → { removed, revokeAt }
 *
 * A key is never returned: a view carries its last four characters and
 * whether it opens. Adding or replacing a key — and with it the address the
 * key goes to — needs a recent verification and mails the owner; renaming,
 * choosing a model or effort does not (none of them can send a key
 * elsewhere); removing never does (reducing access has no friction). The
 * address is never taken from anything but the owner's own entry here, and a
 * changed address needs the key typed again.
 */

type Body = Record<string, unknown>

const body = (req: NextApiRequest): Body => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Body) : {})

function presetsView() {
  const local = localProviderOrigins()
  return PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    wire: p.wire,
    hosts: p.baseUrls.map((u) => new URL(u).host),
    baseUrls: [...p.baseUrls],
    hostFromFields: p.hostFromFields ?? null,
    local: !!p.local,
    keyOptional: !!p.keyOptional,
    preselect: p.preselect ?? null,
    dataNote: p.dataNote,
    // A local preset can be added only while this site runs locally with its origin allowed.
    available: !p.local || p.baseUrls.some((u) => local.includes(new URL(u).origin)),
  }))
}

function list(res: NextApiResponse) {
  const defaultId = defaultProviderId()
  const secret = aiKeysSecretStatus()
  return res.status(200).json({
    providers: listProviders().map((r) => providerView(r, defaultId)),
    presets: presetsView(),
    defaultProviderId: defaultId,
    keys: { canStore: secret.state === 'ready', state: secret.state },
    claudeBlocked: anthropicEnvProblem(),
    localOrigins: localProviderOrigins(),
    efforts: [...EFFORTS],
    outputTokens: { min: MIN_OUTPUT_TOKENS, max: MAX_OUTPUT_TOKENS_LIMIT },
    copy: { customTrust: CUSTOM_TRUST_LINE, keyAdvice: KEY_ADVICE },
  })
}

function add(req: NextApiRequest, res: NextApiResponse) {
  const b = body(req)
  const resolved = resolveTarget({ preset: b.preset, baseUrl: b.baseUrl, wire: b.wire, workspaceId: b.workspaceId, region: b.region })
  if (!resolved.ok) return res.status(resolved.problem.code === 'LOCAL_NOT_ALLOWED' ? 409 : 400).json(resolved.problem)
  // Loosening: a new key, and a new place content can be sent to.
  if (!requireRecentAuth(req, res)) return
  const { target } = resolved
  const apiKey = b.apiKey === undefined || b.apiKey === '' ? null : cleanApiKey(b.apiKey)
  if (b.apiKey !== undefined && b.apiKey !== '' && apiKey === null) return res.status(400).json({ code: 'INVALID', field: 'apiKey', error: 'That does not look like an API key.' })
  const label = cleanLabel(b.label, target.preset.name)
  if (label === null) return res.status(400).json({ code: 'INVALID', field: 'label', error: 'A name is 1 to 60 characters on one line.' })
  const defaultModel = cleanModel(b.defaultModel)
  if (defaultModel === undefined && b.defaultModel !== undefined) return res.status(400).json({ code: 'INVALID', field: 'defaultModel', error: 'Not a model name.' })
  const effort = b.effort === undefined ? null : cleanEffort(b.effort)
  if (effort === undefined) return res.status(400).json({ code: 'INVALID', field: 'effort', error: 'Not an effort level.' })
  const quirks = parseOwnerQuirks(b.quirks)
  if (!quirks.ok) return res.status(400).json({ code: 'INVALID', field: quirks.field, error: 'Not a setting this key takes.' })
  // A Test this server ran on exactly this key, address and model (never a result the browser sends).
  const model = defaultModel ?? null
  const tested = model ? takeTypedProbe(typedProbeKey(target, apiKey, model)) : null
  const made = addProvider({ target, label, apiKey, defaultModel: model, effort, ownerQuirks: quirks.quirks, test: tested && model ? { model, result: tested } : null })
  if (!made.ok) return res.status(made.code === 'NO_SECRET' ? 409 : 400).json({ code: made.code, error: made.error })
  if (b.makeDefault === true || defaultProviderId() === null) setDefaultProvider(made.row.id)
  recordAdminAudit(req, res, { action: 'ai.provider-add', area: 'ai', target: target.preset.id, summary: `Added a model provider (${target.preset.name})` })
  aiAlert({ type: 'key-added' })
  return res.status(201).json({ provider: providerView(made.row, defaultProviderId()) })
}

function patch(req: NextApiRequest, res: NextApiResponse) {
  const b = body(req)
  const row = getProvider(b.id)
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such provider.' })

  if (b.apiKey !== undefined || b.baseUrl !== undefined || b.wire !== undefined || b.workspaceId !== undefined || b.region !== undefined) {
    // Replacing a key — and only then its address — is a loosening: step-up first.
    if (!requireRecentAuth(req, res)) return
    const apiKey = b.apiKey === undefined || b.apiKey === '' ? null : cleanApiKey(b.apiKey)
    if (b.apiKey !== undefined && b.apiKey !== '' && apiKey === null) return res.status(400).json({ code: 'INVALID', field: 'apiKey', error: 'That does not look like an API key.' })
    // A saved key is never carried to a new address: it is typed again (a keyless provider may stay keyless).
    if (apiKey === null && (row.sealed.cipher !== null || !presetOf(row).keyOptional)) {
      return res.status(400).json({ code: 'KEY_REQUIRED', field: 'apiKey', error: 'A new address needs the key typed again.' })
    }
    const moving = b.baseUrl !== undefined || b.wire !== undefined || b.workspaceId !== undefined || b.region !== undefined
    let target = null
    if (moving) {
      const resolved = resolveTarget({ preset: row.preset, baseUrl: b.baseUrl, wire: b.wire ?? row.wire, workspaceId: b.workspaceId, region: b.region })
      if (!resolved.ok) return res.status(resolved.problem.code === 'LOCAL_NOT_ALLOWED' ? 409 : 400).json(resolved.problem)
      target = resolved.target
    }
    const replaced = replaceKey(row.id, apiKey, target)
    if (!replaced.ok) return res.status(replaced.code === 'NO_SECRET' ? 409 : replaced.code === 'NOT_FOUND' ? 404 : 400).json({ code: replaced.code, error: replaced.error })
    recordAdminAudit(req, res, { action: 'ai.provider-key', area: 'ai', target: row.preset, summary: target ? `Replaced a model provider’s key and address (${presetOf(row).name})` : `Replaced a model provider’s key (${presetOf(row).name})` })
    aiAlert({ type: 'key-added' })
    return res.status(200).json({ provider: providerView(replaced.row, defaultProviderId()) })
  }

  const label = b.label === undefined ? undefined : cleanLabel(b.label, row.label)
  if (label === null) return res.status(400).json({ code: 'INVALID', field: 'label', error: 'A name is 1 to 60 characters on one line.' })
  const defaultModel = b.defaultModel === undefined ? undefined : cleanModel(b.defaultModel)
  if (b.defaultModel !== undefined && defaultModel === undefined) return res.status(400).json({ code: 'INVALID', field: 'defaultModel', error: 'Not a model name.' })
  const effort = b.effort === undefined ? undefined : cleanEffort(b.effort)
  if (b.effort !== undefined && effort === undefined) return res.status(400).json({ code: 'INVALID', field: 'effort', error: 'Not an effort level.' })
  const quirks = b.quirks === undefined ? null : parseOwnerQuirks(b.quirks)
  if (quirks && !quirks.ok) return res.status(400).json({ code: 'INVALID', field: quirks.field, error: 'Not a setting this key takes.' })
  if (b.makeDefault !== undefined && typeof b.makeDefault !== 'boolean') return res.status(400).json({ code: 'INVALID', field: 'makeDefault', error: 'makeDefault is true or false.' })
  const next = updateProvider(row.id, { label, defaultModel, effort, ownerQuirks: quirks && quirks.ok ? quirks.quirks : undefined })
  if (!next) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such provider.' })
  if (b.makeDefault === true) setDefaultProvider(row.id)
  else if (b.makeDefault === false && defaultProviderId() === row.id) setDefaultProvider(null)
  recordAdminAudit(req, res, { action: 'ai.provider-edit', area: 'ai', target: row.preset, summary: `Changed a model provider’s settings (${presetOf(row).name})` })
  return res.status(200).json({ provider: providerView(next, defaultProviderId()) })
}

function remove(req: NextApiRequest, res: NextApiResponse) {
  const b = body(req)
  const row = getProvider(b.id)
  if (!row) return res.status(404).json({ code: 'NOT_FOUND', error: 'No such provider.' })
  const removed = removeProvider(row.id)
  if (removed) recordAdminAudit(req, res, { action: 'ai.provider-remove', area: 'ai', target: row.preset, summary: `Removed a model provider (${presetOf(row).name})` })
  // The key is gone from this server; at the provider it is still valid until the owner revokes it there.
  return res.status(200).json({ removed, revokeAt: presetOf(row).name })
}

export default withApi('admin/ai/providers', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'GET') return list(res)
    if (req.method === 'POST') return add(req, res)
    if (req.method === 'PATCH') return patch(req, res)
    if (req.method === 'DELETE') return remove(req, res)
  } catch (err) {
    log.error('AI providers request failed', { method: req.method, err })
    return res.status(503).json({ code: 'UNAVAILABLE', error: 'The model providers cannot be read or changed right now.' })
  }
  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
