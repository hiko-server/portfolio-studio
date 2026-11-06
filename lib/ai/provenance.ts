import type { AdminAuditEntry } from '../audit/record'
import { log } from '../log'
import { itemEtag } from '../mdx-admin'
import type { PublishedSource } from '../schedule/run'
import { approvedHeldEditAt } from './changes'

/**
 * Where a scheduled publish's text came from (SERVER-ONLY, design §4.6):
 * when the exact version the scheduler takes live was written by an AI edit
 * the owner approved (a held edit of a scheduled item), its activity line
 * says so and names the browser that approved it. Called by the
 * scheduled-publish route through the run's `record`, so lib/schedule never
 * knows about AI.
 */
export function withAiProvenance(entry: AdminAuditEntry, source: PublishedSource): AdminAuditEntry {
  try {
    const held = approvedHeldEditAt(source.collection, source.slug, itemEtag(source.liveUpdatedAt, source.pendingUpdatedAt))
    if (!held) return entry
    return { ...entry, summary: `${entry.summary} (AI-edited, approved on ${held.approvedOn || 'this browser'})` }
  } catch (err) {
    // The AI store being unreadable never stops the log line.
    log.warn('scheduled publishing: the AI provenance of a version could not be read', { err })
    return entry
  }
}
