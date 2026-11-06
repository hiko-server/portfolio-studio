import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Button, Flex, Text, useToast } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import SegmentedTabs, { tabPanelProps } from '../shell/SegmentedTabs'
import { MONO, outlineButtonProps, primaryButtonProps, warnTextProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { AI_COPY } from './copy'
import CopyField from './CopyField'
import { claudeCodeCommand, claudeCodeOAuthCommand, codexCommands, cursorConfig, shellRef, timeLeft } from './format'
import type { ConsentView, PairingApp, PairingView } from './types'

/** How often the tab asks about its open window, while the page is visible. */
const POLL_MS = 5000

const pulse = keyframes`
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
`

type FetchWithStepUp = (input: string, init?: RequestInit, reason?: string, opts?: { freshWithinMs?: number }) => Promise<Response>

type Client = {
  key: PairingApp
  /** Connects from its vendor's cloud: needs the public address. */
  cloud: boolean
  /** Can send a header, so a personal token works too. */
  token: boolean
}

/** The tabs of [02], in PRODUCT §7.1's order. Every one signs in over OAuth; the cloud ones can't take a header. */
const CLIENTS: readonly Client[] = [
  { key: 'claude', cloud: true, token: false },
  { key: 'chatgpt', cloud: true, token: false },
  { key: 'claude-code', cloud: false, token: true },
  { key: 'cursor', cloud: false, token: true },
  { key: 'vscode', cloud: false, token: true },
  { key: 'codex', cloud: false, token: true },
  { key: 'other', cloud: false, token: true },
]

const labelOf = (app: PairingApp) => AI_COPY.clients[app].label
/** How a sentence names an app: its name, or "your app" for Other. */
const nameOf = (app: PairingApp) => {
  const c = AI_COPY.clients[app]
  return 'inSentence' in c ? c.inSentence : c.label
}

/** One numbered step, its number in the section labels' mono accent. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <Flex as="li" gap={3} align="flex-start">
      <Text as="span" aria-hidden fontFamily={MONO} fontSize="11px" color="accent.text" mt="3px" flexShrink={0} className="tnum">
        {String(n).padStart(2, '0')}
      </Text>
      <Box flex="1 1 auto" minW={0}>
        {children}
      </Box>
    </Flex>
  )
}

/** The live line under "Allow a new connection": the window's state, from the server only. */
function PairingStatus({ tone, children }: { tone: 'waiting' | 'done' | 'warn'; children: React.ReactNode }) {
  return (
    <Flex align="flex-start" gap={2.5} px={3} py={2.5} border="1px solid" borderColor="page.border" borderRadius="md" bg="page.bg" mt={3} data-pairing={tone}>
      <Box
        as="span"
        aria-hidden
        flexShrink={0}
        mt="6px"
        w="8px"
        h="8px"
        borderRadius="full"
        bg={tone === 'done' ? 'green.500' : tone === 'warn' ? 'orange.400' : 'accent.500'}
        sx={
          tone === 'waiting'
            ? { animation: `${pulse} 1.6s ease-in-out infinite`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }
            : undefined
        }
      />
      {/* The waiting line carries its own live region (the countdown beside it must not be read out every second). */}
      <Box fontSize="sm" minW={0} {...(tone === 'waiting' ? {} : { role: 'status', 'aria-live': 'polite' as const })}>
        {children}
      </Box>
    </Flex>
  )
}

/**
 * [02] Connect an app, by app (design §8.5, PRODUCT §7.1): a tab per client
 * with its numbered steps, each OAuth tab led by "Allow a new connection" —
 * the 10-minute pairing window of §6.4, opened with a step-up for that app
 * only — and, where the app can send a header, the personal-token way too.
 * While a window is open the tab asks the server every 5 seconds (only while
 * the page is visible) how many connection requests arrived and whether the
 * owner's approval was collected, and says so; nothing is inferred. Claude
 * and ChatGPT connect from their clouds: on a page served from this
 * computer their tabs say why they can't connect yet.
 */
export default function ClientSetupTabs({
  server,
  name,
  envVar,
  open,
  localPage,
  fetchWithStepUp,
  onNewToken,
  onConnected,
  onUnauthorized,
}: {
  /** The MCP address, null without SITE_URL. */
  server: string | null
  /** The short name an app files the server under. */
  name: string
  /** The environment variable a personal token goes in. */
  envVar: string
  /** The public AI addresses exist (AI access on, connected apps allowed, SITE_URL set). */
  open: boolean
  localPage: boolean
  fetchWithStepUp: FetchWithStepUp
  onNewToken: () => void
  /** An OAuth app collected its access: the new grant's id (the panel lists it and waits for its first call). */
  onConnected: (grantId: string) => void
  onUnauthorized: () => void
}) {
  const toast = useToast()
  const [tab, setTab] = useState<PairingApp>('claude-code')
  const [pairing, setPairing] = useState<PairingView | null>(null)
  /** The window this page opened, and for which app: what the consents are counted from. */
  const [opened, setOpened] = useState<{ app: PairingApp; at: number } | null>(null)
  const [consents, setConsents] = useState<ConsentView[]>([])
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const reported = useRef<Set<string>>(new Set())
  // The parent's callbacks, read when used: a new function on every render of the parent must not restart the polling.
  const callbacks = useRef({ onConnected, onUnauthorized })
  callbacks.current = { onConnected, onUnauthorized }

  const poll = useCallback(
    async (since: number | null) => {
      try {
        const res = await fetch(`/api/admin/ai/pairing${since === null ? '' : `?since=${since}`}`, { cache: 'no-store', credentials: 'same-origin' })
        if (res.status === 401) return callbacks.current.onUnauthorized()
        if (!res.ok) return
        const json = await readJsonObject(res)
        const next = (json.pairing as PairingView | null) ?? null
        setPairing(next)
        // A window opened before this page loaded (another tab, a reload): follow it as if opened here.
        if (next) setOpened((o) => (o && o.at === next.openedAt ? o : { app: next.app, at: next.openedAt }))
        setConsents(Array.isArray(json.consents) ? (json.consents as ConsentView[]) : [])
        setClock(Date.now())
      } catch {
        // A missed poll is retried by the next one.
      }
    },
    [],
  )

  useEffect(() => {
    if (open) void poll(null)
  }, [open, poll])

  // While a window is open (or an approval is still to be collected): ask every 5 s, tick the countdown every second.
  const pending = consents.some((c) => !c.exchanged && !c.expired)
  const live = !!pairing || (!!opened && pending)
  useEffect(() => {
    if (!live) return
    const since = opened?.at ?? null
    const ask = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll(since)
    }, POLL_MS)
    const tick = window.setInterval(() => setClock(Date.now()), 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll(since)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(ask)
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [live, opened, poll])

  // The window ran out on this page's clock: ask once more, so the line says so without waiting for the poll.
  useEffect(() => {
    if (pairing && clock >= pairing.expiresAt) void poll(opened?.at ?? null)
  }, [clock, pairing, opened, poll])

  // An approval collected: hand the new grant to the panel, once.
  useEffect(() => {
    for (const c of consents) {
      if (c.exchanged && c.live && c.grantId && !reported.current.has(c.grantId)) {
        reported.current.add(c.grantId)
        callbacks.current.onConnected(c.grantId)
      }
    }
  }, [consents])

  const allow = async (app: PairingApp) => {
    setBusy(true)
    try {
      const res = await fetchWithStepUp(
        '/api/admin/ai/pairing',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app }) },
        AI_COPY.pairing.stepUp,
      )
      if (wasStepUpCancelled(res)) return
      if (res.status === 401) return callbacks.current.onUnauthorized()
      const json = await readJsonObject(res)
      if (!res.ok) {
        toast({ status: 'error', title: AI_COPY.pairing.notOpened, description: typeof json.error === 'string' ? json.error : `HTTP ${res.status}`, duration: 6000 })
        return
      }
      const p = json.pairing as PairingView
      setPairing(p)
      setConsents([])
      setOpened({ app, at: p.openedAt })
      setClock(Date.now())
    } catch {
      toast({ status: 'error', title: AI_COPY.pairing.notOpened, description: NETWORK_ERROR, duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/ai/pairing', { method: 'DELETE' })
      if (res.status === 401) return callbacks.current.onUnauthorized()
      if (!res.ok) {
        const json = await readJsonObject(res)
        toast({ status: 'error', title: AI_COPY.pairing.notClosed, description: typeof json.error === 'string' ? json.error : `HTTP ${res.status}`, duration: 6000 })
        return
      }
      toast({ status: 'success', title: AI_COPY.pairing.closed })
      setPairing(null)
      setOpened(null)
      setConsents([])
    } catch {
      toast({ status: 'error', title: AI_COPY.pairing.notClosed, description: NETWORK_ERROR, duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const client = CLIENTS.find((c) => c.key === tab) ?? CLIENTS[0]
  const copy = AI_COPY.clients[client.key]
  const label = nameOf(client.key)
  const unreachable = client.cloud && localPage
  const canAllow = open && !!server && !unreachable
  const p = AI_COPY.pairing

  /** The state of the window for this tab: open for it, open for another app, or what became of the one this page opened. */
  const status = (() => {
    const mine = opened?.app === client.key
    const newest = mine ? consents[0] : undefined
    if (newest?.exchanged) return newest.live ? <PairingStatus tone="done">{p.connected(label)}</PairingStatus> : <PairingStatus tone="warn">{p.endedSince}</PairingStatus>
    if (newest && newest.expired) return <PairingStatus tone="warn">{p.expired}</PairingStatus>
    if (newest) return <PairingStatus tone="waiting">{p.approved(label)}</PairingStatus>
    if (pairing && pairing.expiresAt > clock) {
      if (pairing.app !== client.key) {
        return (
          <Text fontSize="xs" color="page.fg-secondary" mt={2}>
            {p.otherOpen(nameOf(pairing.app), timeLeft(pairing.expiresAt, clock))}
          </Text>
        )
      }
      return (
        <PairingStatus tone="waiting">
          <Box as="span" role="status" aria-live="polite">
            {p.waiting(label)}
          </Box>{' '}
          <Box as="span" color="page.fg-secondary" className="tnum">
            {p.closesIn(timeLeft(pairing.expiresAt, clock))}
          </Box>
          {pairing.requests > 0 ? (
            <Text fontSize="xs" mt={1} {...(pairing.requests > 1 ? warnTextProps : { color: 'page.fg-secondary' })}>
              {p.requests(pairing.requests)}
            </Text>
          ) : null}
          <Button size="xs" {...outlineButtonProps} mt={2} onClick={() => void close()} isDisabled={busy}>
            {p.close}
          </Button>
        </PairingStatus>
      )
    }
    if (mine) return <PairingStatus tone="warn">{p.ended}</PairingStatus>
    return null
  })()

  const command = (() => {
    if (!server) return null
    if (client.key === 'claude-code') return <CopyField label={AI_COPY.clients['claude-code'].commandLabel} value={claudeCodeOAuthCommand(name, server)} />
    if (client.key === 'cursor') return <CopyField label={AI_COPY.clients.cursor.configLabel} value={cursorConfig(name, server)} />
    if (client.key === 'codex') return <CopyField label={AI_COPY.clients.codex.commandLabel} value={codexCommands(name, server)} />
    // The others take the server address, which [02] shows (with Copy) right above the tabs.
    return null
  })()
  const steps: readonly string[] = copy.steps
  let n = 1

  return (
    <Box>
      {/* Seven tabs wrap on a phone instead of scrolling out of sight. */}
      <Box sx={{ '& [role="tablist"]': { flexWrap: { base: 'wrap', md: 'nowrap' } } }}>
        <SegmentedTabs items={CLIENTS.map((c) => ({ key: c.key, label: labelOf(c.key) }))} value={tab} onSelect={setTab} label={AI_COPY.clients.tabsLabel} idPrefix="ai-client" />
      </Box>
      <Box {...tabPanelProps('ai-client', tab)} mt={4} data-client={client.key}>
        {unreachable ? (
          <Text fontSize="sm" color="page.fg-secondary" mb={3}>
            {AI_COPY.clients.cloudOnly(label)}
          </Text>
        ) : null}
        <Text fontSize="12px" fontWeight={600} mb={2}>
          {AI_COPY.clients.oauthTitle}
        </Text>
        <Box as="ol" listStyleType="none" display="grid" gap={4}>
          <Step n={n++}>
            <Button size="sm" {...primaryButtonProps} onClick={() => void allow(client.key)} isDisabled={!canAllow || busy}>
              {p.allow}
            </Button>
            <Text fontSize="xs" color="page.fg-secondary" mt={1.5}>
              {!open ? AI_COPY.connect.closed : p.allowHelp(label)}
            </Text>
            {status}
          </Step>
          {steps.map((s, i) => (
            <Step key={s} n={n++}>
              <Text fontSize="sm">{s}</Text>
              {i === 0 && command ? <Box mt={2}>{command}</Box> : null}
            </Step>
          ))}
          <Step n={n++}>
            <Text fontSize="sm">{AI_COPY.clients.approveHere}</Text>
          </Step>
        </Box>
        {'note' in copy && copy.note ? (
          <Text fontSize="xs" color="page.fg-secondary" mt={3}>
            {copy.note}
          </Text>
        ) : null}

        {client.token ? (
          <Box mt={6} pt={5} borderTop="1px solid" borderColor="page.border">
            <Text fontSize="12px" fontWeight={600} mb={2}>
              {AI_COPY.clients.tokenTitle}
            </Text>
            <Text fontSize="sm">
              {AI_COPY.clients.tokenIntro}{' '}
              <Box as="code" fontFamily={MONO} fontSize="12px" px={1.5} py={0.5} borderRadius="sm" bg="page.bg-overlay" whiteSpace="nowrap">
                {AI_COPY.connect.headerShape}
              </Box>
              .
            </Text>
            <Box mt={2}>
              <Button size="sm" {...outlineButtonProps} onClick={onNewToken} isDisabled={!open || !server}>
                {AI_COPY.connect.newToken}
              </Button>
            </Box>
            {server && client.key === 'claude-code' ? (
              <Box mt={3}>
                <Text fontSize="sm" mb={2}>
                  {AI_COPY.connect.step2(envVar)}
                </Text>
                <CopyField label={AI_COPY.connect.commandLabel} value={claudeCodeCommand(name, server, shellRef(envVar))} />
              </Box>
            ) : null}
            {server && client.key === 'cursor' ? (
              <Box mt={3}>
                <CopyField label={AI_COPY.clients.cursor.configLabel} value={cursorConfig(name, server, envVar)} />
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
