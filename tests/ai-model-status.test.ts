/**
 * M7 — a model whose stored key no longer opens is never shown as Ready
 * (design §7.4: a rotated AI_KEYS_SECRET, or a base URL changed in the
 * database, makes the key read "re-enter"). The trial walk (§13 security
 * check 10) changed a provider's address by hand: the row said "The key no
 * longer opens at this address" and Test was off, but its chip still read
 * READY and the status strip "fake-model · ready" — the last Test's word for a
 * model that can no longer run. Now the chip, the strip, the new-chat status
 * and the composer's model mark all say "Replace key".
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { assistantHarness } from './helpers/assistantHarness'
import { assistantTile, modelStatusOf, statusLabel, statusTone } from '../components/Admin/ai/assistantFormat'
import type { ProviderView } from '../components/Admin/ai/types'

const A = assistantHarness('ai-model-status')

before(() => A.setup())
after(() => A.teardown())

const view = (over: Partial<ProviderView>): ProviderView =>
  ({
    id: 'p1',
    preset: 'custom',
    presetName: 'Custom',
    label: 'Test model (scripted)',
    wire: 'chat',
    baseUrlHost: '127.0.0.1:3781',
    local: true,
    defaultModel: 'fake-model',
    effort: null,
    quirks: {},
    hasKey: true,
    keyHint: '••••0000',
    keyState: 'ok',
    status: 'ready',
    tests: { 'fake-model': { status: 'ready', at: 1, display: null, observations: {}, steps: [], message: null } },
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    ...over,
  }) as unknown as ProviderView

test('the browser: an unopenable key outranks the last Test, a keyless local model keeps its Test', () => {
  assert.equal(modelStatusOf(view({})), 'ready')
  assert.equal(modelStatusOf(view({ keyState: 'reenter' })), 'replace-key')
  assert.equal(modelStatusOf(view({ keyState: 'no-secret' })), 'replace-key')
  assert.equal(modelStatusOf(view({ keyState: 'none', hasKey: false })), 'ready')
  assert.equal(statusLabel('replace-key'), 'Replace key')
  assert.equal(statusTone('replace-key'), 'bad')
  assert.equal(assistantTile({ models: 1, defaultModel: { providerId: 'p1', label: 'Test model (scripted)', model: 'fake-model', status: 'replace-key' }, running: null, canStoreKeys: true }).sub, 'fake-model · replace key')
})

test('the server: the status strip’s summary says replace-key once the stored address no longer matches the sealed key, and ready again once it does', async () => {
  const { assistantSummary } = await import('../lib/ai/summary')
  const keys = await import('../lib/ai/providers/keys')
  const { getAuthDb } = await import('../lib/adminAuth/db')
  const id = A.providerId
  keys.recordTest(id, 'fake-model', { status: 'ready', at: Date.now(), display: null, observations: {}, steps: [], message: null } as never)
  assert.equal(assistantSummary().defaultModel?.status, 'ready')
  const db = getAuthDb()
  const original = (db.prepare('SELECT base_url FROM ai_provider_keys WHERE id = ?').get(id) as { base_url: string }).base_url
  db.prepare('UPDATE ai_provider_keys SET base_url = ? WHERE id = ?').run('http://127.0.0.1:9/v1', id)
  try {
    assert.equal(keys.keyState(keys.getProvider(id)!), 'reenter')
    assert.equal(assistantSummary().defaultModel?.status, 'replace-key')
  } finally {
    db.prepare('UPDATE ai_provider_keys SET base_url = ? WHERE id = ?').run(original, id)
  }
  assert.equal(assistantSummary().defaultModel?.status, 'ready')
})
