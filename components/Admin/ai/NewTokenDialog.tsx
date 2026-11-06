import { useEffect, useId, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormErrorMessage,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  Stack,
  Text,
} from '@chakra-ui/react'
import { MONO, inputProps, outlineButtonProps, primaryButtonProps } from '../shell/ui'
import { readJsonObject } from '../shell/http'
import { NETWORK_ERROR } from '../shell/authMessages'
import { wasStepUpCancelled } from '../security/stepUpClient'
import { AI_COPY, levelSummary } from './copy'
import CopyField from './CopyField'
import FirstCallStatus from './FirstCallStatus'
import { bearerHeader, claudeCodeCommand, serverName } from './format'
import type { AccessLevel, AppView, CatalogueTool } from './types'

/** How recent the owner's verification must be (the route's requireFreshAuth, design §5.2). */
export const TOKEN_FRESH_MS = 120_000
const NAME_MAX = 48

type FetchWithStepUp = (input: string, init?: RequestInit, reason?: string, opts?: { freshWithinMs?: number }) => Promise<Response>

/**
 * New personal token (design §5.4, PRODUCT §7.1): a name, an access level
 * (each worded from the live catalogue), a lifetime of 7, 30, 90 or 365 days
 * — no "never". Creating asks for a verification within 2 minutes; then the
 * same dialog shows the token once, with the Claude Code command and the
 * header any other app sends, both carrying the real token, and waits for
 * the app's first call. Closing forgets the token: only its fingerprint is
 * stored on the server. So, like the recovery codes (RecoveryCodesDialog),
 * the one-time view closes — Done, Escape — only once the owner says the
 * token is saved, and never by a click outside it.
 */
export default function NewTokenDialog({
  isOpen,
  onClose,
  tools,
  levels,
  lifetimes,
  defaultDays,
  server,
  fetchWithStepUp,
  onCreated,
  liveApp,
  now,
}: {
  isOpen: boolean
  onClose: () => void
  tools: CatalogueTool[]
  levels: AccessLevel[]
  lifetimes: number[]
  defaultDays: number
  server: string
  fetchWithStepUp: FetchWithStepUp
  onCreated: (app: AppView) => void
  /** The created app as the page's last poll saw it (its first call). */
  liveApp: AppView | null
  now: number
}) {
  const id = useId()
  const c = AI_COPY.newToken
  const [name, setName] = useState('')
  const [level, setLevel] = useState(2)
  const [days, setDays] = useState(defaultDays)
  const [nameError, setNameError] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<{ token: string; app: AppView } | null>(null)
  const [saved, setSaved] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const doneHeadingRef = useRef<HTMLHeadingElement>(null)

  // Every opening starts empty; closing forgets the token.
  useEffect(() => {
    if (!isOpen) return
    setName('')
    setLevel(2)
    setDays(defaultDays)
    setNameError('')
    setFormError('')
    setNotice('')
    setCreated(null)
    setSaved(false)
  }, [isOpen, defaultDays])

  useEffect(() => {
    if (created) doneHeadingRef.current?.focus()
  }, [created])

  const close = () => {
    setCreated(null)
    setSaved(false)
    onClose()
  }
  /** The one-time view keeps the only copy of the token: it closes only once the owner says it is saved. */
  const mayClose = !created || saved

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setFormError('')
    setNotice('')
    if (!name.trim()) {
      setNameError(c.nameMissing)
      nameRef.current?.focus()
      return
    }
    setNameError('')
    setSubmitting(true)
    try {
      const res = await fetchWithStepUp(
        '/api/admin/ai/tokens',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), level, days }) },
        c.stepUp,
        { freshWithinMs: TOKEN_FRESH_MS },
      )
      if (wasStepUpCancelled(res)) {
        setNotice(c.cancelled)
        return
      }
      const json = await readJsonObject(res)
      if (res.status === 201 && typeof json.token === 'string' && json.app) {
        setCreated({ token: json.token, app: json.app as AppView })
        onCreated(json.app as AppView)
        return
      }
      if (json.field === 'name') {
        setNameError(typeof json.error === 'string' ? json.error : c.nameMissing)
        nameRef.current?.focus()
        return
      }
      setFormError(`${c.notCreated}. ${typeof json.error === 'string' ? json.error : `HTTP ${res.status}.`}`)
    } catch {
      setFormError(`${c.notCreated}. ${NETWORK_ERROR}`)
    } finally {
      setSubmitting(false)
    }
  }

  const appName = serverName(server)

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => mayClose && close()}
      isCentered
      size="lg"
      closeOnOverlayClick={!created}
      closeOnEsc={mayClose}
      scrollBehavior="inside"
      initialFocusRef={nameRef}
    >
      <ModalOverlay />
      <ModalContent bg="page.bg-elevated" border="1px solid" borderColor="page.border" mx={4}>
        {created ? (
          <>
            <ModalHeader pb={1}>
              <Text as="span" display="block" fontFamily={MONO} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color="accent.text">
                {c.doneEyebrow}
              </Text>
              <Text as="h2" ref={doneHeadingRef} tabIndex={-1} fontSize="lg" fontWeight={600} letterSpacing="-0.02em" _focus={{ outline: 'none' }}>
                {c.doneTitle}
              </Text>
            </ModalHeader>
            <ModalBody>
              <Text fontSize="sm">{c.once}</Text>
              <Box mt={4}>
                <Text fontSize="12px" fontWeight={600} mb={1.5}>
                  {c.tokenLabel}
                </Text>
                <CopyField label={c.tokenLabel} value={created.token} copyLabel={c.copyToken} emphasis />
              </Box>
              <Box mt={4}>
                <Text fontSize="12px" fontWeight={600} mb={1.5}>
                  {c.forClaudeCode}
                </Text>
                <CopyField label={AI_COPY.connect.commandLabel} value={claudeCodeCommand(appName, server, created.token)} copyLabel={c.copyCommand} />
              </Box>
              <Box mt={4}>
                <Text fontSize="12px" fontWeight={600} mb={1.5}>
                  {c.forOther}
                </Text>
                <Text fontSize="xs" color="page.fg-secondary" mb={1.5}>
                  {c.otherHow(server)}
                </Text>
                <CopyField label={c.headerLabel} value={bearerHeader(created.token)} />
              </Box>
              <Box mt={5}>
                <FirstCallStatus app={liveApp ?? created.app} now={now} />
              </Box>
              <Checkbox mt={5} isChecked={saved} onChange={(e) => setSaved(e.target.checked)} colorScheme="purple">
                <Text as="span" fontSize="sm">
                  {c.saved}
                </Text>
              </Checkbox>
            </ModalBody>
            <ModalFooter>
              <Button {...primaryButtonProps} onClick={close} isDisabled={!saved}>
                {c.done}
              </Button>
            </ModalFooter>
          </>
        ) : (
          // The form is the dialog's flex column (header, body, footer), so the
          // body scrolls on a short screen and Cancel / Create token stay inside
          // the dialog; a plain block <form> would let them hang below it.
          <Box as="form" onSubmit={submit} noValidate display="flex" flexDirection="column" flex="1 1 auto" minH={0}>
            <ModalHeader pb={1}>
              <Text as="span" display="block" fontFamily={MONO} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color="accent.text">
                {c.eyebrow}
              </Text>
              <Text as="span" fontSize="lg" fontWeight={600} letterSpacing="-0.02em">
                {c.title}
              </Text>
            </ModalHeader>
            <ModalCloseButton />
            <ModalBody>
              <FormControl isInvalid={!!nameError} isRequired>
                <FormLabel htmlFor={`${id}-name`} fontSize="12px">
                  {c.name}
                </FormLabel>
                <Input
                  id={`${id}-name`}
                  ref={nameRef}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (e.target.value.trim()) setNameError('')
                  }}
                  maxLength={NAME_MAX}
                  autoComplete="off"
                  {...inputProps}
                />
                {nameError ? <FormErrorMessage>{nameError}</FormErrorMessage> : <FormHelperText fontSize="xs">{c.nameHelp}</FormHelperText>}
              </FormControl>

              <Box as="fieldset" mt={5} mx={0} mb={0} border="none" p={0} minW={0}>
                <Text as="legend" fontSize="12px" fontWeight={500} mb={2}>
                  {c.access}
                </Text>
                <Stack spacing={2}>
                  {levels.map((l) => {
                    const s = levelSummary(l.level, tools)
                    const checked = level === l.level
                    return (
                      <Box
                        as="label"
                        key={l.level}
                        display="flex"
                        alignItems="flex-start"
                        gap={3}
                        px={3}
                        py={2.5}
                        border="1px solid"
                        borderColor={checked ? 'accent.500' : 'page.border-strong'}
                        bg={checked ? 'var(--accent-soft)' : 'page.bg'}
                        borderRadius="md"
                        cursor="pointer"
                        transition="border-color 150ms var(--ease-out-quart), background-color 150ms var(--ease-out-quart)"
                        sx={{ '&:has(input:focus-visible)': { outline: '2px solid var(--chakra-colors-accent-500)', outlineOffset: '2px' } }}
                      >
                        <Box
                          as="input"
                          type="radio"
                          name={`${id}-level`}
                          value={String(l.level)}
                          checked={checked}
                          onChange={() => setLevel(l.level)}
                          mt="3px"
                          flexShrink={0}
                          sx={{ accentColor: 'var(--chakra-colors-accent-500)', width: '16px', height: '16px', '&:focus-visible': { outline: 'none' } }}
                        />
                        <Box minW={0}>
                          <Flex align="baseline" gap={2} flexWrap="wrap">
                            <Text as="span" fontSize="sm" fontWeight={600}>
                              {s.name}
                            </Text>
                            <Text as="span" fontFamily={MONO} fontSize="11px" color="page.fg-secondary" className="tnum">
                              {AI_COPY.catalogue.tools(s.count)}
                            </Text>
                          </Flex>
                          <Text fontSize="xs" color="page.fg-secondary" mt={0.5}>
                            {s.text}
                          </Text>
                        </Box>
                      </Box>
                    )
                  })}
                </Stack>
              </Box>

              <FormControl mt={5}>
                <FormLabel htmlFor={`${id}-days`} fontSize="12px">
                  {c.expires}
                </FormLabel>
                <Select id={`${id}-days`} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} maxW="240px" {...inputProps}>
                  {lifetimes.map((d) => (
                    <option key={d} value={String(d)}>
                      {`${c.days(d)}${d === defaultDays ? c.defaultMark : ''}`}
                    </option>
                  ))}
                </Select>
                <FormHelperText fontSize="xs">{c.expiresHelp}</FormHelperText>
              </FormControl>

              {formError ? (
                <Text role="alert" mt={4} fontSize="sm" color="status.error">
                  {formError}
                </Text>
              ) : null}
              <Box role="status" aria-live="polite" mt={formError ? 1 : 4}>
                {notice ? (
                  <Text fontSize="12px" color="page.fg-secondary">
                    {notice}
                  </Text>
                ) : null}
              </Box>
            </ModalBody>
            <ModalFooter gap={2}>
              <Button size="sm" {...outlineButtonProps} onClick={close}>
                {c.cancel}
              </Button>
              <Button size="sm" type="submit" {...primaryButtonProps} isLoading={submitting} loadingText={c.creating}>
                {c.create}
              </Button>
            </ModalFooter>
          </Box>
        )}
      </ModalContent>
    </Modal>
  )
}
