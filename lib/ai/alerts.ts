import { readAdmin } from '../admin'
import { log } from '../log'
import { sendMail } from '../mailer'
import type { AccessEvent } from './access'
import { cleanLabelPart } from './audit'
import { getAiDb } from './db'

/**
 * Owner mail about AI access (SERVER-ONLY, design §5.4): a grant issued,
 * its first use, a country it was never seen from, a refused token that is
 * still being presented. At most one mail per grant, per kind of event, per
 * UTC day — counted in ai.db, so a restart does not reset it. No secret ever
 * goes into a mail: names, countries and reasons only.
 *
 * Imported by routes only (pages/api/mcp, the admin AI routes), never by the
 * tool layer: lib/ai/access reports events through a callback, so the tools'
 * import graph never reaches the mailer.
 */

const DAY = 86_400_000

const ALERT_TEXT: Record<AccessEvent['type'], { subject: (e: AccessEvent) => string; body: (e: AccessEvent) => string }> = {
  'grant-issued': {
    subject: (e) => `AI access: new connected app "${label(e)}"`,
    body: (e) => `A connected app named "${label(e)}" was given access to the site's content. If you did not do this, revoke it in Admin -> AI -> Connections and sign out everywhere.`,
  },
  'first-use': {
    subject: (e) => `AI access: "${label(e)}" was used for the first time`,
    body: (e) => `The connected app "${label(e)}" made its first request to /mcp. If you do not recognise it, revoke it in Admin -> AI -> Connections.`,
  },
  'new-country': {
    subject: (e) => `AI access: "${label(e)}" used from a new country`,
    body: (e) => `The connected app "${label(e)}" was used from ${e.type === 'new-country' ? e.country : 'another country'}, where it was not used before. If that is not you or your AI client's servers, revoke it in Admin -> AI -> Connections.`,
  },
  'refused-token': {
    subject: (e) => `AI access: a refused token of "${label(e)}" is still in use`,
    body: (e) =>
      `Someone presented a token of the connected app "${label(e)}" that no longer works (${e.type === 'refused-token' ? e.reason : 'refused'}). ` +
      'Nothing was read or changed. If you did not revoke it yourself, the token may have been copied: check Admin -> AI -> Connections.',
  },
}

function label(e: AccessEvent): string {
  return cleanLabelPart(e.label, 48) || 'connected app'
}

/** Claim the one mail of (event kind, grant) for this UTC day; false when it was already sent. */
function claim(e: AccessEvent, now: number): boolean {
  const window = Math.floor(now / DAY) * DAY
  return getAiDb().prepare('INSERT OR IGNORE INTO ai_counters (key, window_start, n) VALUES (?, ?, 1)').run(`alert|${e.type}|${e.grantId}`, window).changes > 0
}

/** Where owner mail goes: NOTIFY_EMAIL, else the admin account's address. */
function ownerAddress(): string | null {
  const configured = (process.env.NOTIFY_EMAIL || '').trim()
  if (configured) return configured
  return readAdmin()?.email || null
}

/** The subject and text of the mail about `event`: names, countries and reasons only. */
export function alertText(event: AccessEvent): { subject: string; body: string } {
  const t = ALERT_TEXT[event.type]
  return { subject: t.subject(event), body: t.body(event) }
}

/** Mail the owner about `event`, at most once per grant, kind and day. Never throws, never waits on SMTP. */
export function aiAlert(event: AccessEvent, now = Date.now()): void {
  try {
    const to = ownerAddress()
    if (!to || !claim(event, now)) return
    const text = alertText(event)
    void sendMail({ to, subject: text.subject, text: text.body }).catch((err) => log.warn('AI alert mail failed', { type: event.type, err }))
  } catch (err) {
    log.warn('AI alert not sent', { type: event.type, err })
  }
}
