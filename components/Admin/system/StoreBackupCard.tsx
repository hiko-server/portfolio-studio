import { useCallback, useEffect, useState } from 'react'
import { Badge, Box, Button, Code, Flex, Text, useToast } from '@chakra-ui/react'
import { MONO, Panel, outlineButtonProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { formatBytes } from './systemFormat'
import { storeBackupLine, type StoreBackupState } from './notifyFormat'

/**
 * Admin → System → Health: the encrypted off-server copy of the sign-in,
 * activity-log, AI and analytics stores (lib/storeBackup) — whether it is
 * set up, when it last ran, and "Back up now".
 */
export default function StoreBackupCard() {
  const toast = useToast()
  const [state, setState] = useState<StoreBackupState | null>(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/storage/store-backup', { cache: 'no-store' })
      const json = await readJsonObject(res)
      if (res.ok) setState(json as unknown as StoreBackupState)
    } catch {
      // The card says "not loaded".
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/admin/storage/store-backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const json = await readJsonObject(res)
      if (!res.ok || json.result === 'failed') {
        toast({ status: 'error', title: 'Encrypted backup failed', description: typeof json.error === 'string' ? json.error : `HTTP ${res.status}` })
      } else if (json.result === 'off') {
        toast({ status: 'warning', title: 'Not set up', description: 'Set STORE_BACKUP_KEY and R2 in the server’s .env.' })
      } else {
        toast({ status: 'success', title: 'Encrypted backup uploaded', description: typeof json.bytes === 'number' ? formatBytes(json.bytes) : undefined })
      }
      await load()
    } catch {
      toast({ status: 'error', title: 'Encrypted backup failed', description: NETWORK_ERROR })
    } finally {
      setRunning(false)
    }
  }

  const line = state ? storeBackupLine(state, Date.now()) : null

  return (
    <Panel as="section" aria-label="Off-server copy of the other stores">
      <Text as="h3" fontSize="sm" fontWeight={600} mb={3}>
        Off-server copy of the other stores
      </Text>
      {state && line ? (
        <>
          <Flex gap={1.5} flexWrap="wrap" mb={2}>
            <Badge colorScheme={line.tone} variant="subtle" fontFamily={MONO} fontSize="9px">
              {line.badge}
            </Badge>
          </Flex>
          <Text fontSize="sm" color="page.fg-secondary">
            {line.text}
          </Text>
          {state.target && !state.key ? (
            <Box fontSize="xs" color="page.fg-secondary" mt={2}>
              Set <Code fontSize="xs">STORE_BACKUP_KEY</Code> (<Code fontSize="xs">openssl rand -base64 32</Code>) in the server&rsquo;s{' '}
              <Code fontSize="xs">.env</Code> and keep a copy in your password manager.
            </Box>
          ) : null}
        </>
      ) : (
        <Text fontSize="sm" color="page.fg-secondary">
          Not loaded.
        </Text>
      )}
      <Button size="xs" mt={4} {...outlineButtonProps} onClick={() => void runNow()} isLoading={running} isDisabled={!state?.key || !state?.target}>
        Back up now
      </Button>
    </Panel>
  )
}
