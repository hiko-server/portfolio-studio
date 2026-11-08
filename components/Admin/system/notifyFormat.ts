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
