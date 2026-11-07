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
  Flex,
  FormControl,
  FormErrorMessage,
  FormHelperText,
  FormLabel,
  Grid,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Select,
  Skeleton,
  Switch,
  Text,
  useToast,
} from '@chakra-ui/react'
import { FiMoreHorizontal } from 'react-icons/fi'
import { MONO, SectionLabel, inputProps, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { loginHref, readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { useStepUp } from '../security/useStepUp'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { relativeTime } from '../security/securityFormat'
import { AI_COPY, MODELS_COPY } from './copy'
import AiStatusStrip from './AiStatusStrip'
import AddModelDrawer, { type DrawerMode } from './AddModelDrawer'
import ProbeResult, { ModelStatusChip } from './ProbeResult'
import UsageTable from './UsageTable'
import { assistantTile, modelStatusOf } from './assistantFormat'
import { sinceTime } from './format'
import type { AiSettingsView, AiSummaryView, CatalogueTool, ProviderView, ProvidersAnswer, UsageAnswer } from './types'

const M = MODELS_COPY
const SECTION = { models: 1, assistant: 2, usage: 3, leaves: 4 } as const
const RETURN_PATH = '/admin/ai?view=models'
const KEEP_CHOICES = ['30', '90', '-1', '0'] as const
const CEILING = 20_000_000

class Unauthorized extends Error {}

async function getJson<T = Record<string, any>>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  if (res.status === 401) throw new Unauthorized()
  const json = await readJsonObject(res)
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`)
  return json as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })

type Loaded = { providers: ProvidersAnswer; settings: AiSettingsView | null; usage: UsageAnswer | null; tools: CatalogueTool[]; summary: AiSummaryView | null }

/**
 * Admin → AI → Models (design §7.3, §7.4, §7.7, §8.1, §10.4; PRODUCT §8):
 * [01] Models — each saved key with its model, address, status and last
 * Test; Test, Edit, Replace key, Use for new chats, Remove; Add a model.
 * [02] Assistant — the model new chats use, drafts without asking, how long
 * conversations stay, the daily limit, Delete all conversations. [03] Usage —
 * as providers reported it. [04] What leaves this server — from the catalogue
 * and the retention rules. Loosening asks "Confirm it's you"; tightening and
 * removing never do. A key never reaches the browser.
 */
export default function ModelsPanel({ openAdd = false, onAddHandled, onShowChanges }: { openAdd?: boolean; onAddHandled?: () => void; onShowChanges?: () => void }) {
  const toast = useToast()
  const { fetchWithStepUp, stepUpElement } = useStepUp()
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [drawer, setDrawer] = useState<DrawerMode | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProviderView | null>(null)
  const [deleteAll, setDeleteAll] = useState(false)
  const [limit, setLimit] = useState('')
  const [limitError, setLimitError] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const removeCancel = useRef<HTMLButtonElement>(null)
  const deleteCancel = useRef<HTMLButtonElement>(null)

  const toLogin = useCallback(() => {
    window.location.href = loginHref(RETURN_PATH)
  }, [])

  const load = useCallback(async () => {
    try {
      const providers = await getJson<ProvidersAnswer>('/api/admin/ai/providers')
      const [settings, usage, catalogue, summary] = await Promise.allSettled([
        getJson<{ settings: AiSettingsView }>('/api/admin/ai/settings'),
        getJson<UsageAnswer>('/api/admin/ai/usage?days=31'),
        getJson<{ tools: CatalogueTool[] }>('/api/admin/ai/catalogue'),
        getJson<AiSummaryView>('/api/admin/ai/summary'),
      ])
      const s = settings.status === 'fulfilled' ? settings.value.settings : null
      setData({
        providers,
        settings: s,
        usage: usage.status === 'fulfilled' ? usage.value : null,
        tools: catalogue.status === 'fulfilled' && Array.isArray(catalogue.value.tools) ? catalogue.value.tools : [],
        summary: summary.status === 'fulfilled' ? summary.value : null,
      })
      if (s) setLimit(String(s.dailyTokenLimit))
      setNow(Date.now())
      setLoadError('')
    } catch (err) {
      if (err instanceof Unauthorized) return toLogin()
      setLoadError(err instanceof Error && err.message !== 'Failed to fetch' ? err.message : NETWORK_ERROR)
    }
  }, [toLogin])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [load])

  // Arrived from the assistant's "Add a model".
  useEffect(() => {
    if (openAdd && data) {
      setDrawer({ kind: 'add' })
      onAddHandled?.()
    }
  }, [openAdd, data, onAddHandled])

  const fail = (title: string, res: Response | null, json: Record<string, unknown> = {}) => {
    if (res && wasStepUpCancelled(res)) return
    if (res?.status === 401) return toLogin()
    toast({ status: 'error', title, description: typeof json.error === 'string' ? json.error : res ? `HTTP ${res.status}` : NETWORK_ERROR, duration: 6000, isClosable: true })
  }

  const test = async (p: ProviderView) => {
    setBusy(`test:${p.id}`)
    try {
      const res = await fetch('/api/admin/ai/providers/test', jsonInit('POST', { providerId: p.id }))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(M.toast.notTested, res, json)
      const status = (json.result as { status?: string } | undefined)?.status ?? 'failed'
      toast({ status: status === 'ready' ? 'success' : 'warning', title: M.toast.tested, description: `${p.label}: ${M.status[status] ?? status}` })
      setOpened(p.id)
      await load()
    } catch {
      fail(M.toast.notTested, null)
    } finally {
      setBusy(null)
    }
  }

  const makeDefault = async (p: ProviderView) => {
    setBusy(`default:${p.id}`)
    try {
      const res = await fetch('/api/admin/ai/providers', jsonInit('PATCH', { id: p.id, makeDefault: true }))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(M.toast.notChanged, res, json)
      toast({ status: 'success', title: M.toast.defaultSet, description: p.label })
      await load()
    } catch {
      fail(M.toast.notChanged, null)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    const p = removing
    if (!p) return
    setRemoving(null)
    setBusy(`remove:${p.id}`)
    try {
      const res = await fetch('/api/admin/ai/providers', jsonInit('DELETE', { id: p.id }))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(M.remove.failed, res, json)
      toast({ status: 'success', title: M.remove.done, description: M.remove.doneHint(typeof json.revokeAt === 'string' ? json.revokeAt : p.presetName), duration: 9000, isClosable: true })
      await load()
    } catch {
      fail(M.remove.failed, null)
    } finally {
      setBusy(null)
    }
  }

  /** PATCH the assistant's settings; `stepUp` names why a loosening change asks first. */
  const patchSettings = async (key: string, body: Partial<AiSettingsView>, stepUp?: string): Promise<boolean> => {
    setBusy(key)
    try {
      const res = stepUp ? await fetchWithStepUp('/api/admin/ai/settings', jsonInit('PATCH', body), stepUp) : await fetch('/api/admin/ai/settings', jsonInit('PATCH', body))
      const json = await readJsonObject(res)
      if (!res.ok) {
        fail(M.assistant.notSaved, res, json)
        return false
      }
      const settings = json.settings as AiSettingsView
      setData((d) => (d ? { ...d, settings } : d))
      if (settings) setLimit(String(settings.dailyTokenLimit))
      toast({ status: 'success', title: M.assistant.saved })
      return true
    } catch {
      fail(M.assistant.notSaved, null)
      return false
    } finally {
      setBusy(null)
    }
  }

  const removeAllConversations = async () => {
    setDeleteAll(false)
    setBusy('delete-all')
    try {
      const res = await fetch('/api/admin/ai/conversations', jsonInit('DELETE', { all: true }))
      const json = await readJsonObject(res)
      if (!res.ok) return fail(M.assistant.notSaved, res, json)
      toast({ status: 'success', title: M.assistant.deletedAll(typeof json.deleted === 'number' ? json.deleted : 0) })
    } catch {
      fail(M.assistant.notSaved, null)
    } finally {
      setBusy(null)
    }
  }

  if (loadError && !data) {
    return (
      <Alert status="error" variant="left-accent" borderRadius="md" bg="page.bg-elevated">
        <AlertIcon />
        <AlertDescription fontSize="sm" flex={1}>
          {M.loadError(loadError)}
        </AlertDescription>
        <Button size="sm" {...outlineButtonProps} onClick={() => void load()}>
          {M.retry}
        </Button>
      </Alert>
    )
  }
  if (!data) {
    return (
      <Box aria-busy="true" aria-label={M.loading}>
        <Skeleton h="88px" borderRadius="xl" />
        <Skeleton h="160px" borderRadius="xl" mt={6} />
        <Skeleton h="200px" borderRadius="xl" mt={6} />
      </Box>
    )
  }

  const { providers: pv, settings, usage, summary } = data
  const list = pv.providers
  const access = summary?.access ?? null
  const keepValue = settings ? (KEEP_CHOICES.includes(String(settings.keepConversationsDays) as (typeof KEEP_CHOICES)[number]) ? String(settings.keepConversationsDays) : 'custom') : '90'
  const keepText = !settings ? M.leaves.keepNone : settings.keepConversationsDays === -1 ? M.leaves.keepForever : settings.keepConversationsDays === 0 ? M.leaves.keepNone : M.assistant.keepDays(settings.keepConversationsDays)
  const readTools = data.tools.filter((t) => t.risk === 'read').map((t) => t.title)

  return (
    <Box>
      <Box mb={2}>
        <AiStatusStrip
          tiles={[
            {
              label: AI_COPY.strip.access,
              value: access && access.enabled && !access.blocked ? AI_COPY.strip.on : AI_COPY.strip.off,
              sub: access ? AI_COPY.strip.accessSub(access) : M.strip.unreadable,
            },
            { index: SECTION.models, ...assistantTile(summary?.assistant ?? null) },
            {
              label: AI_COPY.strip.apps,
              value: summary ? String(summary.apps.connected) : '—',
              sub: summary ? AI_COPY.strip.appsSub(summary.apps.connected, summary.apps.lastUsedAt ? relativeTime(summary.apps.lastUsedAt, now) : null) : M.strip.unreadable,
            },
            {
              label: AI_COPY.strip.waiting,
              value: summary?.waiting == null ? '—' : String(summary.waiting),
              sub: AI_COPY.strip.waitingSub(summary?.waiting ?? null),
              action: summary?.waiting && onShowChanges ? { label: AI_COPY.strip.review, onClick: onShowChanges } : undefined,
            },
          ]}
        />
      </Box>

      {/* [01] Models */}
      <SectionLabel
        index={SECTION.models}
        title={M.sections.models}
        id="ai-models"
        hint={M.sections.modelsHint}
        action={
          list.length ? (
            <Button size="sm" {...primaryButtonProps} onClick={() => setDrawer({ kind: 'add' })} isDisabled={!pv.keys.canStore && !pv.presets.some((p) => p.keyOptional && p.available)} data-testid="add-model">
              {M.add}
            </Button>
          ) : null
        }
      />
      {!pv.keys.canStore ? (
        <Alert status="warning" variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={4} fontSize="sm">
          <AlertIcon />
          <AlertDescription>{M.noSecret}</AlertDescription>
        </Alert>
      ) : null}
      {pv.claudeBlocked ? (
        <Alert status="warning" variant="left-accent" borderRadius="md" bg="page.bg-elevated" mb={4} fontSize="sm">
          <AlertIcon />
          <AlertDescription>{pv.claudeBlocked}</AlertDescription>
        </Alert>
      ) : null}
      {!list.length ? (
        <Box border="1px solid" borderColor="page.border" borderRadius="xl" p={{ base: 4, md: 5 }}>
          <Text fontSize="md" fontWeight={600}>
            {M.empty}
          </Text>
          <Text fontSize="sm" color="page.fg-secondary" mt={1}>
            {M.emptyHint}
          </Text>
          <Grid as="ul" listStyleType="none" templateColumns={{ base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))', lg: 'repeat(5, minmax(0, 1fr))' }} gap={2} mt={4} aria-label={M.drawer.providersLabel}>
            {pv.presets.map((p) => (
              <Box as="li" key={p.id} minW={0}>
                <Button
                  {...outlineButtonProps}
                  w="100%"
                  h="auto"
                  minH="56px"
                  py={2.5}
                  px={3}
                  display="flex"
                  flexDirection="column"
                  alignItems="flex-start"
                  justifyContent="center"
                  textAlign="left"
                  whiteSpace="normal"
                  isDisabled={!p.available || (!pv.keys.canStore && !p.keyOptional)}
                  onClick={() => setDrawer({ kind: 'add', preset: p.id })}
                  data-preset={p.id}
                >
                  <Text as="span" fontSize="13px" fontWeight={600}>
                    {p.name}
                  </Text>
                  <Text as="span" fontFamily={MONO} fontSize="10px" fontWeight={400} color="page.fg-secondary" noOfLines={1} maxW="100%" mt={0.5}>
                    {p.hosts[0] ?? (p.hostFromFields === 'qwen' ? '*.maas.aliyuncs.com' : p.id === 'custom' ? 'https://…' : '')}
                  </Text>
                </Button>
              </Box>
            ))}
          </Grid>
          {pv.presets.some((p) => !p.available) ? (
            <Text fontSize="xs" color="page.fg-secondary" mt={3}>
              {M.drawer.unavailable}
            </Text>
          ) : null}
        </Box>
      ) : (
        <Box as="ul" listStyleType="none" border="1px solid" borderColor="page.border" borderRadius="xl" overflow="hidden">
          {list.map((p) => {
            const lastTest = p.defaultModel ? p.tests[p.defaultModel] : undefined
            const isOpen = opened === p.id
            return (
              <Box as="li" key={p.id} px={{ base: 4, md: 5 }} py={4} borderTop="1px solid" borderColor="page.border" _first={{ borderTop: 'none' }} data-provider={p.id}>
                <Flex align="flex-start" justify="space-between" gap={3} flexWrap="wrap">
                  <Box minW={0} flex="1 1 260px">
                    <Flex align="center" gap={2} flexWrap="wrap">
                      <Text fontSize="sm" fontWeight={600} wordBreak="break-word">
                        {p.label}
                      </Text>
                      {p.isDefault ? (
                        <Text as="span" fontFamily={MONO} fontSize="9px" letterSpacing="0.08em" textTransform="uppercase" color="accent.text" border="1px solid" borderColor="accent.500" borderRadius="3px" px="5px" lineHeight="16px">
                          {M.row.default}
                        </Text>
                      ) : null}
                      <ModelStatusChip status={modelStatusOf(p)} />
                    </Flex>
                    <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={1} wordBreak="break-word">
                      {[p.defaultModel ?? M.row.noModel, p.baseUrlHost, p.hasKey && p.keyHint ? M.row.key(p.keyHint) : M.row.noKey, lastTest ? M.row.tested(sinceTime(lastTest.at, now)) : null, p.lastUsedAt ? M.row.used(sinceTime(p.lastUsedAt, now)) : M.row.neverUsed].filter(Boolean).join(' · ')}
                    </Text>
                    {p.keyState === 'reenter' ? (
                      <Text fontSize="xs" color="status.error" mt={1.5}>
                        {M.row.reenter}
                      </Text>
                    ) : null}
                  </Box>
                  <Flex gap={2} align="center" flexShrink={0}>
                    <Button size="sm" {...outlineButtonProps} onClick={() => void test(p)} isLoading={busy === `test:${p.id}`} loadingText={M.row.testing} isDisabled={!p.defaultModel || p.keyState === 'reenter' || p.keyState === 'no-secret' || (busy !== null && busy !== `test:${p.id}`)} minH={{ base: '44px', md: '32px' }}>
                      {M.row.test}
                    </Button>
                    <Menu placement="bottom-end" isLazy>
                      <MenuButton as={IconButton} size="sm" {...outlineButtonProps} icon={<FiMoreHorizontal aria-hidden />} aria-label={M.row.actions(p.label)} minW={{ base: '44px', md: '32px' }} h={{ base: '44px', md: '32px' }} />
                      <MenuList fontSize="sm" zIndex={20}>
                        <MenuItem onClick={() => setDrawer({ kind: 'edit', provider: p })}>{M.row.edit}</MenuItem>
                        <MenuItem onClick={() => setDrawer({ kind: 'replace', provider: p })}>{M.row.replaceKey}</MenuItem>
                        {!p.isDefault ? <MenuItem onClick={() => void makeDefault(p)}>{M.row.makeDefault}</MenuItem> : null}
                        <MenuItem color="status.error" onClick={() => setRemoving(p)}>
                          {M.row.remove}
                        </MenuItem>
                      </MenuList>
                    </Menu>
                  </Flex>
                </Flex>
                {lastTest ? (
                  <Box mt={2}>
                    <Button variant="link" size="xs" color="accent.text" fontWeight={500} aria-expanded={isOpen} aria-controls={`probe-${p.id}`} onClick={() => setOpened(isOpen ? null : p.id)}>
                      {isOpen ? '▾' : '▸'} {M.row.details}
                    </Button>
                    <Box id={`probe-${p.id}`} hidden={!isOpen} mt={2} pl={3} borderLeft="1px solid" borderColor="page.border">
                      {isOpen ? <ProbeResult result={lastTest} now={now} /> : null}
                    </Box>
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )}

      {/* [02] Assistant */}
      <SectionLabel index={SECTION.assistant} title={M.sections.assistant} id="ai-assistant-settings" hint={M.sections.assistantHint} />
      {settings ? (
        <Box display="grid" gap={6}>
          <FormControl maxW="420px">
            <FormLabel htmlFor="ai-default-model" fontSize="sm" fontWeight={600} mb={1.5}>
              {M.assistant.defaultModel}
            </FormLabel>
            {list.length ? (
              <Select
                id="ai-default-model"
                value={list.find((p) => p.isDefault)?.id ?? ''}
                onChange={(e) => {
                  const p = list.find((x) => x.id === e.target.value)
                  if (p) void makeDefault(p)
                }}
                fontSize="sm"
                isDisabled={busy !== null}
                {...inputProps}
              >
                {!list.some((p) => p.isDefault) ? <option value="">—</option> : null}
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.defaultModel ?? M.row.noModel}
                  </option>
                ))}
              </Select>
            ) : (
              <Text fontSize="sm" color="page.fg-secondary">
                {M.assistant.noModels}
              </Text>
            )}
          </FormControl>

          <FormControl display="flex" alignItems="flex-start" gap={3}>
            <Switch
              id="ai-auto-drafts"
              colorScheme="purple"
              mt={1}
              isChecked={settings.autoApplyDrafts}
              isDisabled={busy === 'drafts'}
              onChange={(e) => void patchSettings('drafts', { autoApplyDrafts: e.target.checked }, e.target.checked ? M.assistant.stepUpDrafts : undefined)}
              aria-describedby="ai-auto-drafts-help"
            />
            <Box>
              <FormLabel htmlFor="ai-auto-drafts" mb={0.5} fontSize="sm" fontWeight={600}>
                {M.assistant.drafts}
              </FormLabel>
              <FormHelperText id="ai-auto-drafts-help" mt={0} fontSize="xs" color="page.fg-secondary" maxW="62ch">
                {M.assistant.draftsHelp}
              </FormHelperText>
            </Box>
          </FormControl>

          <FormControl maxW="420px">
            <FormLabel htmlFor="ai-keep" fontSize="sm" fontWeight={600} mb={1.5}>
              {M.assistant.keep}
            </FormLabel>
            <Select
              id="ai-keep"
              value={keepValue}
              isDisabled={busy === 'keep'}
              onChange={(e) => {
                const v = Number(e.target.value)
                const rank = (d: number) => (d === -1 ? Infinity : d)
                void patchSettings('keep', { keepConversationsDays: v }, rank(v) > rank(settings.keepConversationsDays) ? M.assistant.stepUpKeep : undefined)
              }}
              fontSize="sm"
              {...inputProps}
              aria-describedby="ai-keep-help"
            >
              {keepValue === 'custom' ? <option value="custom">{M.assistant.keepDays(settings.keepConversationsDays)}</option> : null}
              {KEEP_CHOICES.map((k) => (
                <option key={k} value={k}>
                  {M.assistant.keepOptions[k]}
                </option>
              ))}
            </Select>
            <FormHelperText id="ai-keep-help" fontSize="xs" color="page.fg-secondary">
              {M.assistant.keepHelp}
            </FormHelperText>
          </FormControl>

          <FormControl maxW="420px" isInvalid={!!limitError}>
            <FormLabel htmlFor="ai-limit" fontSize="sm" fontWeight={600} mb={1.5}>
              {M.assistant.limit}
            </FormLabel>
            <Flex gap={2}>
              <Input id="ai-limit" value={limit} onChange={(e) => (setLimit(e.target.value.replace(/[^0-9]/g, '')), setLimitError(''))} inputMode="numeric" fontFamily={MONO} fontSize="sm" {...inputProps} aria-describedby="ai-limit-help" />
              <Button
                size="md"
                {...outlineButtonProps}
                flexShrink={0}
                isLoading={busy === 'limit'}
                isDisabled={limit === String(settings.dailyTokenLimit)}
                onClick={() => {
                  const v = Number(limit)
                  if (!limit || !Number.isInteger(v) || v < 0 || v > CEILING) return setLimitError(M.assistant.limitInvalid(CEILING.toLocaleString('en')))
                  void patchSettings('limit', { dailyTokenLimit: v }, v > settings.dailyTokenLimit ? M.assistant.stepUpLimit : undefined)
                }}
              >
                {M.assistant.limitSave}
              </Button>
            </Flex>
            {limitError ? (
              <FormErrorMessage>{limitError}</FormErrorMessage>
            ) : (
              <FormHelperText id="ai-limit-help" fontSize="xs" color="page.fg-secondary">
                {M.assistant.limitHelp(CEILING.toLocaleString('en'))}
              </FormHelperText>
            )}
          </FormControl>

          <Box>
            <Button size="sm" colorScheme="red" variant="outline" onClick={() => setDeleteAll(true)} isLoading={busy === 'delete-all'}>
              {M.assistant.deleteAll}
            </Button>
          </Box>
        </Box>
      ) : (
        <Text fontSize="sm" color="page.fg-secondary">
          {M.strip.unreadable}
        </Text>
      )}

      {/* [03] Usage */}
      <SectionLabel index={SECTION.usage} title={M.sections.usage} id="ai-usage" hint={M.sections.usageHint} />
      {usage ? <UsageTable usage={usage} now={now} /> : <Text fontSize="sm" color="page.fg-secondary">{M.strip.unreadable}</Text>}

      {/* [04] What leaves this server */}
      <SectionLabel index={SECTION.leaves} title={M.sections.leaves} id="ai-leaves" hint={M.sections.leavesHint} />
      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }} gap={3} data-leaves="">
        <Box border="1px solid" borderColor="page.border" borderRadius="xl" p={4}>
          <Text fontSize="sm" fontWeight={600}>
            {M.leaves.goes}
          </Text>
          <Text fontSize="13px" color="page.fg-secondary" mt={1.5}>
            {M.leaves.goesIntro}
          </Text>
          {readTools.length ? (
            <Box as="ul" mt={2} pl={4} fontSize="13px" sx={{ listStyleType: 'disc' }}>
              {readTools.map((t) => (
                <Box as="li" key={t}>
                  {t}
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
        <Box border="1px solid" borderColor="page.border" borderRadius="xl" p={4}>
          <Text fontSize="sm" fontWeight={600}>
            {M.leaves.never}
          </Text>
          <Text fontSize="13px" color="page.fg-secondary" mt={1.5}>
            {M.leaves.neverList}
          </Text>
        </Box>
        <Box border="1px solid" borderColor="page.border" borderRadius="xl" p={4}>
          <Text fontSize="sm" fontWeight={600}>
            {M.leaves.stored}
          </Text>
          <Box as="ul" mt={1.5} pl={4} fontSize="13px" color="page.fg-secondary" sx={{ listStyleType: 'disc', '& > li + li': { mt: 1 } }}>
            <Box as="li">{M.leaves.conversations(keepText)}</Box>
            <Box as="li">{M.leaves.keys}</Box>
            <Box as="li">{M.leaves.calls}</Box>
            <Box as="li">{M.leaves.usage}</Box>
            <Box as="li">{M.leaves.before}</Box>
          </Box>
        </Box>
      </Grid>

      <AddModelDrawer
        mode={drawer}
        onClose={() => setDrawer(null)}
        data={pv}
        fetchWithStepUp={fetchWithStepUp}
        onUnauthorized={toLogin}
        now={now}
        onSaved={(p) => {
          if (p?.id) setOpened(p.id)
          void load()
        }}
      />

      <AlertDialog isOpen={!!removing} leastDestructiveRef={removeCancel} onClose={() => setRemoving(null)} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
            <AlertDialogHeader fontSize="md">{removing ? M.remove.title(removing.label) : ''}</AlertDialogHeader>
            <AlertDialogBody fontSize="sm">{removing ? M.remove.body(removing.presetName) : ''}</AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button ref={removeCancel} size="sm" {...outlineButtonProps} onClick={() => setRemoving(null)}>
                {M.remove.cancel}
              </Button>
              <Button size="sm" colorScheme="red" onClick={() => void remove()}>
                {M.remove.confirm}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>

      <AlertDialog isOpen={deleteAll} leastDestructiveRef={deleteCancel} onClose={() => setDeleteAll(false)} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
            <AlertDialogHeader fontSize="md">{M.assistant.deleteAllTitle}</AlertDialogHeader>
            <AlertDialogBody fontSize="sm">{M.assistant.deleteAllBody}</AlertDialogBody>
            <AlertDialogFooter gap={2}>
              <Button ref={deleteCancel} size="sm" {...outlineButtonProps} onClick={() => setDeleteAll(false)}>
                {M.remove.cancel}
              </Button>
              <Button size="sm" colorScheme="red" onClick={() => void removeAllConversations()}>
                {M.assistant.deleteAllConfirm}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
      {stepUpElement}
    </Box>
  )
}
