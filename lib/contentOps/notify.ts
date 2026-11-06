import type { Logger } from '../log'
import { sendMail } from '../mailer'

/**
 * The owner's notification mail after a home or CV save ("Home updated",
 * "CV updated"), injected into the services (lib/contentOps/home, cv) by
 * the callers that may send mail: the admin routes and an approved AI
 * proposal (lib/ai/apply). The tool layer never reaches it. SERVER-ONLY.
 */

export type OwnerNotice = { kind: 'home' | 'cv'; subject: string; text: string }

/** Sends each notice to the owner; a failed send is logged, never thrown. */
export function ownerMail(log: Logger): (notice: OwnerNotice) => void {
  return (notice) => {
    sendMail({
      to: process.env.NOTIFY_EMAIL || process.env.ADMIN_EMAIL || 'hi@lucian-dev.com',
      subject: notice.subject,
      text: notice.text,
    }).catch((err) => log.warn(notice.kind === 'cv' ? 'CV notification mail failed' : 'home notification mail failed', { err }))
  }
}
