import { readAdmin } from '../admin'
import { getAnalyticsDb } from '../analytics/db'
import { getSiteUrl } from '../env'
import { log } from '../log'
import { sendMail } from '../mailer'
import { pushToOwner, type PushMessage } from './push'

/**
 * Telling the owner when something needs them (SERVER-ONLY): the things
 * that used to fail quietly — a scheduled backup, its copy to R2, the
 * encrypted copy of the other stores (lib/storeBackup), a restore drill, the disk filling up, the boot-time R2 sync, a new server error —
 * and the things worth knowing at once: a contact message, an AI change
 * waiting for approval, a private CV link opened for the first time.
 *
 * Each event goes by e-mail (NOTIFY_EMAIL, else the admin account's
 * address; only when SMTP is set up) and/or to the push channels of
 * lib/ops/push.ts, as its policy below says. Limits keep a broken night from
 * becoming a flood: at most one notice per event and subject (the error's
 * fingerprint, the link) per UTC day, and a daily cap per kind. The claims
 * live in analytics.db's `meta` table, so a restart does not resend.
 *
 * Texts carry names, counts and reasons only — never a secret, a visitor's
 * address or a message body. `opsAlert` never throws and never waits.
 */

export type OpsEvent =
  | { type: 'backup-failed'; error: string }
  | { type: 'backup-offsite-failed'; error: string }
  | { type: 'store-backup-failed'; error: string }
  | { type: 'drill-failed'; summary: string }
  | { type: 'disk-low'; freeGb: number; freePct: number }
  | { type: 'r2-boot-sync-failed' }
  | { type: 'server-error'; fingerprint: string; name: string; message: string; where: string | null }
  | { type: 'contact'; from: string; subject: string }
  | { type: 'ai-change'; id: string; title: string }
  | { type: 'share-opened'; linkId: string; label: string }
  | { type: 'test' }

export type OpsEventType = OpsEvent['type']

type Policy = {
  mail: boolean
  push: boolean
  /** Notices of this kind per UTC day, all subjects together. */
  perDay: number
  priority: 'default' | 'high'
  path: string
}

export const OPS_POLICY: Record<OpsEventType, Policy> = {
  'backup-failed': { mail: true, push: true, perDay: 1, priority: 'high', path: '/admin/dashboard?tab=storage' },
  'backup-offsite-failed': { mail: true, push: true, perDay: 1, priority: 'high', path: '/admin/dashboard?tab=storage' },
  'store-backup-failed': { mail: true, push: true, perDay: 1, priority: 'high', path: '/admin/system' },
  'drill-failed': { mail: true, push: true, perDay: 1, priority: 'high', path: '/admin/system' },
  'disk-low': { mail: true, push: true, perDay: 1, priority: 'high', path: '/admin/system' },
  'r2-boot-sync-failed': { mail: true, push: true, perDay: 1, priority: 'high', path: '/admin/system' },
  'server-error': { mail: true, push: true, perDay: 5, priority: 'default', path: '/admin/system?view=errors' },
  // The contact route mails the message itself; this adds the push.
  contact: { mail: false, push: true, perDay: 30, priority: 'default', path: '/admin/dashboard?tab=inbox' },
  'ai-change': { mail: false, push: true, perDay: 10, priority: 'default', path: '/admin/ai?view=changes' },
  'share-opened': { mail: true, push: true, perDay: 20, priority: 'default', path: '/admin/dashboard?tab=cv' },
  test: { mail: true, push: true, perDay: 20, priority: 'default', path: '/admin/system' },
}

const DAY = 86_400_000
const clip = (s: string, n: number) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The title and text of the notice about `e` (pure; unit tested). */
export function opsAlertText(e: OpsEvent): { title: string; text: string } {
  switch (e.type) {
    case 'backup-failed':
      return {
        title: 'Scheduled backup failed',
        text: `The scheduled backup could not be made: ${clip(e.error, 200)}. Make one with "Backup now" in Admin → Storage and check the server's free space and logs.`,
      }
    case 'backup-offsite-failed':
      return {
        title: 'Backup was not copied to R2',
        text: `The scheduled backup was made on the server, but copying it to R2 failed: ${clip(e.error, 200)}. Until a copy reaches R2 there is no backup off the server.`,
      }
    case 'store-backup-failed':
      return {
        title: 'Encrypted store backup failed',
        text: `The off-server copy of the sign-in, activity-log, AI and analytics stores failed: ${clip(e.error, 200)}. The content backups are not affected.`,
      }
    case 'drill-failed':
      return {
        title: 'Restore drill failed',
        text: `The weekly test restore of the newest backup failed: ${clip(e.summary, 240)}. The live site is untouched; see Admin → System → Health.`,
      }
    case 'disk-low':
      return {
        title: 'Server disk space is low',
        text: `${e.freeGb.toFixed(1)} GB free (${Math.round(e.freePct)} %). Backups and uploads stop working when the disk is full.`,
      }
    case 'r2-boot-sync-failed':
      return {
        title: 'R2 sync failed at start-up',
        text: 'The server started with its local content because it could not reach R2. Changes made since are kept locally and retried; check the R2 credentials and Admin → System → Health.',
      }
    case 'server-error':
      return {
        title: `New server error: ${clip(e.name, 60)}`,
        text: `${clip(e.message, 200)}${e.where ? ` (${clip(e.where, 80)})` : ''}. See Admin → System → Errors.`,
      }
    case 'contact':
      return {
        title: `New message from ${clip(e.from, 60) || 'a visitor'}`,
        text: e.subject ? `"${clip(e.subject, 120)}" — open the Inbox to read it.` : 'Open the Inbox to read it.',
      }
    case 'ai-change':
      return {
        title: 'An AI change is waiting for you',
        text: `"${clip(e.title, 120)}" waits for your approval in Admin → AI → Changes. Nothing is public until you approve it.`,
      }
    case 'share-opened':
      return {
        title: 'Your CV link was opened',
        text: `The private CV link "${clip(e.label, 80)}" was opened for the first time.`,
      }
    case 'test':
      return { title: 'Test notification', text: 'Notifications from your site reach you here.' }
  }
}

function subjectOf(e: OpsEvent): string {
  switch (e.type) {
    case 'server-error':
      return e.fingerprint
    case 'ai-change':
      return e.id
    case 'share-opened':
      return e.linkId
    case 'contact':
    case 'test':
      // Every message counts on its own (the daily cap still applies).
      return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    default:
      return 'site'
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
let prunedDay = ''

/**
 * Claim the notice of (kind, subject) for this UTC day within the kind's
 * daily cap; false when it was already sent or the cap is reached.
 */
export function claimOpsAlert(type: OpsEventType, subject: string, now = Date.now()): boolean {
  const db = getAnalyticsDb()
  const day = utcDay(now)
  const cap = OPS_POLICY[type].perDay
  const countKey = `ops|${day}|${type}|#`
  const subjectKey = `ops|${day}|${type}|${subject.slice(0, 80)}`
  const claimed = db.transaction(() => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(countKey) as { value: string } | undefined
    const count = row ? Number(row.value) || 0 : 0
    if (count >= cap) return false
    if (db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(subjectKey, String(now)).changes === 0) return false
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    ).run(countKey)
    return true
  })()
  if (prunedDay !== day) {
    prunedDay = day
    db.prepare(`DELETE FROM meta WHERE key LIKE 'ops|%' AND key < ?`).run(`ops|${utcDay(now - 3 * DAY)}`)
  }
  return claimed
}

/** Where owner mail goes: NOTIFY_EMAIL, else the admin account's address. */
function ownerAddress(): string | null {
  const configured = (process.env.NOTIFY_EMAIL || '').trim()
  if (configured) return configured
  return readAdmin()?.email || null
}

function adminUrl(path: string): string | undefined {
  try {
    return new URL(path, getSiteUrl()).toString()
  } catch {
    return undefined
  }
}

export type OpsDelivery = { mail: 'sent' | 'skipped' | 'failed' | 'off'; push: Awaited<ReturnType<typeof pushToOwner>> }

/** Deliver `e` now, without the daily limits (the test button uses this; opsAlert claims first). */
export async function deliverOpsAlert(e: OpsEvent): Promise<OpsDelivery> {
  const policy = OPS_POLICY[e.type]
  const { title, text } = opsAlertText(e)
  const url = adminUrl(policy.path)
  const result: OpsDelivery = { mail: 'off', push: [] }
  const jobs: Promise<unknown>[] = []
  if (policy.mail) {
    const to = ownerAddress()
    if (!to) result.mail = 'skipped'
    else
      jobs.push(
        sendMail({ to, subject: title, text: url ? `${text}\n\n${url}` : text })
          .then((r) => {
            result.mail = r.ok ? 'sent' : 'skipped'
          })
          .catch((err) => {
            result.mail = 'failed'
            log.warn('ops alert mail failed', { type: e.type, err })
          }),
      )
  }
  if (policy.push) {
    const message: PushMessage = { title, text, url, priority: policy.priority, kind: e.type }
    jobs.push(
      pushToOwner(message).then((r) => {
        result.push = r
      }),
    )
  }
  await Promise.all(jobs)
  return result
}

/** Tell the owner about `e`, within the daily limits. Never throws, never waits. */
export function opsAlert(e: OpsEvent, now = Date.now()): void {
  try {
    if (!claimOpsAlert(e.type, subjectOf(e), now)) return
    void deliverOpsAlert(e).catch((err) => log.warn('ops alert not delivered', { type: e.type, err }))
  } catch (err) {
    log.warn('ops alert not sent', { type: e.type, err })
  }
}
