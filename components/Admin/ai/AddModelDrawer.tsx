import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  Flex,
  FormControl,
  FormErrorMessage,
  FormHelperText,
  FormLabel,
  Grid,
  Input,
  Link,
  Select,
  Switch,
  Text,
  useBreakpointValue,
  useToast,
} from '@chakra-ui/react'
import { Eyebrow, MONO, inputProps, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { MODELS_COPY } from './copy'
import ProbeResult from './ProbeResult'
import type { ModelOption, OwnerQuirks, PresetView, ProbeView, ProviderView, ProvidersAnswer } from './types'

const D = MODELS_COPY.drawer

export type DrawerMode = { kind: 'add'; preset?: string } | { kind: 'edit'; provider: ProviderView } | { kind: 'replace'; provider: ProviderView }

type FetchWithStepUp = (input: string, init?: RequestInit, reason?: string) => Promise<Response>

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })

/**
 * Add a model, edit one, or replace its key (design §7.3, §7.4, §7.7, §10.4;
 * PRODUCT §8.1). The PublishSheet placement: a bottom sheet on phones, a
 * right drawer from md.
 *
 *   1. Provider: a grid of plain tiles (name and host; no logos). Custom
 *      takes an https address and its wire; Qwen its Workspace ID and region;
 *      a preset with a second official host offers it. The data notice for
 *      the provider (with its source and the day it was read) or Custom's
 *      trust line, and the advice on keys.
 *   2. Key: typed once, sent only to this server, stored encrypted and
 *      never shown again. Check key reads the models the key can use today.
 *   3. Model: from that list or typed (free text always works); effort and
 *      the advanced settings of the key.
 *   4. Test: the real probe on this key, with the site's whole tool list.
 *
 * Save asks "Confirm it's you" (a stored key spends on the owner's account);
 * a Custom address needs it for Check key and Test too. The browser never
 * holds a Test result the server would trust: Save carries the server's own.
 */
export default function AddModelDrawer({
  mode,
  onClose,
  data,
  fetchWithStepUp,
  onSaved,
  onUnauthorized,
  now,
}: {
  mode: DrawerMode | null
  onClose: () => void
  data: ProvidersAnswer
  fetchWithStepUp: FetchWithStepUp
  onSaved: (p: ProviderView, kind: DrawerMode['kind']) => void
  onUnauthorized: () => void
  now: number
}) {
  const toast = useToast()
  const placement = useBreakpointValue<'bottom' | 'right'>({ base: 'bottom', md: 'right' }, { ssr: false }) ?? 'right'
  const editing = mode && mode.kind !== 'add' ? mode.provider : null
  const [presetId, setPresetId] = useState<string | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [wire, setWire] = useState<'chat' | 'responses'>('chat')
  const [workspaceId, setWorkspaceId] = useState('')
  const [region, setRegion] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ModelOption[] | null>(null)
  const [listed, setListed] = useState(true)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [label, setLabel] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [echo, setEcho] = useState(true)
  const [maxField, setMaxField] = useState<'max_tokens' | 'max_completion_tokens' | ''>('')
  const [maxOutput, setMaxOutput] = useState('')
  const [busy, setBusy] = useState<'check' | 'test' | 'save' | null>(null)
  const [error, setError] = useState<{ field: string | null; text: string } | null>(null)
  const [test, setTest] = useState<{ sig: string; result: ProbeView } | null>(null)
  const keyRef = useRef<HTMLInputElement>(null)

  const preset: PresetView | null = useMemo(() => data.presets.find((p) => p.id === (editing?.preset ?? presetId)) ?? null, [data.presets, editing, presetId])
  const isCustom = preset?.id === 'custom'
  const isQwen = preset?.hostFromFields === 'qwen'
  const isClaude = preset?.wire === 'anthropic'
  const chatWire = isCustom ? wire === 'chat' : preset?.wire === 'chat'

  // A fresh form each time the drawer opens.
  useEffect(() => {
    if (!mode) return
    const p = mode.kind === 'add' ? null : mode.provider
    setPresetId(mode.kind === 'add' ? (mode.preset ?? null) : p?.preset ?? null)
    setBaseUrl('')
    setWire(p?.wire === 'responses' ? 'responses' : 'chat')
    setWorkspaceId('')
    setRegion('')
    setApiKey('')
    setModels(null)
    setListed(true)
    setModel(p?.defaultModel ?? '')
    setEffort(p?.effort ?? '')
    setLabel(p?.label ?? '')
    setMakeDefault(mode.kind === 'add' ? data.providers.length === 0 : !!p?.isDefault)
    setEcho(p?.quirks.echoReasoning ?? true)
    setMaxField(p?.quirks.maxTokensField ?? '')
    setMaxOutput(p?.quirks.maxOutputTokens ? String(p.quirks.maxOutputTokens) : '')
    setBusy(null)
    setError(null)
    setTest(null)
    // Replacing a key of a preset with two official hosts: the host it uses now.
    if (mode.kind === 'replace' && p) {
      const pr = data.presets.find((x) => x.id === p.preset)
      if (pr && pr.baseUrls.length > 1) setBaseUrl(pr.baseUrls.find((u) => hostOf(u) === p.baseUrlHost) ?? pr.baseUrls[0])
    }
  }, [mode, data.providers.length, data.presets])

  // A preset chosen for a new key: its default host, its name, Claude's default effort.
  useEffect(() => {
    if (!preset || editing) return
    setBaseUrl(preset.baseUrls[0] ?? '')
    setLabel(preset.id === 'custom' ? '' : preset.name)
    setEffort(preset.wire === 'anthropic' ? 'medium' : '')
    setModels(null)
    setModel('')
    setTest(null)
    setError(null)
  }, [preset, editing])

  const quirks = (): OwnerQuirks | undefined => {
    const q: OwnerQuirks = {}
    if (!isClaude) {
      if (!echo) q.echoReasoning = false
      if (maxField && chatWire) q.maxTokensField = maxField
      if (maxOutput.trim()) q.maxOutputTokens = Number(maxOutput)
    }
    return Object.keys(q).length ? q : undefined
  }

  /** Where a typed key goes (the server resolves and checks it again). */
  const target = (): Record<string, unknown> => {
    if (!preset) return {}
    const t: Record<string, unknown> = { preset: preset.id }
    if (isCustom) {
      t.baseUrl = baseUrl.trim()
      t.wire = wire
    } else if (isQwen) {
      t.workspaceId = workspaceId.trim()
      t.region = region.trim()
    } else if (preset.baseUrls.length > 1 || preset.local) t.baseUrl = baseUrl || preset.baseUrls[0]
    return t
  }

  /** The two request shapes of Check key and Test, never a mix: the saved key with its own address, or a typed one. */
  const keyShape = (withModel: boolean): Record<string, unknown> => {
    if (mode?.kind === 'edit' && editing) return { providerId: editing.id, ...(withModel && model.trim() ? { model: model.trim() } : {}) }
    const body: Record<string, unknown> = { ...target(), ...(apiKey.trim() ? { typedKey: apiKey.trim() } : {}) }
    if (withModel && model.trim()) body.model = model.trim()
    if (withModel && effort) body.effort = effort
    const q = quirks()
    if (q) body.quirks = q
    return body
  }
  const signature = () => JSON.stringify(keyShape(true))
  const customStepUp = mode?.kind !== 'edit' && isCustom ? D.stepUpUrl : undefined

  const fail = (res: Response | null, body: Record<string, unknown> = {}) => {
    if (res && wasStepUpCancelled(res)) return
    if (res?.status === 401) return onUnauthorized()
    const field = typeof body.field === 'string' ? body.field : null
    let text = typeof body.error === 'string' ? body.error : res ? `HTTP ${res.status}` : NETWORK_ERROR
    if (body.code === 'KEY_REFUSED' && preset) text = D.keyRefused(preset.name, typeof body.error === 'string' ? body.error : '')
    setError({ field, text })
  }

  const post = (url: string, body: unknown, reason?: string) => (reason ? fetchWithStepUp(url, json('POST', body), reason) : fetch(url, json('POST', body)))

  const checkKey = async () => {
    if (!preset) return
    if (mode?.kind !== 'edit' && !apiKey.trim() && !preset.keyOptional) {
      setError({ field: 'typedKey', text: D.needsKey })
      keyRef.current?.focus()
      return
    }
    setBusy('check')
    setError(null)
    try {
      const res = await post('/api/admin/ai/providers/models', keyShape(false), customStepUp)
      const body = await readJsonObject(res)
      if (!res.ok) return fail(res, body)
      const list = Array.isArray(body.models) ? (body.models as ModelOption[]) : []
      setModels(list)
      setListed(body.listed !== false && list.length > 0)
      if (!model && typeof body.preselect === 'string') setModel(body.preselect)
      else if (!model && list.length === 1) setModel(list[0].id)
    } catch {
      fail(null)
    } finally {
      setBusy(null)
    }
  }

  const runTest = async () => {
    if (!preset) return
    if (!model.trim()) return setError({ field: 'model', text: D.needsModel })
    if (mode?.kind !== 'edit' && !apiKey.trim() && !preset.keyOptional) return setError({ field: 'typedKey', text: D.needsKey })
    setBusy('test')
    setError(null)
    const sig = signature()
    try {
      const res = await post('/api/admin/ai/providers/test', keyShape(true), customStepUp)
      const body = await readJsonObject(res)
      if (!res.ok) return fail(res, body)
      if (body.result && typeof body.result === 'object') setTest({ sig, result: body.result as ProbeView })
      if (mode?.kind === 'edit' && editing) onSaved({ ...editing }, 'edit')
    } catch {
      fail(null)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!mode || !preset) return
    setBusy('save')
    setError(null)
    try {
      let res: Response
      if (mode.kind === 'add') {
        if (!model.trim()) {
          setBusy(null)
          return setError({ field: 'model', text: D.needsModel })
        }
        const q = quirks()
        res = await fetchWithStepUp(
          '/api/admin/ai/providers',
          json('POST', {
            ...target(),
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            label: label.trim() || undefined,
            defaultModel: model.trim(),
            ...(effort ? { effort } : {}),
            ...(q ? { quirks: q } : {}),
            makeDefault,
          }),
          D.stepUp,
        )
      } else if (mode.kind === 'replace') {
        // The key is replaced where it is used, unless the owner typed another address (a moved key is typed again anyway).
        const body: Record<string, unknown> = { id: mode.provider.id, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
        if (isCustom && baseUrl.trim()) Object.assign(body, { baseUrl: baseUrl.trim(), wire })
        else if (isQwen && workspaceId.trim()) Object.assign(body, { workspaceId: workspaceId.trim(), region: region.trim() })
        else if (!isCustom && !isQwen && preset.baseUrls.length > 1 && baseUrl && hostOf(baseUrl) !== mode.provider.baseUrlHost) body.baseUrl = baseUrl
        res = await fetchWithStepUp('/api/admin/ai/providers', json('PATCH', body), D.stepUp)
      } else {
        res = await fetch(
          '/api/admin/ai/providers',
          json('PATCH', {
            id: mode.provider.id,
            label: label.trim() || undefined,
            defaultModel: model.trim() || null,
            effort: effort || null,
            quirks: isClaude ? undefined : { echoReasoning: echo, ...(chatWire && maxField ? { maxTokensField: maxField } : {}), maxOutputTokens: maxOutput.trim() ? Number(maxOutput) : null },
            makeDefault,
          }),
        )
      }
      const body = await readJsonObject(res)
      if (!res.ok) return fail(res, body)
      const saved = body.provider as ProviderView
      toast({ status: 'success', title: mode.kind === 'add' ? MODELS_COPY.toast.added : mode.kind === 'replace' ? MODELS_COPY.toast.keyReplaced : MODELS_COPY.toast.saved, description: saved?.label })
      onSaved(saved, mode.kind)
      onClose()
    } catch {
      fail(null)
    } finally {
      setBusy(null)
    }
  }

  const fieldError = (field: string) => (error && error.field && (error.field === field || error.field.startsWith(`${field}.`)) ? error.text : null)
  const generalError = error && (!error.field || !['typedKey', 'apiKey', 'baseUrl', 'wire', 'workspaceId', 'model', 'label', 'effort', 'quirks'].some((f) => error.field === f || (error.field ?? '').startsWith(`${f}.`))) ? error.text : null
  const testCurrent = test && test.sig === signature() ? test.result : null
  const title = !mode ? '' : mode.kind === 'add' ? D.addTitle : mode.kind === 'edit' ? D.editTitle(mode.provider.label) : D.replaceTitle(mode.provider.label)
  const showKey = mode?.kind !== 'edit'
  const showModel = mode?.kind !== 'replace'
  const ready = !!preset && (!isCustom || !!baseUrl.trim()) && (!isQwen || (!!workspaceId.trim() && !!region.trim()))

  return (
    <Drawer isOpen={!!mode} onClose={onClose} placement={placement} size={placement === 'right' ? 'md' : 'full'}>
      <DrawerOverlay />
      <DrawerContent
        bg="page.bg"
        borderLeft={placement === 'right' ? '1px solid' : undefined}
        borderTop={placement === 'bottom' ? '1px solid' : undefined}
        borderColor="page.border"
        borderTopRadius={placement === 'bottom' ? 'xl' : undefined}
        maxH={placement === 'bottom' ? '92dvh' : undefined}
        aria-label={title}
      >
        <DrawerCloseButton aria-label={D.close} />
        <DrawerHeader pb={2}>
          <Eyebrow accent>{D.eyebrow}</Eyebrow>
          <Text as="span" display="block" fontSize="lg" fontWeight={600} letterSpacing="-0.01em" mt={0.5}>
            {title}
          </Text>
        </DrawerHeader>
        <DrawerBody>
          {/* 1. Provider */}
          {mode?.kind === 'add' && !preset ? (
            <Box>
              <Text fontSize="12px" fontWeight={600} mb={2} id="ai-presets-label">
                {D.provider}
              </Text>
              <Grid as="ul" listStyleType="none" templateColumns={{ base: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' }} gap={2} aria-labelledby="ai-presets-label">
                {data.presets.map((p) => (
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
                      isDisabled={!p.available || (!data.keys.canStore && !p.keyOptional)}
                      onClick={() => setPresetId(p.id)}
                      aria-describedby={!p.available ? 'ai-preset-unavailable' : undefined}
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
              {data.presets.some((p) => !p.available) ? (
                <Text id="ai-preset-unavailable" fontSize="xs" color="page.fg-secondary" mt={3}>
                  {D.unavailable}
                </Text>
              ) : null}
            </Box>
          ) : preset ? (
            <Box display="grid" gap={5}>
              <Flex align="center" justify="space-between" gap={3} border="1px solid" borderColor="page.border" borderRadius="lg" px={3} py={2.5}>
                <Box minW={0}>
                  <Text fontSize="12px" color="page.fg-secondary">
                    {D.provider}
                  </Text>
                  <Text fontSize="sm" fontWeight={600}>
                    {preset.name}
                  </Text>
                  {editing ? (
                    <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary">
                      {editing.baseUrlHost}
                    </Text>
                  ) : null}
                </Box>
                {mode?.kind === 'add' ? (
                  <Button size="xs" {...outlineButtonProps} onClick={() => setPresetId(null)}>
                    {D.change}
                  </Button>
                ) : null}
              </Flex>

              {/* Where content goes (§10.4), and the advice on keys (§7.3). */}
              {mode?.kind !== 'edit' ? (
                <Box borderLeft="2px solid" borderColor="page.border-strong" pl={3} data-data-notice="">
                  <Text fontSize="12px" fontWeight={600}>
                    {D.noteTitle}
                  </Text>
                  <Text fontSize="13px" color="page.fg-secondary" mt={0.5}>
                    {isCustom ? data.copy.customTrust : preset.dataNote ? preset.dataNote.text : D.noteNone(preset.name)}{' '}
                    {preset.dataNote && !isCustom ? (
                      <Link href={preset.dataNote.url} isExternal color="accent.text" textDecoration="underline" textUnderlineOffset="2px">
                        {D.noteSource(preset.dataNote.checked)}
                        <Box as="span" srOnly>
                          {' '}
                          (opens in a new tab)
                        </Box>
                      </Link>
                    ) : null}
                  </Text>
                  <Text fontSize="13px" color="page.fg-secondary" mt={1}>
                    {data.copy.keyAdvice}
                  </Text>
                </Box>
              ) : null}

              {/* Where the key goes. */}
              {mode?.kind !== 'edit' && isCustom ? (
                <>
                  <FormControl isInvalid={!!fieldError('baseUrl')}>
                    <FormLabel htmlFor="ai-base-url" fontSize="12px" fontWeight={600} mb={1.5}>
                      {D.baseUrl}
                    </FormLabel>
                    <Input id="ai-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" fontFamily={MONO} fontSize="13px" autoComplete="off" spellCheck={false} inputMode="url" {...inputProps} />
                    {fieldError('baseUrl') ? <FormErrorMessage>{fieldError('baseUrl')}</FormErrorMessage> : <FormHelperText fontSize="12px">{mode?.kind === 'replace' ? `${D.keepAddress(editing?.baseUrlHost ?? '')} ${D.baseUrlHelp}` : D.baseUrlHelp}</FormHelperText>}
                  </FormControl>
                  <FormControl>
                    <FormLabel htmlFor="ai-wire" fontSize="12px" fontWeight={600} mb={1.5}>
                      {D.wire}
                    </FormLabel>
                    <Select id="ai-wire" value={wire} onChange={(e) => setWire(e.target.value === 'responses' ? 'responses' : 'chat')} fontSize="13px" {...inputProps}>
                      <option value="chat">{D.wireChat}</option>
                      <option value="responses">{D.wireResponses}</option>
                    </Select>
                  </FormControl>
                </>
              ) : null}
              {mode?.kind !== 'edit' && isQwen ? (
                <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={3}>
                  <FormControl isInvalid={!!fieldError('workspaceId')}>
                    <FormLabel htmlFor="ai-qwen-ws" fontSize="12px" fontWeight={600} mb={1.5}>
                      {D.workspace}
                    </FormLabel>
                    <Input id="ai-qwen-ws" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} fontFamily={MONO} fontSize="13px" autoComplete="off" spellCheck={false} {...inputProps} />
                  </FormControl>
                  <FormControl>
                    <FormLabel htmlFor="ai-qwen-region" fontSize="12px" fontWeight={600} mb={1.5}>
                      {D.region}
                    </FormLabel>
                    <Input id="ai-qwen-region" value={region} onChange={(e) => setRegion(e.target.value)} fontFamily={MONO} fontSize="13px" autoComplete="off" spellCheck={false} {...inputProps} />
                  </FormControl>
                  <Text gridColumn="1 / -1" fontSize="12px" color={fieldError('workspaceId') ? 'status.error' : 'page.fg-secondary'}>
                    {fieldError('workspaceId') ?? D.qwenHelp}
                  </Text>
                </Grid>
              ) : null}
              {mode?.kind !== 'edit' && !isCustom && !isQwen && preset.baseUrls.length > 1 ? (
                <FormControl>
                  <FormLabel htmlFor="ai-host" fontSize="12px" fontWeight={600} mb={1.5}>
                    {D.host}
                  </FormLabel>
                  <Select id="ai-host" value={baseUrl || preset.baseUrls[0]} onChange={(e) => setBaseUrl(e.target.value)} fontFamily={MONO} fontSize="13px" {...inputProps}>
                    {preset.baseUrls.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </Select>
                </FormControl>
              ) : null}

              {/* 2. Key */}
              {showKey ? (
                <FormControl isInvalid={!!fieldError('typedKey') || !!fieldError('apiKey')}>
                  <FormLabel htmlFor="ai-api-key" fontSize="12px" fontWeight={600} mb={1.5}>
                    {preset.keyOptional ? D.keyOptional : D.key}
                  </FormLabel>
                  <Flex gap={2} flexDirection={{ base: 'column', sm: 'row' }}>
                    <Input
                      id="ai-api-key"
                      ref={keyRef}
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      fontFamily={MONO}
                      fontSize="13px"
                      data-lpignore="true"
                      data-1p-ignore=""
                      {...inputProps}
                    />
                    {mode?.kind === 'add' ? (
                      <Button size="md" {...outlineButtonProps} onClick={() => void checkKey()} isLoading={busy === 'check'} loadingText={D.checking} isDisabled={!ready || busy !== null} flexShrink={0} minH="40px">
                        {D.checkKey}
                      </Button>
                    ) : null}
                  </Flex>
                  {fieldError('typedKey') || fieldError('apiKey') ? <FormErrorMessage>{fieldError('typedKey') ?? fieldError('apiKey')}</FormErrorMessage> : <FormHelperText fontSize="12px">{D.keyHelp}</FormHelperText>}
                </FormControl>
              ) : null}

              {/* 3. Model */}
              {showModel ? (
                <>
                  <FormControl isInvalid={!!fieldError('model')}>
                    <Flex align="baseline" justify="space-between" gap={2} mb={1.5}>
                      <FormLabel htmlFor="ai-model" fontSize="12px" fontWeight={600} mb={0}>
                        {D.model}
                      </FormLabel>
                      {mode?.kind === 'edit' ? (
                        <Button size="xs" variant="link" color="accent.text" onClick={() => void checkKey()} isLoading={busy === 'check'} loadingText={D.checking}>
                          {D.checkKey}
                        </Button>
                      ) : null}
                    </Flex>
                    <Input id="ai-model" list="ai-model-list" value={model} onChange={(e) => setModel(e.target.value.trim())} fontFamily={MONO} fontSize="13px" autoComplete="off" spellCheck={false} {...inputProps} />
                    <datalist id="ai-model-list">
                      {(models ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label && m.label !== m.id ? m.label : undefined}
                        </option>
                      ))}
                    </datalist>
                    {fieldError('model') ? (
                      <FormErrorMessage>{fieldError('model')}</FormErrorMessage>
                    ) : (
                      <FormHelperText fontSize="12px" role={models ? 'status' : undefined}>
                        {models ? (listed ? `${D.listed(models.length)} ${D.modelHelp}` : D.notListed) : D.modelHelp}
                      </FormHelperText>
                    )}
                  </FormControl>
                  <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={3}>
                    <FormControl>
                      <FormLabel htmlFor="ai-effort" fontSize="12px" fontWeight={600} mb={1.5}>
                        {D.effort}
                      </FormLabel>
                      <Select id="ai-effort" value={effort} onChange={(e) => setEffort(e.target.value)} fontSize="13px" {...inputProps}>
                        {!isClaude ? <option value="">{D.effortDefault}</option> : null}
                        {data.efforts.map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </Select>
                      <FormHelperText fontSize="12px">{D.effortHelp}</FormHelperText>
                    </FormControl>
                    <FormControl isInvalid={!!fieldError('label')}>
                      <FormLabel htmlFor="ai-label" fontSize="12px" fontWeight={600} mb={1.5}>
                        {D.label}
                      </FormLabel>
                      <Input id="ai-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} fontSize="13px" autoComplete="off" {...inputProps} />
                      {fieldError('label') ? <FormErrorMessage>{fieldError('label')}</FormErrorMessage> : <FormHelperText fontSize="12px">{D.labelHelp}</FormHelperText>}
                    </FormControl>
                  </Grid>
                  {!isClaude ? (
                    <Box as="details" border="1px solid" borderColor="page.border" borderRadius="lg" px={3} py={2}>
                      <Box as="summary" fontSize="13px" fontWeight={500} cursor="pointer" py={1}>
                        {D.advanced}
                      </Box>
                      <Box display="grid" gap={4} mt={3} mb={1}>
                        <FormControl display="flex" alignItems="flex-start" gap={3}>
                          <Switch id="ai-echo" colorScheme="purple" mt={1} isChecked={echo} onChange={(e) => setEcho(e.target.checked)} aria-describedby="ai-echo-help" />
                          <Box>
                            <FormLabel htmlFor="ai-echo" mb={0.5} fontSize="13px" fontWeight={500}>
                              {D.echo}
                            </FormLabel>
                            <FormHelperText id="ai-echo-help" mt={0} fontSize="12px">
                              {D.echoHelp}
                            </FormHelperText>
                          </Box>
                        </FormControl>
                        {chatWire ? (
                          <FormControl>
                            <FormLabel htmlFor="ai-max-field" fontSize="12px" fontWeight={600} mb={1.5}>
                              {D.maxField}
                            </FormLabel>
                            <Select id="ai-max-field" value={maxField} onChange={(e) => setMaxField(e.target.value as typeof maxField)} fontFamily={MONO} fontSize="13px" {...inputProps}>
                              <option value="">{D.effortDefault}</option>
                              <option value="max_tokens">max_tokens</option>
                              <option value="max_completion_tokens">max_completion_tokens</option>
                            </Select>
                          </FormControl>
                        ) : null}
                        <FormControl isInvalid={!!fieldError('quirks')}>
                          <FormLabel htmlFor="ai-max-output" fontSize="12px" fontWeight={600} mb={1.5}>
                            {D.maxOutput}
                          </FormLabel>
                          <Input id="ai-max-output" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" fontFamily={MONO} fontSize="13px" autoComplete="off" {...inputProps} />
                          {fieldError('quirks') ? <FormErrorMessage>{fieldError('quirks')}</FormErrorMessage> : <FormHelperText fontSize="12px">{D.maxOutputHelp(data.outputTokens.min, data.outputTokens.max)}</FormHelperText>}
                        </FormControl>
                      </Box>
                    </Box>
                  ) : null}
                  {data.providers.length > (mode?.kind === 'add' ? 0 : 1) ? (
                    <Checkbox isChecked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} colorScheme="purple">
                      <Text as="span" fontSize="13px">
                        {D.makeDefault}
                      </Text>
                    </Checkbox>
                  ) : null}
                </>
              ) : null}

              {/* 4. Test */}
              {showModel ? (
                <Box borderTop="1px solid" borderColor="page.border" pt={4}>
                  <Flex align="center" justify="space-between" gap={3} flexWrap="wrap">
                    <Text fontSize="12px" fontWeight={600}>
                      {D.test}
                    </Text>
                    <Button size="sm" {...outlineButtonProps} onClick={() => void runTest()} isLoading={busy === 'test'} loadingText={D.testing} isDisabled={!ready || !model.trim() || busy !== null} minH={{ base: '44px', md: '32px' }} data-testid="model-test">
                      {D.test}
                    </Button>
                  </Flex>
                  <Text fontSize="12px" color="page.fg-secondary" mt={1}>
                    {D.testHint}
                  </Text>
                  {testCurrent ? (
                    <Box mt={3}>
                      <ProbeResult result={testCurrent} now={now} live />
                    </Box>
                  ) : null}
                </Box>
              ) : null}

              {generalError ? (
                <Text role="alert" fontSize="sm" color="status.error" whiteSpace="pre-wrap" wordBreak="break-word">
                  {generalError}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </DrawerBody>
        <DrawerFooter gap={2} borderTop="1px solid" borderColor="page.border" pb="calc(16px + env(safe-area-inset-bottom, 0px))" flexDirection={{ base: 'column-reverse', sm: 'row' }}>
          {mode?.kind === 'add' && preset && !testCurrent ? (
            <Text fontSize="12px" color="page.fg-secondary" mr="auto" alignSelf={{ base: 'stretch', sm: 'center' }}>
              {D.untestedSave}
            </Text>
          ) : null}
          <Button size="sm" {...outlineButtonProps} onClick={onClose} w={{ base: '100%', sm: 'auto' }} minH={{ base: '44px', sm: '32px' }}>
            {D.cancel}
          </Button>
          <Button
            size="sm"
            {...primaryButtonProps}
            onClick={() => void save()}
            isLoading={busy === 'save'}
            loadingText={D.saving}
            isDisabled={!preset || busy !== null || (mode?.kind === 'replace' && !apiKey.trim() && !preset.keyOptional) || (mode?.kind === 'add' && (!ready || !model.trim()))}
            w={{ base: '100%', sm: 'auto' }}
            minH={{ base: '44px', sm: '32px' }}
            data-testid="model-save"
          >
            {D.save}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
