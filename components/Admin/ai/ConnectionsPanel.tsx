import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertIcon,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Skeleton,
  Switch,
  Text,
  useToast,
} from '@chakra-ui/react'
import { MONO, SectionLabel, outlineButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { useStepUp } from '../security/useStepUp'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { relativeTime } from '../security/securityFormat'
import { AI_COPY } from './copy'
import AiStatusStrip from './AiStatusStrip'
import { assistantTile } from './assistantFormat'
import ClientSetupTabs from './ClientSetupTabs'
import ConnectedApps from './ConnectedApps'
import CopyField from './CopyField'
import FirstCallStatus from './FirstCallStatus'
import NewTokenDialog from './NewTokenDialog'
import ToolCatalogue from './ToolCatalogue'
import { isLocalHostname, serverName, tokenEnvVar } from './format'
import { AiSchedulesNote, clearAiSchedules } from './AiSchedules'
import type { AccessLevel, AccessState, AiSchedule, AppView, AssistantSummary, CatalogueTool } from './types'

/** The page's numbered sections; the status strip's tiles carry the number of the section they sum up. */
const SECTION = { access: 1, connect: 2, apps: 3, catalogue: 4 } as const
/** How often the page asks whether a new app made its first call, while one is waiting and the tab is visible. */
const POLL_MS = 5000
const RETURN_PATH = '/admin/ai?view=connections'

type Settings = { enabled: boolean; mcpEnabled: boolean }
type Loaded = {
  access: AccessState
  settings: Settings | null
  /** Schedules approved AI changes set that have not run (the off and revoke dialogs offer to clear them). */
  schedules: AiSchedule[]
  apps: AppView[]
  lifetimes: number[]
  defaultDays: number
  tools: CatalogueTool[]
  levels: AccessLevel[]
}

class Unauthorized extends Error {}

async function getJson(url: string): Promise<Record<string, any>> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  if (res.status === 401) throw new Unauthorized()
  const json = await readJsonObject(res)
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
  return json
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * Admin → AI → Connections (design §8.1, §8.5; PRODUCT §7): [01] Access —
 * the master switch and "Allow connected apps" (turning on asks for a recent
 * verification, turning off never does); [02] Connect an app — the server
 * address and a personal token's setup, with the live "Waiting for the first
 * call…"; [03] Connected apps; [04] What apps can do, from the server's
 * catalogue. Server: /api/admin/ai/{settings,tokens,catalogue}. Laid out like
 * the Security page: a status strip whose tiles carry their sections'
 * numbers, numbered sections, hairline rows.
 */
export default function ConnectionsPanel({ onShowChanges }: { onShowChanges?: () => void } = {}) {
  const toast = useToast()
  const { fetchWithStepUp, stepUpElement } = useStepUp()
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [newToken, setNewToken] = useState(false)
  const [watchId, setWatchId] = useState<string | null>(null)
  const [offOpen, setOffOpen] = useState(false)
  const [endApps, setEndApps] = useState(false)
  const [clearSchedules, setClearSchedules] = useState(false)
  const [localPage, setLocalPage] = useState(false)
  const [waitingCount, setWaitingCount] = useState<number | null>(null)
  const [assistant, setAssistant] = useState<AssistantSummary | null>(null)
  const offCancelRef = useRef<HTMLButtonElement>(null)

  const toLogin = () => {
    window.location.href = loginHref(RETURN_PATH)
  }

  const load = useCallback(async () => {
    try {
      const [settings, tokens, catalogue] = await Promise.all([
        getJson('/api/admin/ai/settings'),
        getJson('/api/admin/ai/tokens'),
        getJson('/api/admin/ai/catalogue'),
      ])
      setData({
        access: settings.access as AccessState,
        settings: (settings.settings as Settings | null) ?? null,
        schedules: Array.isArray(settings.schedules) ? (settings.schedules as AiSchedule[]) : [],
        apps: Array.isArray(tokens.apps) ? (tokens.apps as AppView[]) : [],
        lifetimes: Array.isArray(tokens.lifetimes) ? (tokens.lifetimes as number[]) : [],
        defaultDays: typeof tokens.defaultDays === 'number' ? tokens.defaultDays : 90,
        tools: Array.isArray(catalogue.tools) ? (catalogue.tools as CatalogueTool[]) : [],
        levels: Array.isArray(catalogue.levels) ? (catalogue.levels as AccessLevel[]) : [],
      })
      setNow(Date.now())
      setLoadError('')
    } catch (err) {
      if (err instanceof Unauthorized) return toLogin()
      setLoadError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR)
    }
  }, [])

  const reloadApps = useCallback(async () => {
    try {
      const tokens = await getJson('/api/admin/ai/tokens')
      setData((d) =>
        d
          ? {
              ...d,
              apps: Array.isArray(tokens.apps) ? (tokens.apps as AppView[]) : d.apps,
              schedules: Array.isArray(tokens.schedules) ? (tokens.schedules as AiSchedule[]) : d.schedules,
            }
          : d,
      )
      setNow(Date.now())
    } catch (err) {
      if (err instanceof Unauthorized) toLogin()
      // A missed poll is retried by the next one.
    }
  }, [])

  /** An app connected over OAuth: list it and wait for its first call, as for a new token. */
  const onOAuthConnected = useCallback(
    (grantId: string) => {
      setWatchId(grantId)
      void reloadApps()
    },
    [reloadApps],
  )

  useEffect(() => {
    void load()
    void getJson('/api/admin/ai/summary')
      .then((j) => {
        setWaitingCount(typeof j.waiting === 'number' ? j.waiting : null)
        setAssistant(j.assistant && typeof j.assistant === 'object' ? (j.assistant as AssistantSummary) : null)
      })
      .catch(() => {})
    setLocalPage(isLocalHostname(window.location.hostname))
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [load])

  // Live confirmation: while an app has not made its first call, ask every 5 s — only while the tab is visible.
  const waiting = !!data?.apps.some((a) => a.firstUsedAt === null)
  useEffect(() => {
    if (!waiting) return
    let timer: number | null = null
    const tick = () => {
      if (document.visibilityState === 'visible') void reloadApps()
    }
    const start = () => {
      if (timer === null) timer = window.setInterval(tick, POLL_MS)
    }
    const stop = () => {
      if (timer !== null) window.clearInterval(timer)
      timer = null
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [waiting, reloadApps])

  const fail = (title: string, res: Response | null, json: Record<string, unknown> = {}) => {
    if (res && wasStepUpCancelled(res)) return
    if (res?.status === 401) return toLogin()
    toast({
      status: 'error',
      title,
      description: typeof json.error === 'string' ? json.error : res ? `HTTP ${res.status}` : NETWORK_ERROR,
      duration: 6000,
    })
  }

  /** PATCH the switches; `stepUp` names why a loosening change asks first. */
  const patchSettings = async (key: string, body: Record<string, unknown>, done: string, stepUp?: string) => {
    setBusy(key)
    try {
      const res = stepUp
        ? await fetchWithStepUp('/api/admin/ai/settings', jsonInit('PATCH', body), stepUp)
        : await fetch('/api/admin/ai/settings', jsonInit('PATCH', body))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(AI_COPY.access.notChanged, res, json)
      setData((d) => (d ? { ...d, access: json.access as AccessState, settings: json.settings as Settings } : d))
      const ended = typeof json.endedApps === 'number' ? json.endedApps : 0
      if (json.endAppsError === true) {
        // The switch changed; revoking the apps did not. Say both, and keep it on screen until read.
        toast({ status: 'warning', title: done, description: AI_COPY.access.endFailed, duration: null, isClosable: true })
        await reloadApps()
        return
      }
      toast({ status: 'success', title: done, description: ended ? AI_COPY.access.endedWith(ended) : undefined })
      if (ended) await reloadApps()
    } catch {
      fail(AI_COPY.access.notChanged, null)
    } finally {
      setBusy(null)
    }
  }

  /** Clear the schedules the owner chose to clear with the off or revoke dialog, and say how it went. */
  const clearChosen = async (list: AiSchedule[]) => {
    if (!list.length) return
    const out = await clearAiSchedules(list)
    if (out.failed) toast({ status: 'warning', title: AI_COPY.schedules.notCleared(out.failed), description: out.cleared ? AI_COPY.schedules.cleared(out.cleared) : undefined, duration: null, isClosable: true })
    else toast({ status: 'success', title: AI_COPY.schedules.cleared(out.cleared) })
    await reloadApps()
  }

  const rename = async (app: AppView, name: string): Promise<boolean> => {
    setBusy(`rename:${app.id}`)
    try {
      const res = await fetch('/api/admin/ai/tokens', jsonInit('PATCH', { id: app.id, name }))
      const json = await readJsonObject(res)
      if (!res.ok) {
        fail(AI_COPY.apps.notRenamed, res, json)
        return false
      }
      toast({ status: 'success', title: AI_COPY.apps.renamed })
      await reloadApps()
      return true
    } catch {
      fail(AI_COPY.apps.notRenamed, null)
      return false
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (app: AppView, clear: AiSchedule[] = []) => {
    setBusy(`revoke:${app.id}`)
    try {
      const res = await fetch('/api/admin/ai/tokens', jsonInit('DELETE', { id: app.id }))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(AI_COPY.apps.notRevoked, res, json)
      toast({ status: 'success', title: AI_COPY.apps.revoked, description: app.name })
      if (watchId === app.id) setWatchId(null)
      await reloadApps()
      await clearChosen(clear)
    } catch {
      fail(AI_COPY.apps.notRevoked, null)
    } finally {
      setBusy(null)
    }
  }

  const revokeAll = async (clear: AiSchedule[] = []) => {
    setBusy('revoke-all')
    try {
      const res = await fetch('/api/admin/ai/tokens', jsonInit('DELETE', { all: true }))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(AI_COPY.apps.notRevoked, res, json)
      toast({ status: 'success', title: AI_COPY.apps.revokedAll(typeof json.ended === 'number' ? json.ended : 0) })
      setWatchId(null)
      await reloadApps()
      await clearChosen(clear)
    } catch {
      fail(AI_COPY.apps.notRevoked, null)
    } finally {
      setBusy(null)
    }
  }

  if (loadError && !data) {
    return (
      <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated">
        <AlertIcon />
        <AlertDescription fontSize="sm" flex={1}>
          {AI_COPY.loadError(loadError)}
        </AlertDescription>
        <Button size="sm" {...outlineButtonProps} onClick={() => void load()}>
          {AI_COPY.retry}
        </Button>
      </Alert>
    )
  }

  if (!data) {
    return (
      <Box aria-busy="true" aria-label={AI_COPY.page.loading}>
        <Skeleton h="88px" borderRadius="xl" />
        <Skeleton h="140px" borderRadius="xl" mt={6} />
        <Skeleton h="180px" borderRadius="xl" mt={6} />
      </Box>
    )
  }

  const { access, apps } = data
  const settings = data.settings ?? { enabled: access.enabled, mcpEnabled: access.mcpEnabled }
  const canCreate = access.open
  const server = access.server
  const name = serverName(server)
  const envVar = tokenEnvVar(name)
  const watched = watchId ? (apps.find((a) => a.id === watchId) ?? null) : null
  const lastUsed = apps.reduce<number | null>((max, a) => (a.lastUsedAt !== null && (max === null || a.lastUsedAt > max) ? a.lastUsedAt : max), null)
  const lockedByServer = access.blocked !== null
  const a = AI_COPY.access

  return (
    <Box>
      {/* Status strip: Access, Connected apps (their tiles carry their sections' numbers), Waiting. */}
      <Box mb={2}>
        <AiStatusStrip
          tiles={[
            {
              index: SECTION.access,
              label: AI_COPY.strip.access,
              value: access.enabled && !access.blocked ? AI_COPY.strip.on : AI_COPY.strip.off,
              sub: AI_COPY.strip.accessSub(access),
            },
            assistantTile(assistant),
            {
              index: SECTION.apps,
              label: AI_COPY.strip.apps,
              value: String(apps.length),
              sub: AI_COPY.strip.appsSub(apps.length, lastUsed ? relativeTime(lastUsed, now) : null),
            },
            {
              label: AI_COPY.strip.waiting,
              value: waitingCount === null ? '—' : String(waitingCount),
              sub: AI_COPY.strip.waitingSub(waitingCount),
              action: waitingCount && onShowChanges ? { label: AI_COPY.strip.review, onClick: onShowChanges } : undefined,
            },
          ]}
        />
      </Box>

      {/* [01] Access */}
      <SectionLabel index={SECTION.access} title={a.title} id="ai-access" hint={a.hint} />
      {access.blocked === 'env' ? (
        <Alert status="warning" variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={4} fontSize="sm">
          <AlertIcon />
          <AlertDescription>{a.env}</AlertDescription>
        </Alert>
      ) : access.blocked === 'unreadable' ? (
        <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={4} fontSize="sm">
          <AlertIcon />
          <AlertDescription>{a.unreadable}</AlertDescription>
        </Alert>
      ) : !access.siteUrl ? (
        <Alert status="warning" variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={4} fontSize="sm">
          <AlertIcon />
          <AlertDescription>{a.noSiteUrl}</AlertDescription>
        </Alert>
      ) : null}
      <Box display="grid" gap={5}>
        <FormControl display="flex" alignItems="flex-start" gap={3}>
          <Switch
            id="ai-enabled"
            colorScheme="purple"
            mt={1}
            isChecked={settings.enabled}
            isDisabled={lockedByServer || busy === 'enabled'}
            onChange={(e) => {
              if (e.target.checked) void patchSettings('enabled', { enabled: true }, a.turnedOn, a.stepUpMaster)
              else {
                setEndApps(false)
                setClearSchedules(false)
                setOffOpen(true)
              }
            }}
            aria-describedby="ai-enabled-help"
          />
          <Box>
            <FormLabel htmlFor="ai-enabled" mb={0.5} fontSize="sm" fontWeight={600}>
              {a.master}
            </FormLabel>
            <FormHelperText id="ai-enabled-help" mt={0} fontSize="xs" color="page.fg-secondary" maxW="62ch">
              {a.masterHelp}
            </FormHelperText>
          </Box>
        </FormControl>
        <FormControl display="flex" alignItems="flex-start" gap={3}>
          <Switch
            id="ai-apps-allowed"
            colorScheme="purple"
            mt={1}
            isChecked={settings.mcpEnabled}
            isDisabled={lockedByServer || busy === 'apps' || (!settings.mcpEnabled && (!settings.enabled || !access.siteUrl))}
            onChange={(e) =>
              e.target.checked
                ? void patchSettings('apps', { mcpEnabled: true }, a.appsAllowed, a.stepUpApps)
                : void patchSettings('apps', { mcpEnabled: false }, a.appsStopped)
            }
            aria-describedby="ai-apps-help"
          />
          <Box>
            <FormLabel htmlFor="ai-apps-allowed" mb={0.5} fontSize="sm" fontWeight={600}>
              {a.apps}
            </FormLabel>
            <FormHelperText id="ai-apps-help" mt={0} fontSize="xs" color="page.fg-secondary" maxW="62ch">
              {a.appsHelp}
              {!settings.enabled ? ` ${a.appsNeedsMaster}` : !access.siteUrl ? ` ${a.appsNeedsSiteUrl}` : ''}
            </FormHelperText>
          </Box>
        </FormControl>
      </Box>

      {/* [02] Connect an app */}
      <SectionLabel index={SECTION.connect} title={AI_COPY.connect.title} id="ai-connect" hint={AI_COPY.connect.hint} />
      {localPage ? (
        <Alert status="info" variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={4} fontSize="sm" alignItems="flex-start">
          <AlertIcon mt={0.5} />
          <AlertDescription>{AI_COPY.connect.localBanner}</AlertDescription>
        </Alert>
      ) : null}
      <Box mb={5}>
        <Flex align="baseline" justify="space-between" gap={3} flexWrap="wrap" mb={1.5}>
          <Text fontSize="12px" fontWeight={600}>
            {AI_COPY.connect.server}
          </Text>
          <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary">
            {AI_COPY.connect.transport}
          </Text>
        </Flex>
        {server ? (
          <CopyField label={AI_COPY.connect.server} value={server} />
        ) : (
          <Text fontSize="sm" color="page.fg-secondary">
            {AI_COPY.connect.noServer}
          </Text>
        )}
      </Box>
      <ClientSetupTabs
        server={server}
        name={name}
        envVar={envVar}
        open={canCreate}
        localPage={localPage}
        fetchWithStepUp={fetchWithStepUp}
        onNewToken={() => setNewToken(true)}
        onConnected={onOAuthConnected}
        onUnauthorized={toLogin}
      />
      {watched ? (
        <Box mt={5}>
          <FirstCallStatus app={watched} now={now} />
        </Box>
      ) : null}

      {/* [03] Connected apps */}
      <ConnectedApps index={SECTION.apps} apps={apps} now={now} busy={busy} schedules={data.schedules} onRename={rename} onRevoke={revoke} onRevokeAll={revokeAll} />

      {/* [04] What apps can do */}
      <SectionLabel index={SECTION.catalogue} title={AI_COPY.catalogue.title} id="ai-catalogue" hint={AI_COPY.catalogue.hint} />
      <ToolCatalogue tools={data.tools} levels={data.levels} />

      {/* Dialogs */}
      {server ? (
        <NewTokenDialog
          isOpen={newToken}
          onClose={() => setNewToken(false)}
          tools={data.tools}
          levels={data.levels}
          lifetimes={data.lifetimes}
          defaultDays={data.defaultDays}
          server={server}
          fetchWithStepUp={fetchWithStepUp}
          onCreated={(app) => {
            // The page's clock moves on with the new row, so "made" reads from now, not from the last tick.
            setNow(Date.now())
            setWatchId(app.id)
            setData((d) => (d ? { ...d, apps: [app, ...d.apps.filter((x) => x.id !== app.id)] } : d))
          }}
          liveApp={watched}
          now={now}
        />
      ) : null}

      <AlertDialog isOpen={offOpen} leastDestructiveRef={offCancelRef} onClose={() => setOffOpen(false)} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
            <AlertDialogHeader fontSize="md">{a.offDialog.title}</AlertDialogHeader>
            <AlertDialogBody fontSize="sm">
              <Text>{a.offDialog.body}</Text>
              {apps.length > 0 ? (
                <>
                  <Checkbox mt={4} isChecked={endApps} onChange={(e) => setEndApps(e.target.checked)} colorScheme="purple" aria-describedby="ai-off-end-help">
                    <Text as="span" fontSize="sm">
                      {a.offDialog.endApps}
                    </Text>
                  </Checkbox>
                  <Text id="ai-off-end-help" mt={1} ml={6} fontSize="12px" color="page.fg-secondary">
                    {a.offDialog.endAppsHelp(apps.length)}
                  </Text>
                </>
              ) : null}
              <AiSchedulesNote id="ai-off-schedules" schedules={data.schedules} checked={clearSchedules} onChange={setClearSchedules} />
            </AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button ref={offCancelRef} size="sm" {...outlineButtonProps} onClick={() => setOffOpen(false)}>
                {a.offDialog.cancel}
              </Button>
              <Button
                size="sm"
                colorScheme="red"
                onClick={async () => {
                  setOffOpen(false)
                  const clear = clearSchedules ? data.schedules : []
                  await patchSettings('enabled', endApps && apps.length > 0 ? { enabled: false, endApps: true } : { enabled: false }, a.turnedOff)
                  await clearChosen(clear)
                }}
              >
                {a.offDialog.confirm}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
      {stepUpElement}
    </Box>
  )
}
