import { useCallback, useEffect, useState } from 'react'
import { Badge, Box, Button, Code, Flex, Text, useToast } from '@chakra-ui/react'
import { MONO, Panel, outlineButtonProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { useAdminCommands } from '../shell/useAdminCommands'
import { notifyStatusLine, testResultLine, type NotifyStatus, type TestResult } from './notifyFormat'

/**
 * Admin → System → Health: where the owner's notices go (lib/ops/alerts) —
 * e-mail and the push channels the server's environment names — and a
 * button that sends a test notice to all of them.
 */
export default function NotificationsCard() {
  const toast = useToast()
  const [status, setStatus] = useState<NotifyStatus | null>(null)
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/test-notify', { cache: 'no-store' })
      const json = await readJsonObject(res)
      if (res.ok) setStatus(json as unknown as NotifyStatus)
    } catch {
      // The card says "not loaded"; the rest of the page still works.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sendTest = useCallback(async () => {
    setSending(true)
    try {
      const res = await fetch('/api/admin/test-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const json = await readJsonObject(res)
      if (!res.ok) {
        toast({ status: 'error', title: 'Test notification not sent', description: typeof json.error === 'string' ? json.error : `HTTP ${res.status}` })
        return
      }
      const line = testResultLine(json as unknown as TestResult)
      toast({ status: line.tone, title: line.title, description: line.detail, duration: 8000 })
    } catch {
      toast({ status: 'error', title: 'Test notification not sent', description: NETWORK_ERROR })
    } finally {
      setSending(false)
    }
  }, [toast])

  useAdminCommands(
    'system-notify',
    [{ id: 'test-notify', label: 'Send a test notification', hint: 'e-mail and push channels', keywords: 'push ntfy telegram bark webhook notify alert test', run: () => void sendTest() }],
    'v1',
  )

  const line = status ? notifyStatusLine(status) : null

  return (
    <Panel as="section" aria-label="Notifications">
      <Text as="h3" fontSize="sm" fontWeight={600} mb={3}>
        Notifications
      </Text>
      {status ? (
        <>
          <Flex gap={1.5} flexWrap="wrap" mb={2}>
            <Badge colorScheme={status.mail === 'ready' ? 'green' : 'gray'} variant="subtle" fontFamily={MONO} fontSize="9px">
              e-mail {status.mail === 'ready' ? 'on' : 'off'}
            </Badge>
            {status.channels.map((c) => (
              <Badge key={c} colorScheme="green" variant="subtle" fontFamily={MONO} fontSize="9px">
                {c}
              </Badge>
            ))}
          </Flex>
          <Text fontSize="sm" color="page.fg-secondary">
            {line?.text}
          </Text>
          {line?.setup ? (
            <Box fontSize="xs" color="page.fg-secondary" mt={2}>
              Set one of <Code fontSize="xs">NOTIFY_NTFY_URL</Code>, <Code fontSize="xs">NOTIFY_TELEGRAM_BOT_TOKEN</Code> +{' '}
              <Code fontSize="xs">NOTIFY_TELEGRAM_CHAT_ID</Code>, <Code fontSize="xs">NOTIFY_BARK_URL</Code> or{' '}
              <Code fontSize="xs">NOTIFY_WEBHOOK_URL</Code> in the server&rsquo;s <Code fontSize="xs">.env</Code>, or SMTP for e-mail.
            </Box>
          ) : null}
        </>
      ) : (
        <Text fontSize="sm" color="page.fg-secondary">
          Not loaded.
        </Text>
      )}
      <Button size="xs" mt={4} {...outlineButtonProps} onClick={() => void sendTest()} isLoading={sending} isDisabled={!status || !line?.canTest}>
        Send a test notification
      </Button>
    </Panel>
  )
}
