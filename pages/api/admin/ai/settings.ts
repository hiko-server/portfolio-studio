import type { NextApiRequest, NextApiResponse } from 'next'
import { withApi } from '../../../../lib/apiHandler'
import { readAdminContext, requestOrigin } from '../../../../lib/auth'
import { requireRecentAuth, stepUpRequired } from '../../../../lib/adminAuth/stepUp'
import { recordAuthEvent } from '../../../../lib/adminAuth/store'
import { recordAdminAudit } from '../../../../lib/audit/record'
import { log } from '../../../../lib/log'
import { revokeGrants } from '../../../../lib/ai/access'
import { aiAlert } from '../../../../lib/ai/alerts'
import { voidOpenChanges, type VoidReason } from '../../../../lib/ai/changes'
import { looseningFields, parseSettingsPatch, readAiSettings, writeAiSettings, type AiSettings } from '../../../../lib/ai/settings'
import { stopAllRuns } from '../../../../lib/ai/runs'
import { accessState } from '../../../../lib/ai/summary'

/**
 * AI access switches (admin only, never cached; design §5.2).
 *
 *   GET   → { access, settings }
 *   PATCH { enabled?, mcpEnabled?, autoApplyDrafts?, keepConversationsDays?,
 *           dailyTokenLimit?, endApps? }
 *         → { access, settings, endedApps, endAppsError, voided }
 *
 * Tightening is free; loosening (turning a switch on, keeping conversations
 * longer, a higher daily limit) needs a recent verification
 * (requireRecentAuth: 403 STEP_UP_REQUIRED, the admin asks and retries).
 * lib/ai/settings refuses a loosening write on its own when the route did not
 * check, so a race cannot slip one through.
 *
 * Turning AI access off is instant, stops a running assistant and withdraws
 * every change still waiting for the owner or sitting in an editor. `endApps: true`, sent with turning
 * AI access or connected apps off, also revokes every connected app (their
 * tokens never work again; without it they resume when access is turned back
 * on). Turning either switch on mails the owner (lib/ai/alerts, once a day).
 * Every change goes to the activity log (area "ai"); ended apps also to the
 * sign-in history.
 *
 * The switch is written first and stays as written. When revoking the apps
 * then fails, the answer is still 200 with the stored state and
 * `endAppsError: true` (Connections warns: the apps are refused while the
 * switch is off, and resume if it is turned back on before they are
 * revoked), and the activity log says the revoke failed.
 */

type Body = Record<string, unknown>

function settingsView(s: AiSettings) {
  return {
    enabled: s.enabled,
    mcpEnabled: s.mcpEnabled,
    autoApplyDrafts: s.autoApplyDrafts,
    keepConversationsDays: s.keepConversationsDays,
    dailyTokenLimit: s.dailyTokenLimit,
  }
}

/** Void open changes; a broken ai.db never blocks turning access off (approval re-checks the issuer anyway). */
function voidSafely(which: Parameters<typeof voidOpenChanges>[0], reason: VoidReason): number {
  try {
    return voidOpenChanges(which, reason)
  } catch (err) {
    log.error('AI changes could not be withdrawn', { reason, err })
    return 0
  }
}

function patchSettings(req: NextApiRequest, res: NextApiResponse) {
  const raw = req.body
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ code: 'INVALID', error: 'Send a JSON object.' })
  const { endApps, ...rest } = raw as Body
  if (endApps !== undefined && typeof endApps !== 'boolean') return res.status(400).json({ code: 'INVALID', field: 'endApps', error: 'endApps is true or false.' })
  const parsed = parseSettingsPatch(rest)
  if (!parsed.ok) return res.status(400).json({ code: 'INVALID', field: parsed.field, error: `Not a setting, or out of range: ${parsed.field}.` })
  const { patch } = parsed
  if (endApps === true && patch.enabled !== false && patch.mcpEnabled !== false) {
    return res.status(400).json({ code: 'INVALID', field: 'endApps', error: 'endApps goes with turning AI access or connected apps off.' })
  }
  let current: AiSettings
  try {
    current = readAiSettings()
  } catch (err) {
    log.error('AI settings unreadable', { err })
    return res.status(503).json({ code: 'UNAVAILABLE', error: 'The AI settings cannot be read right now.' })
  }

  const loosens = looseningFields(current, patch).length > 0
  if (loosens) {
    if (!requireRecentAuth(req, res)) return
  }
  const written = writeAiSettings(patch, { steppedUp: loosens })
  if (!written.ok) {
    if (written.code === 'STEP_UP_REQUIRED') return stepUpRequired(res)
    return res.status(400).json({ code: 'INVALID', field: written.field, error: `Not a setting, or out of range: ${written.field}.` })
  }

  const { before, after } = written
  const origin = requestOrigin(req)
  const ctx = readAdminContext(req, res)
  let voided = 0
  let ended: string[] = []
  let endAppsError = false
  if (before.enabled && !after.enabled) {
    voided += voidSafely({ all: true }, 'ACCESS_OFF')
    // Off aborts a running assistant at once (its watchdog would within a second anyway).
    stopAllRuns('access-off')
  }
  if (endApps === true) {
    try {
      ended = revokeGrants({ all: true }, after.enabled ? 'ended with connected apps' : 'ended with AI access')
    } catch (err) {
      // The switch is already off and stays off: say so, rather than a 500 that contradicts the stored state.
      log.error('Connected apps could not be revoked with the switch', { err })
      endAppsError = true
    }
    if (ended.length) {
      voided += voidSafely({ actorIds: ended }, 'ISSUER_ENDED')
      try {
        recordAuthEvent({ type: 'ai-apps-ended', sessionId: ctx?.session?.id ?? null, detail: `${ended.length} revoked when ${after.enabled ? 'connected apps were stopped' : 'AI access was turned off'}`, ...origin })
      } catch (err) {
        log.error('Ended AI apps could not be noted in the sign-in history', { err })
      }
    }
  }

  const endedNote = ended.length
    ? ` and ended ${ended.length === 1 ? 'the connected app' : `all ${ended.length} connected apps`}`
    : endAppsError
      ? '; revoking the connected apps failed'
      : ''
  if (!before.enabled && after.enabled) {
    recordAdminAudit(req, res, { action: 'ai.enable', area: 'ai', summary: 'Turned on AI access' })
    aiAlert({ type: 'enabled' })
  }
  if (before.enabled && !after.enabled) recordAdminAudit(req, res, { action: 'ai.disable', area: 'ai', summary: `Turned off AI access${endedNote}` })
  if (!before.mcpEnabled && after.mcpEnabled) {
    recordAdminAudit(req, res, { action: 'ai.apps-allow', area: 'ai', summary: 'Allowed connected apps' })
    aiAlert({ type: 'apps-allowed' })
  }
  if (before.mcpEnabled && !after.mcpEnabled) {
    recordAdminAudit(req, res, { action: 'ai.apps-stop', area: 'ai', summary: `Stopped connected apps${before.enabled && !after.enabled ? '' : endedNote}` })
  }
  const others = (['autoApplyDrafts', 'keepConversationsDays', 'dailyTokenLimit'] as const).filter((k) => before[k] !== after[k])
  if (others.length) recordAdminAudit(req, res, { action: 'ai.settings', area: 'ai', summary: 'Changed the AI assistant’s settings' })

  return res.status(200).json({ access: accessState(), settings: settingsView(after), endedApps: ended.length, endAppsError, voided })
}

export default withApi('admin/ai/settings', (req, res) => {
  const ctx = readAdminContext(req, res)
  if (!ctx) return res.status(401).json({ code: 'NO_SESSION', error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET') {
    let settings: ReturnType<typeof settingsView> | null = null
    try {
      settings = settingsView(readAiSettings())
    } catch (err) {
      log.error('AI settings unreadable', { err })
    }
    return res.status(200).json({ access: accessState(), settings })
  }
  if (req.method === 'PATCH') return patchSettings(req, res)
  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'Method not allowed' })
})
