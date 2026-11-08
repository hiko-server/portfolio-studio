import { withApi } from '../../../../lib/apiHandler'
import { isAdminRequest } from '../../../../lib/auth'
import {
  readStoreBackupRecord,
  runStoreBackup,
  storeBackupIntervalHours,
  storeBackupKey,
  storeBackupTarget,
  storeBackupWarnings,
} from '../../../../lib/storeBackup'

/**
 * The encrypted off-server copy of auth, audit, ai and analytics.db
 * (lib/storeBackup), admin only.
 *
 *   GET  → { key: boolean, target: 'own' | 'shared' | null, intervalHours, record, warnings }
 *          what is set up — never the key, a bucket name or a credential
 *   POST → { result: 'off' | 'created' | 'failed', key?, bytes?, error? } — back up now
 */
export default withApi('admin/storage/store-backup', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  // The proxy gates /api/admin/* too; this is the route's own session check (lib/auth.ts).
  if (!isAdminRequest(req, res)) return res.status(401).json({ error: 'Unauthorized' })
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'POST') return res.status(200).json(await runStoreBackup())
  const target = storeBackupTarget()
  return res.status(200).json({
    key: !!storeBackupKey(),
    target: target ? (target.own ? 'own' : 'shared') : null,
    intervalHours: storeBackupIntervalHours(),
    record: readStoreBackupRecord(),
    warnings: storeBackupWarnings(),
  })
})
