/**
 * The assistant on a throw-away store (tests only): the editorial harness's
 * temp directory, AI access on, a key-encryption secret, SITE_URL on loopback
 * (the only state in which a local model provider is honoured) and
 * tests/helpers/fake-llm.mjs added as an ordinary Custom provider through
 * AI_LOCAL_PROVIDER_ORIGINS — the product's own path, no test branch.
 * Import it at the top of a test file; call setup() in before().
 */
import crypto from 'node:crypto'
import { editorialHarness } from '../editorialHarness'
import { startFakeLlm } from './fake-llm.mjs'

export const SITE = 'http://127.0.0.1:3999'
export const TEST_KEY = 'sk-test-assistant-0123456789abcdef'

export function assistantHarness(name: string) {
  const secret = `${name}-secret-0123456789abcdef0123456789`
  const h = editorialHarness(name, secret)
  const state: { fake: Awaited<ReturnType<typeof startFakeLlm>> | null; providerId: string; sessionId: string } = { fake: null, providerId: '', sessionId: '' }

  async function setup() {
    process.env.ADMIN_EMAIL = 'owner@example.test'
    process.env.ADMIN_PASS = `${name} synthetic password`
    process.env.SITE_URL = SITE
    process.env.AI_KEYS_SECRET = crypto.randomBytes(32).toString('base64')
    state.fake = await startFakeLlm()
    process.env.AI_LOCAL_PROVIDER_ORIGINS = state.fake.origin
    await h.setup()
    ;(await import('../../lib/admin')).ensureAdminFromEnv()
    const settings = await import('../../lib/ai/settings')
    settings.writeAiSettings({ enabled: true }, { steppedUp: true })
    state.providerId = await addFakeProvider('chat')
    // The first saved provider becomes the default, as the providers route does.
    ;(await import('../../lib/ai/providers/keys')).setDefaultProvider(state.providerId)
    const sessions = await import('../../lib/adminAuth/sessions')
    state.sessionId = sessions.createSession({ method: 'password', ttlMs: 3_600_000, device: 'Firefox on Linux', ipPrefix: '192.0.2.0/24', country: 'NL' }).id
  }

  /** A Custom provider pointing at the fake (wire chat or responses), saved like the owner saves one. */
  async function addFakeProvider(wire: 'chat' | 'responses', over: { defaultModel?: string; ownerQuirks?: Record<string, unknown>; label?: string; dialect?: string } = {}): Promise<string> {
    const keys = await import('../../lib/ai/providers/keys')
    const base = over.dialect ? state.fake!.baseUrl(over.dialect) : state.fake!.baseUrl()
    const resolved = keys.resolveTarget({ preset: 'custom', wire, baseUrl: base })
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.problem))
    const made = keys.addProvider({ target: resolved.target, label: over.label ?? 'Test model (scripted)', apiKey: TEST_KEY, defaultModel: over.defaultModel ?? 'fake-model', effort: null, ownerQuirks: over.ownerQuirks ?? {} })
    if (!made.ok) throw new Error(made.error)
    return made.row.id
  }

  async function teardown() {
    const { resetBus } = await import('../../lib/ai/bus')
    resetBus()
    const { closeAuditDb } = await import('../../lib/audit/db')
    closeAuditDb()
    await state.fake?.close()
    for (const k of ['ADMIN_EMAIL', 'ADMIN_PASS', 'SITE_URL']) delete process.env[k]
    h.teardown()
  }

  return {
    h,
    setup,
    teardown,
    addFakeProvider,
    get fake() {
      return state.fake!
    },
    get providerId() {
      return state.providerId
    },
    get sessionId() {
      return state.sessionId
    },
    session() {
      return { id: state.sessionId, ipPrefix: '192.0.2.0/24', country: 'NL' }
    },
  }
}
