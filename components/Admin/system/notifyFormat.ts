/**
 * Words for Admin → System → Notifications (components/Admin/system/
 * NotificationsCard): what is set up, and how a test went. Pure; unit tested.
 */

export type NotifyStatus = { mail: 'ready' | 'no-smtp' | 'no-recipient'; channels: string[] }

export type TestResult = {
  mail: 'sent' | 'skipped' | 'failed' | 'off'
  push: Array<{ channel: string; ok: boolean; status?: number; error?: string }>
}

const WHAT =
  'Failed backups and restore drills, low disk space, a failed R2 sync at start-up, new server errors, contact messages, AI changes waiting for you and the first open of a private CV link.'

export function notifyStatusLine(s: NotifyStatus): { text: string; setup: boolean; canTest: boolean } {
  const mail = s.mail === 'ready'
  const push = s.channels.length > 0
  if (!mail && !push) {
    return {
      text: `Nothing reaches you yet: no e-mail (${s.mail === 'no-smtp' ? 'SMTP is not set up' : 'no recipient'}) and no push channel. ${WHAT}`,
      setup: true,
      canTest: false,
    }
  }
  const where = [mail ? 'e-mail' : '', push ? s.channels.join(', ') : ''].filter(Boolean).join(' and ')
  return { text: `Notices go to ${where}: ${WHAT.charAt(0).toLowerCase()}${WHAT.slice(1)}`, setup: !push, canTest: true }
}

export function testResultLine(r: TestResult): { tone: 'success' | 'warning' | 'error'; title: string; detail: string } {
  const ok = r.push.filter((p) => p.ok).map((p) => p.channel)
  const bad = r.push.filter((p) => !p.ok).map((p) => `${p.channel} (${p.status ? `HTTP ${p.status}` : p.error || 'failed'})`)
  if (r.mail === 'sent') ok.unshift('e-mail')
  if (r.mail === 'failed') bad.unshift('e-mail (refused)')
  if (!ok.length && !bad.length) return { tone: 'warning', title: 'Nothing to send to', detail: 'No e-mail and no push channel is set up.' }
  if (!bad.length) return { tone: 'success', title: 'Test notification sent', detail: `Sent to ${ok.join(', ')}.` }
  return {
    tone: ok.length ? 'warning' : 'error',
    title: ok.length ? 'Some channels failed' : 'Test notification not delivered',
    detail: [ok.length ? `Sent to ${ok.join(', ')}.` : '', `Failed: ${bad.join(', ')}.`].filter(Boolean).join(' '),
  }
}

export type StoreBackupState = {
  key: boolean
  target: 'own' | 'shared' | null
  intervalHours: number
  record: { lastRunAt: number | null; lastOkAt: number | null; lastOk: boolean | null; lastError: string | null; lastBytes: number | null }
  warnings: string[]
}

const ago = (ms: number) => {
  const h = Math.round(ms / 3_600_000)
  return h < 1 ? 'less than an hour ago' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** The card's badge and sentence for the encrypted store backup (lib/storeBackup). */
export function storeBackupLine(s: StoreBackupState, now: number): { badge: string; tone: 'green' | 'orange' | 'red' | 'gray'; text: string } {
  const what = 'Sign-ins and passkeys, the activity log, AI settings and visitor analytics are not in the content backups.'
  if (s.intervalHours === 0) return { badge: 'off', tone: 'gray', text: `Switched off (STORE_BACKUP_INTERVAL_HOURS=0). ${what}` }
  if (!s.target) return { badge: 'no R2', tone: 'gray', text: `Needs R2. ${what}` }
  if (!s.key) return { badge: 'not set up', tone: 'orange', text: `${what} Without a key they have no copy off this server.` }
  if (s.record.lastOk === false) return { badge: 'failed', tone: 'red', text: `The last run failed: ${s.record.lastError || 'see the server log'}.` }
  if (!s.record.lastOkAt) return { badge: 'waiting', tone: 'orange', text: `Set up; the first encrypted copy is made within half an hour of a start, then every ${s.intervalHours} h.` }
  const where = s.target === 'own' ? 'its own R2 bucket' : 'the R2 bucket'
  return {
    badge: s.warnings.length ? 'late' : 'ok',
    tone: s.warnings.length ? 'orange' : 'green',
    text: `Last encrypted copy ${ago(now - s.record.lastOkAt)} to ${where}; every ${s.intervalHours} h.`,
  }
}
